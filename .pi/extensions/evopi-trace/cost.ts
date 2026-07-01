// cost.ts — 模块 2：Context Cost Harness（上下文成本机制）。
// 契约：docs/evopi-v1/02-上下文成本机制.md（挂点见二节、事件 schema 见决策 4、口径见处理流程）。
//
// 本模块铁律（就近约定）：
//   1. **事件词表冻结**：cost.request / cost.cache / cost.pressure 三事件的字段以决策 4 表为准。
//      加字段向后兼容；改名/删字段要记进度表变更日志。下游 SQLite / V2 自动化依赖它不变。
//   2. **Anchor-only（决策 5）**：cost.* 只写 JSONL，绝不写 session anchor —— 逐轮成本观测不是关键语义锁点。
//      → 所有 record() 调用都**不传 {anchor:true}**。
//   3. **不打架（决策 1）**：只观测缓存 + 看/建议 retention 档位，**不主动注入 cache_control**（Pi 已占 3/4 断点）。
//   4. **只提示不动上下文（决策 3）**：压力跨 80/90/95% 只 notify + 记 cost.pressure，**不自动 compact、不自动切 retention**。
//   5. **V1 只 in-memory + JSONL（决策 6）**：不建独立 SQLite；/evopi-cost 读内存累加器即时展示。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type JsonRecord,
	type Recorder,
	getTraceFile,
	summarizeProviderPayload,
} from "./trace";

// --- provider usage 形状（来自 pi/packages/ai/src/types.ts 的 Usage，已算好 cost 美元） ---
interface ProviderUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	totalTokens?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

// --- 压力档位（决策 3：80 warning / 90 high / 95 critical） ---
type PressureLevel = "warning" | "high" | "critical";
const PRESSURE_THRESHOLDS: Array<{ level: PressureLevel; percent: number }> = [
	{ level: "warning", percent: 80 },
	{ level: "high", percent: 90 },
	{ level: "critical", percent: 95 },
];

/** in-memory 累加器：/evopi-cost 即时读，不落 SQLite（决策 6）。 */
interface CostState {
	providerRequests: number;
	providerResponses: number;
	lastProviderStatus?: number;
	lastPayloadSummary?: JsonRecord;
	// 本会话累计 token（真实 usage）
	totalTokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cacheWrite1h: number;
	};
	// 本会话累计成本（美元，来自 provider 已算好的 cost）
	totalCost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cacheEvents: number; // 已成功读到 usage 的次数（算平均命中率的分母之一）
	cacheHitRateSum: number; // 各轮命中率之和（/ cacheEvents = 平均命中率）
	lastCacheHitRate?: number;
	lastUsage?: ProviderUsage;
	// 累加去重：上次已计入的 assistant entry id。防「本轮响应无新 assistant（错误/中断）时
	// 回溯到上一轮 assistant 被重复累加 + 重复记 cost.cache」。
	lastCountedEntryId?: string;
	// 压力告警去重：已经弹过/记过的最高档位百分比（同档不重复弹）
	pressureFloor: number;
}

function newCostState(): CostState {
	return {
		providerRequests: 0,
		providerResponses: 0,
		totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
		totalCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cacheEvents: 0,
		cacheHitRateSum: 0,
		pressureFloor: 0,
	};
}

/**
 * 读 retention 档位。Pi 由 env PI_CACHE_RETENTION 控制（默认 short=5m，long=1h）。
 * Pi 没有 ctx 级 API 暴露它，故与 Pi 自身解析一致直接读 env（见 anthropic.ts resolveCacheRetention）。
 */
function getRetention(): "none" | "short" | "long" {
	const raw = (process.env.PI_CACHE_RETENTION ?? "").toLowerCase();
	if (raw === "long") return "long";
	if (raw === "none") return "none";
	return "short";
}

/** 缓存命中率口径（决策/处理流程）：cacheRead / (cacheRead + input)。input 为本轮未命中输入 token。 */
function computeCacheHitRate(usage: ProviderUsage): number {
	const denom = usage.cacheRead + usage.input;
	if (denom <= 0) return 0;
	return usage.cacheRead / denom;
}

/**
 * 从 session 取「本轮」真实 usage 及其 entry id。after_provider_response 不含 usage（决策依据/已查证），
 * usage 在最近一条 assistant message 的 .usage。leaf 可能是别的 entry 类型（如 tool result），
 * 故从当前分支末尾往回找最近一条带 usage 的 assistant message。
 * 返回 entry id 供调用方去重（避免本轮无新 assistant 时重复累加上一轮）。
 */
function readLatestAssistantUsage(ctx: ExtensionContext): { usage: ProviderUsage; entryId?: string } | undefined {
	const manager = ctx.sessionManager;
	// 优先直接看 leaf（多数情况下响应刚落地，leaf 就是该 assistant message）。
	const leaf = manager.getLeafEntry();
	const fromLeaf = extractUsage(leaf);
	if (fromLeaf) return { usage: fromLeaf, entryId: entryIdOf(leaf) };

	// 否则回溯分支，取最近一条 assistant usage。
	const branch = typeof manager.getBranch === "function" ? manager.getBranch() : undefined;
	if (!branch) return undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const found = extractUsage(branch[i]);
		if (found) return { usage: found, entryId: entryIdOf(branch[i]) };
	}
	return undefined;
}

