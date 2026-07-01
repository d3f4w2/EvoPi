// tools.ts — 模块 5 · 工具运行时（Tool Runtime Harness）。
// 契约：05-工具运行时机制.md（决策 2 错误 7 类、决策 4 预算三维/层级、决策 5 延迟 avg+max、
// 决策 6 单 handler 安全>资源、决策 8 tool.result 加 errorClass/latencyMs + tool.budget 事件）。
//
// 本模块铁律（就近约定）：
//   1. **安全 > 资源**（决策 6）：预算是 tool_call 单 handler 里 policy 之后跑的决策（模块 5 后于 4）。
//      本文件不自注册 tool_call，导出 evaluateBudget 交给 index.ts 单一 handler（policy 放行后再跑）。
//   2. **硬限只卡调用次数**（决策 4）：延迟/错误超阈值只软限告警（judgment 模糊，硬拦易误伤慢工具/自愈重试）。
//   3. **错误 7 类启发式**（决策 2）：从 tool_result.content 文本 + isError 关键词推断，内置规则表 V1 不可配。
//      诚实局限：不可能 100% 准，但比一个 isError 布尔强。
//   4. **延迟自建计时**（决策 5）：tool_call 记 start、tool_result 按 toolCallId 配对算差；只 avg+max+count。
//   5. **事件/anchor**（决策 8）：errorClass/latencyMs 是客观属性→加进 tool.result（Trace 增强，只 JSONL）；
//      预算是治理语义→独立 tool.budget；软限告警只 JSONL，硬限 block 写 session anchor（同 policy.blocked 级）。
//   ⚠️ 决策 3「工具级超时」V1 不实现：Pi 扩展 tool_call 不暴露单工具 AbortController，无包裹内置工具执行的 API。
//      bash 已有原生超时兜底；非 bash 内置工具极少挂起。推 V2（见进度表变更日志）。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type JsonRecord, type Recorder, isoNow } from "./trace";

export type ErrorClass = "timeout" | "auth" | "schema" | "permission" | "rate_limit" | "tool_bug" | "unknown";

// --- 决策结果（与 job.ts 的 PolicyDecision 同形，index.ts 统一处理 block）---
export interface BudgetDecision {
	block: boolean;
	reason?: string;
}

export interface ToolStat {
	calls: number;
	errors: number;
	errorsByClass: Partial<Record<ErrorClass, number>>;
	latency: { count: number; totalMs: number; maxMs: number };
	lastUsedAt?: string;
}

// --- 预算默认值（决策 4：per-turn 单工具 50、per-job 单工具 200、全局 500、软限 80%）---
const DEFAULT_PER_TOOL_TURN = 50;
const DEFAULT_PER_TOOL_JOB = 200;
const DEFAULT_GLOBAL_TURN = 300;
const SOFT_LIMIT_PERCENT = 80;

interface Counters {
	perTool: Map<string, number>;
	global: number;
}

function newCounters(): Counters {
	return { perTool: new Map(), global: 0 };
}

// ---------------------------------------------------------------------------
// 错误分类（内置关键词规则表，决策 2）
// ---------------------------------------------------------------------------

/** 从 tool_result 内容文本抽出可分类的字符串。 */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c && typeof c === "object" && (c as JsonRecord).type === "text")
			.map((c) => String((c as JsonRecord).text ?? ""))
			.join("\n");
	}
	return "";
}

/**
 * 启发式推断错误类别（决策 2）。规则顺序敏感：先具体后兜底。
 * 只在 isError 时调用；正常结果不分类。
 */
export function classifyError(text: string): ErrorClass {
	const t = text.toLowerCase();
	// timeout（含 bash 原生超时 "timeout:N"）
	if (/\btimeout\b|timed out|etimedout|deadline exceeded/.test(t)) return "timeout";
	// rate_limit（放在 auth/permission 前：429 语义明确）
	if (/\b429\b|rate limit|too many requests|quota exceeded/.test(t)) return "rate_limit";
	// auth
	if (/\b401\b|unauthorized|authentication|api key|invalid token|not authenticated/.test(t)) return "auth";
	// permission
	if (/\b403\b|permission denied|eacces|eperm|forbidden|access denied/.test(t)) return "permission";
	// schema / 参数校验
	if (/invalid argument|validation|invalid input|schema|missing required|bad request|\b400\b|expected .* but/.test(t))
		return "schema";
	// tool_bug（异常栈特征）
	if (/traceback|stack trace|unhandled|exception|cannot read propert|is not a function|referenceerror|typeerror/.test(t))
		return "tool_bug";
	return "unknown";
}