function entryIdOf(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const id = (entry as JsonRecord).id;
	return typeof id === "string" ? id : undefined;
}

function extractUsage(entry: unknown): ProviderUsage | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as JsonRecord;
	if (record.type !== "message") return undefined;
	const message = record.message as JsonRecord | undefined;
	if (!message || message.role !== "assistant") return undefined;
	const usage = message.usage as ProviderUsage | undefined;
	if (!usage || typeof usage.input !== "number") return undefined;
	return usage;
}

function fmtUsd(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "$0.0000";
	return `$${n.toFixed(4)}`;
}

function fmtPct(rate: number | undefined): string {
	if (typeof rate !== "number" || !Number.isFinite(rate)) return "n/a";
	return `${(rate * 100).toFixed(1)}%`;
}

/**
 * 注册模块 2（Cost）。自注册 before/after provider 钩子 + /evopi-cost 命令。
 * 复用 index.ts 传入的共享 recorder（统一走 trace.ts 写 JSONL）。
 */
export function registerCost(pi: ExtensionAPI, shared: { recorder: Recorder }): void {
	const { recorder } = shared;
	const state = newCostState();

	// --- 请求侧：记 cost.request + 查上下文压力（决策 4 / 处理流程 1） ---
	pi.on("before_provider_request", (event, ctx) => {
		state.providerRequests += 1;
		const payloadSummary = summarizeProviderPayload(event.payload);
		state.lastPayloadSummary = payloadSummary;

		const usage = ctx.getContextUsage();
		const retention = getRetention();

		const messageCount =
			event.payload && typeof event.payload === "object" && Array.isArray((event.payload as JsonRecord).messages)
				? ((event.payload as JsonRecord).messages as unknown[]).length
				: undefined;
		const toolCount =
			event.payload && typeof event.payload === "object" && Array.isArray((event.payload as JsonRecord).tools)
				? ((event.payload as JsonRecord).tools as unknown[]).length
				: undefined;

		// cost.request（字段冻结：contextEstimate / retention / messageCount / toolCount）
		recorder.record("cost.request", ctx, {
			contextEstimate: usage
				? { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent }
				: null,
			retention,
			messageCount,
			toolCount,
		});

		// 上下文压力告警（决策 3）：首次跨阈值时 notify + 记 cost.pressure，同档不重复。
		checkPressure(ctx, state, recorder);
	});

	// --- 响应侧：读真实 usage → 算命中率 → 记 cost.cache + 累加（处理流程 2） ---
	pi.on("after_provider_response", (event, ctx) => {
		state.providerResponses += 1;
		state.lastProviderStatus = event.status;

		const found = readLatestAssistantUsage(ctx);
		if (!found) {
			// 拿不到 usage（异常/中断/provider 无 usage）——不猜，跳过 cost.cache。
			return;
		}
		const { usage, entryId } = found;

		// 去重：本轮响应若没产生新 assistant（错误/中断），回溯会取到上一轮 assistant。
		// 用 entry id 挡住重复累加 + 重复记 cost.cache。id 缺失时（理论上不该）保守跳过累加。
		if (entryId !== undefined && entryId === state.lastCountedEntryId) {
			return;
		}
		state.lastCountedEntryId = entryId;

		const cacheHitRate = computeCacheHitRate(usage);
		state.lastUsage = usage;
		state.lastCacheHitRate = cacheHitRate;
		state.cacheEvents += 1;
		state.cacheHitRateSum += cacheHitRate;

		// 累加 token
		state.totalTokens.input += usage.input;
		state.totalTokens.output += usage.output;
		state.totalTokens.cacheRead += usage.cacheRead;
		state.totalTokens.cacheWrite += usage.cacheWrite;
		state.totalTokens.cacheWrite1h += usage.cacheWrite1h ?? 0;

		// 累加成本（provider 已算好美元）
		if (usage.cost) {
			state.totalCost.input += usage.cost.input;
			state.totalCost.output += usage.cost.output;
			state.totalCost.cacheRead += usage.cost.cacheRead;
			state.totalCost.cacheWrite += usage.cost.cacheWrite;
			state.totalCost.total += usage.cost.total;
		}

		// cost.cache（字段冻结：usage{...} / cacheHitRate / cost{...}）
		recorder.record("cost.cache", ctx, {
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cacheWrite1h: usage.cacheWrite1h ?? 0,
			},
			cacheHitRate,
			cost: usage.cost
				? {
						input: usage.cost.input,
						output: usage.cost.output,
						cacheRead: usage.cost.cacheRead,
						cacheWrite: usage.cost.cacheWrite,
						total: usage.cost.total,
					}
				: undefined,
		});
	});

	// --- 命令：/evopi-cost（摘要）+ /evopi-cost detail（原始 usage/payload/路径） ---
	pi.registerCommand("evopi-cost", {
		description: "Show EvoPi context and provider cost signals",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "detail") {
				ctx.ui.notify(renderDetail(ctx, state, recorder), "info");
				return;
			}
			ctx.ui.notify(renderSummary(ctx, state), "info");
		},
	});
}

/** 压力告警：首次跨过某阈值时弹一次 + 记一条 cost.pressure，同档不重复（决策 3）。 */
function checkPressure(ctx: ExtensionContext, state: CostState, recorder: Recorder): void {
	const usage = ctx.getContextUsage();
	const percent = usage?.percent;
	if (usage == null || percent == null || !Number.isFinite(percent)) {
		// compaction 后到下次响应前 percent 为 null —— 兜底不告警（决策/缺点 1）。
		return;
	}

	// 找当前跨过的最高档位。
	let crossed: { level: PressureLevel; percent: number } | undefined;
	for (const t of PRESSURE_THRESHOLDS) {
		if (percent >= t.percent) crossed = t;
	}
	if (!crossed) {
		// 回落到所有阈值之下（如 compaction 后）——重置 floor，允许再次告警。
		if (state.pressureFloor !== 0) state.pressureFloor = 0;
		return;
	}

	// 同档或更低不重复弹（去重）。
	if (crossed.percent <= state.pressureFloor) return;
	state.pressureFloor = crossed.percent;

	const tokens = usage.tokens;
	const window = usage.contextWindow;
	ctx.ui.notify(
		`上下文压力 ${crossed.level.toUpperCase()}：已用 ${percent}%（${tokens ?? "?"}/${window}）。` +
			`可考虑压缩上下文或（长会话）切 PI_CACHE_RETENTION=long。EvoPi 不会自动改动上下文。`,
		"warning",
	);

	// cost.pressure（字段冻结：level / percent / tokens / window）
	recorder.record("cost.pressure", ctx, {
		level: crossed.level,
		percent,
		tokens: tokens ?? null,
		window,
	});
}

function renderSummary(ctx: ExtensionContext, state: CostState): string {
	const usage = ctx.getContextUsage();
	const retention = getRetention();

	let contextLine: string;
	let pressureLine: string;
	if (!usage || usage.percent == null) {
		// compaction 后估算不可用（缺点 1）：不崩、标清楚。
		contextLine = "context: 估算不可用（compaction 后待下次响应）";
		pressureLine = "pressure: n/a";
	} else {
		contextLine = `context: ${usage.tokens ?? "?"} / ${usage.contextWindow} (${usage.percent}%)`;
		pressureLine = `pressure: ${pressureBand(usage.percent)}`;
	}

	const avgHit = state.cacheEvents > 0 ? state.cacheHitRateSum / state.cacheEvents : undefined;

	const retentionHint =
		retention === "short"
			? "  提示：长会话可设 PI_CACHE_RETENTION=long 复用 1h 缓存（EvoPi 只建议，不自动切）"
			: "";

	return [
		`model: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`,
		contextLine,
		pressureLine,
		`retention: ${retention}${retentionHint}`,
		"",
		`cacheHitRate: last=${fmtPct(state.lastCacheHitRate)} avg=${fmtPct(avgHit)}`,
		`tokens(session): in=${state.totalTokens.input} out=${state.totalTokens.output} ` +
			`cacheRead=${state.totalTokens.cacheRead} cacheWrite=${state.totalTokens.cacheWrite}`,
		`cost(session): ${fmtUsd(state.totalCost.total)} ` +
			`(in ${fmtUsd(state.totalCost.input)} / out ${fmtUsd(state.totalCost.output)} / ` +
			`cacheRead ${fmtUsd(state.totalCost.cacheRead)} / cacheWrite ${fmtUsd(state.totalCost.cacheWrite)})`,
		`requests: ${state.providerRequests} responses: ${state.providerResponses}`,
		"",
		"Use: /evopi-cost detail  查看原始 usage / payload 摘要 / trace 路径",
	].join("\n");
}

function renderDetail(ctx: ExtensionContext, state: CostState, recorder: Recorder): string {
	const tracePath = recorder.state.traceFile ?? getTraceFile(ctx.cwd, recorder.state.traceId);
	return [
		`traceId: ${recorder.state.traceId}`,
		`traceFile: ${tracePath}`,
		`lastProviderStatus: ${state.lastProviderStatus ?? "none"}`,
		"",
		`lastUsage: ${JSON.stringify(state.lastUsage ?? {})}`,
		`lastCacheHitRate: ${fmtPct(state.lastCacheHitRate)}`,
		"",
		`lastPayloadSummary: ${JSON.stringify(state.lastPayloadSummary ?? {})}`,
	].join("\n");
}

function pressureBand(percent: number): string {
	if (percent >= 95) return `${percent}% (critical)`;
	if (percent >= 90) return `${percent}% (high)`;
	if (percent >= 80) return `${percent}% (warning)`;
	return `${percent}% (ok)`;
}