// ---------------------------------------------------------------------------
// 模块接口（供 index.ts 单一 tool_call handler 调用）
// ---------------------------------------------------------------------------

export interface ToolsModule {
	/** policy 放行后跑：预算硬限（只卡调用次数）。block=true → index.ts 返回 {block}。 */
	evaluateBudget(event: { toolName: string; toolCallId: string }, ctx: ExtensionContext): BudgetDecision;
	/** 工具放行后：记 start 时间 + 递增预算计数（软限告警在此）。 */
	onToolCall(event: { toolName: string; toolCallId: string }, ctx: ExtensionContext): void;
	/** tool_result：算 latency + 分类 error + 更新 stats + 记 tool.result（带 errorClass/latencyMs）。 */
	onToolResult(
		event: { toolName: string; toolCallId: string; isError: boolean; input?: JsonRecord; content?: unknown; details?: unknown },
		ctx: ExtensionContext,
	): void;
	/** per-turn 预算重置（防单轮死循环）。 */
	resetTurn(): void;
	/** 供 /evopi-tools 展示。 */
	getStats(): Map<string, ToolStat>;
	renderStats(): string;
}

export function createTools(shared: { recorder: Recorder }): ToolsModule {
	const { recorder } = shared;
	const stats = new Map<string, ToolStat>();
	const startTimes = new Map<string, number>(); // toolCallId → ms
	let turnCounters = newCounters();
	const jobCounters = newCounters(); // 近似 per-job：随会话累计（V1 不跨会话）

	function statFor(name: string): ToolStat {
		let s = stats.get(name);
		if (!s) {
			s = { calls: 0, errors: 0, errorsByClass: {}, latency: { count: 0, totalMs: 0, maxMs: 0 } };
			stats.set(name, s);
		}
		return s;
	}

	function perToolTurnLimit(_name: string): number {
		return DEFAULT_PER_TOOL_TURN;
	}
	function perToolJobLimit(_name: string): number {
		return DEFAULT_PER_TOOL_JOB;
	}

	// === 预算硬限（决策 4：只卡调用次数）===
	function evaluateBudget(event: { toolName: string; toolCallId: string }, ctx: ExtensionContext): BudgetDecision {
		const name = event.toolName;
		const turnUsed = turnCounters.perTool.get(name) ?? 0;
		const jobUsed = jobCounters.perTool.get(name) ?? 0;

		// per-turn 单工具硬限
		if (turnUsed >= perToolTurnLimit(name)) {
			recorder.record(
				"tool.budget",
				ctx,
				{ toolName: name, scope: "per-turn", kind: "hard", used: turnUsed, limit: perToolTurnLimit(name) },
				{ anchor: true },
			);
			return { block: true, reason: `EvoPi 预算耗尽：${name} 本轮已调用 ${turnUsed} 次（上限 ${perToolTurnLimit(name)}）。` };
		}
		// per-job 单工具硬限
		if (jobUsed >= perToolJobLimit(name)) {
			recorder.record(
				"tool.budget",
				ctx,
				{ toolName: name, scope: "per-job", kind: "hard", used: jobUsed, limit: perToolJobLimit(name) },
				{ anchor: true },
			);
			return { block: true, reason: `EvoPi 预算耗尽：${name} 本任务已调用 ${jobUsed} 次（上限 ${perToolJobLimit(name)}）。` };
		}
		// 全局总闸硬限
		if (turnCounters.global >= DEFAULT_GLOBAL_TURN) {
			recorder.record(
				"tool.budget",
				ctx,
				{ scope: "global", kind: "hard", used: turnCounters.global, limit: DEFAULT_GLOBAL_TURN },
				{ anchor: true },
			);
			return { block: true, reason: `EvoPi 预算耗尽：本轮工具总调用 ${turnCounters.global} 次（全局上限 ${DEFAULT_GLOBAL_TURN}）。` };
		}
		return { block: false };
	}

	// === 放行后：计时开始 + 递增计数 + 软限告警 ===
	function onToolCall(event: { toolName: string; toolCallId: string }, ctx: ExtensionContext): void {
		const name = event.toolName;
		startTimes.set(event.toolCallId, Date.now());

		const turnUsed = (turnCounters.perTool.get(name) ?? 0) + 1;
		turnCounters.perTool.set(name, turnUsed);
		jobCounters.perTool.set(name, (jobCounters.perTool.get(name) ?? 0) + 1);
		turnCounters.global += 1;
		jobCounters.global += 1;

		// 软限告警（决策 4：80% 阈值，只 JSONL，不 block）——用 per-turn 单工具口径。
		const limit = perToolTurnLimit(name);
		const softAt = Math.floor((limit * SOFT_LIMIT_PERCENT) / 100);
		if (turnUsed === softAt) {
			recorder.record("tool.budget", ctx, {
				toolName: name,
				scope: "per-turn",
				kind: "soft",
				used: turnUsed,
				limit,
				percent: SOFT_LIMIT_PERCENT,
			});
		}
	}

	// === tool_result：latency + errorClass + stats + tool.result ===
	function onToolResult(
		event: { toolName: string; toolCallId: string; isError: boolean; input?: JsonRecord; content?: unknown; details?: unknown },
		ctx: ExtensionContext,
	): void {
		const name = event.toolName;
		const s = statFor(name);
		s.calls += 1;
		s.lastUsedAt = isoNow();

		// 延迟（决策 5）
		let latencyMs: number | undefined;
		const start = startTimes.get(event.toolCallId);
		if (start !== undefined) {
			latencyMs = Date.now() - start;
			startTimes.delete(event.toolCallId);
			s.latency.count += 1;
			s.latency.totalMs += latencyMs;
			if (latencyMs > s.latency.maxMs) s.latency.maxMs = latencyMs;
		}

		// 错误分类（决策 2）
		let errorClass: ErrorClass | undefined;
		if (event.isError) {
			s.errors += 1;
			errorClass = classifyError(resultText(event.content));
			s.errorsByClass[errorClass] = (s.errorsByClass[errorClass] ?? 0) + 1;
		}

		// tool.result 加客观属性 errorClass/latencyMs（决策 8：Trace 增强，只 JSONL）
		recorder.record("tool.result", ctx, {
			toolCallId: event.toolCallId,
			toolName: name,
			isError: event.isError,
			errorClass,
			latencyMs,
			inputKeys: Object.keys(event.input ?? {}).slice(0, 30),
			content: summarizeResultContent(event.content),
		});
	}

	function resetTurn(): void {
		turnCounters = newCounters();
	}

	function renderStats(): string {
		if (stats.size === 0) return "No tool calls recorded yet.";
		const lines = Array.from(stats.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, s]) => {
				const avg = s.latency.count > 0 ? Math.round(s.latency.totalMs / s.latency.count) : 0;
				const errClasses = Object.entries(s.errorsByClass)
					.map(([k, v]) => `${k}:${v}`)
					.join(",");
				const errPart = s.errors > 0 ? ` ${s.errors} 错(${errClasses})` : "";
				const latPart = s.latency.count > 0 ? ` 均 ${avg}ms/最慢 ${s.latency.maxMs}ms` : "";
				const turnUsed = turnCounters.perTool.get(name) ?? 0;
				return `${name}: ${s.calls} 次${errPart}${latPart} [本轮 ${turnUsed}/${perToolTurnLimit(name)}]`;
			});
		return [`工具运行时统计（本轮全局 ${turnCounters.global}/${DEFAULT_GLOBAL_TURN}）:`, ...lines].join("\n");
	}

	return { evaluateBudget, onToolCall, onToolResult, resetTurn, getStats: () => stats, renderStats };
}

/** tool.result 内容摘要（不整体进上下文）。 */
function summarizeResultContent(content: unknown): JsonRecord {
	if (!Array.isArray(content)) return { kind: typeof content };
	let textItems = 0;
	let totalTextLength = 0;
	for (const item of content) {
		if (item && typeof item === "object" && (item as JsonRecord).type === "text") {
			textItems++;
			totalTextLength += String((item as JsonRecord).text ?? "").length;
		}
	}
	return { items: content.length, textItems, totalTextLength };
}

// 供测试复用。
export { newCounters, resultText };
