// job.ts — 模块 4 · 执行治理（Execution Harness）。
// 契约：04-执行治理机制.md（决策 1 主动拦截、决策 3 风险三级、决策 5 审批+fail-safe、
// 决策 6 checkpoint/rewind、决策 7 证据验收、决策 8 job.*/policy.* 事件与 anchor）。
//
// 本模块铁律（就近约定）：
//   1. **安全 > 资源**：Policy Gate 是 tool_call 单 handler 里**最先**跑的决策（模块 4 先于模块 5）。
//      本文件不自注册 tool_call，而是导出 evaluateToolCall(event,ctx) 交给 index.ts 的单一 handler（避免多 handler 顺序陷阱）。
//   2. **总是拦高危**（决策 3）：high 无论 isProjectTrusted() 都 block+审批；判定=工具类型 + 内容扫共享 policy（决策 4，用 policy.ts，不各造黑名单）。
//   3. **无 UI = fail-safe**（决策 5）：hasUI=false 弹不出审批→一律 block。审批「记住」只对**具体命令指纹**生效，最危险的每次都问。
//   4. **checkpoint 仅危险写前打**（决策 6）：setLabel 打标 + 存 job；rewind V1 只手动（navigateTree），自动留 V2。
//   5. **验收=证据面板人拍板**（决策 7）：切 passed 时若有 error/高危未解决则警告，不自动裁决（留 V2）。
//   6. **事件/anchor**（决策 8）：policy.blocked/approved/denied + checkpoint/rewind + job.start/终态 写 session anchor；
//      policy.check 只进 JSONL 且**只记 medium/high**（low 只读无治理价值不刷 trace）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type JsonRecord, type Recorder, isoNow } from "./trace";
import { type PolicyConfig, loadPolicy, matchDangerousCommand, matchProtectedPath } from "./policy";

export type RiskLevel = "low" | "medium" | "high";

export interface JobCheckpoint {
	entryId: string;
	label: string;
	at: string;
	reason: string;
}

export interface JobState {
	id: string;
	title: string;
	status: "queued" | "running" | "waitingApproval" | "failed" | "passed" | "blocked";
	createdAt: string;
	updatedAt: string;
	plan?: string;
	acceptance?: string;
	toolCalls: number;
	toolErrors: number;
	traceId: string;
	// 模块 4 补充字段（向后兼容加字段）
	checkpoints: JobCheckpoint[];
	lastEntryId?: string; // turn_end 记录，供 rewind
	highRiskBlocked: number; // 被 Policy Gate 拦下的高危次数
	testsPassed?: boolean; // 证据：识别到的测试命令是否通过
	testsRan: boolean; // 是否识别到测试命令
}

/** tool_call 决策结果：block=true 时 index.ts 返回 {block,reason} 给 Pi。 */
export interface PolicyDecision {
	block: boolean;
	reason?: string;
}

// ---------------------------------------------------------------------------
// 风险判定（工具类型 + 内容扫共享 policy）
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

/** 从 tool 输入取命令行（bash）或路径（write/edit）。 */
function extractCommand(toolName: string, input: JsonRecord): string | undefined {
	if (toolName === "bash") {
		return typeof input.command === "string" ? input.command : undefined;
	}
	return undefined;
}

function extractPath(toolName: string, input: JsonRecord): string | undefined {
	if (WRITE_TOOLS.has(toolName)) {
		const p = input.path ?? input.file_path;
		return typeof p === "string" ? p : undefined;
	}
	return undefined;
}

/** 只读 bash 命令启发式（git status/log、ls/cat 等）——用于把只读 bash 归 low。 */
const READONLY_BASH = /^\s*(ls|cat|pwd|echo|git\s+(status|log|diff|show|branch)|grep|rg|find|head|tail|wc|which|whoami|date)\b/;

export interface RiskJudgment {
	level: RiskLevel;
	reason: string;
	dangerPattern?: string;
}

/**
 * 判定一次 tool_call 的风险级别（决策 3）。
 * high：bash 命中危险黑名单，或 write/edit 命中受保护路径。
 * medium：write/edit，或非只读 bash。
 * low：只读工具，或只读 bash。
 */
export function classifyRisk(toolName: string, input: JsonRecord, policy: PolicyConfig): RiskJudgment {
	// 只读工具直接 low。
	if (READ_ONLY_TOOLS.has(toolName)) {
		return { level: "low", reason: `read-only tool ${toolName}` };
	}

	// bash：先看危险黑名单（high），否则按只读/写区分。
	if (toolName === "bash") {
		const command = extractCommand("bash", input) ?? "";
		const danger = matchDangerousCommand(command, policy);
		if (danger) {
			return { level: "high", reason: `dangerous command: ${danger}`, dangerPattern: danger };
		}
		if (READONLY_BASH.test(command)) {
			return { level: "low", reason: "read-only bash" };
		}
		return { level: "medium", reason: "mutating bash" };
	}

	// write/edit：先看受保护路径（high），否则 medium。
	if (WRITE_TOOLS.has(toolName)) {
		const path = extractPath(toolName, input) ?? "";
		const protectedHit = matchProtectedPath(path, policy);
		if (protectedHit) {
			return { level: "high", reason: `protected path write: ${protectedHit}`, dangerPattern: protectedHit };
		}
		return { level: "medium", reason: `${toolName} file` };
	}

	// 其它/自定义工具：保守归 medium（可见但记 trace），不臆断为 low。
	return { level: "medium", reason: `tool ${toolName}` };
}

/** 高危命令指纹（用于「本会话记住这个命令」——只对具体指纹生效，收紧作用域，决策 5）。 */
function commandFingerprint(toolName: string, input: JsonRecord): string {
	const cmd = extractCommand(toolName, input);
	if (cmd) return `bash:${cmd.trim()}`;
	const path = extractPath(toolName, input);
	if (path) return `${toolName}:${path}`;
	return `${toolName}`;
}

// ---------------------------------------------------------------------------
// 测试命令识别（证据验收，决策 7）
// ---------------------------------------------------------------------------

function isTestCommand(command: string, policy: PolicyConfig): boolean {
	const lower = command.toLowerCase();
	return policy.testCommandPatterns.some((p) => lower.includes(p.toLowerCase()));
}

// ---------------------------------------------------------------------------
// 注册（返回 evaluateToolCall 供 index.ts 单一 tool_call handler 调用）
// ---------------------------------------------------------------------------

export interface JobModule {
	/** 供 index.ts 的单一 tool_call handler 调用：安全准入决策（模块 4，先于模块 5 资源）。 */
	evaluateToolCall(event: { toolName: string; toolCallId: string; input: JsonRecord }, ctx: ExtensionContext): Promise<PolicyDecision>;
	/** 供 index.ts tool_call 观测部分调用：把工具调用计入当前 job。 */
	onToolCall(): void;
}

export function registerJob(pi: ExtensionAPI, shared: { recorder: Recorder }): JobModule {
	const { recorder } = shared;
	let currentJob: JobState | undefined;
	// 「本会话记住批准」的命令指纹集合（决策 5：只对具体指纹生效）。
	const rememberedApprovals = new Set<string>();

	function persistJob() {
		if (currentJob) pi.appendEntry<JobState>("evopi.job", currentJob);
	}

	function newJob(title: string, traceId: string): JobState {
		return {
			id: `job_${Date.now().toString(36)}`,
			title,
			status: "running",
			createdAt: isoNow(),
			updatedAt: isoNow(),
			toolCalls: 0,
			toolErrors: 0,
			traceId,
			checkpoints: [],
			highRiskBlocked: 0,
			testsRan: false,
		};
	}

	function addCheckpoint(ctx: ExtensionContext, reason: string): JobCheckpoint | undefined {
		const entryId = currentJob?.lastEntryId ?? ctx.sessionManager.getLeafEntry()?.id;
		if (!entryId) return undefined;
		const label = `checkpoint-${reason}-${isoNow()}`;
		try {
			ctx.setLabel(entryId, label);
		} catch {
			// setLabel 失败不致命——仍记 checkpoint 列表（rewind 用 entryId）。
		}
		const cp: JobCheckpoint = { entryId, label, at: isoNow(), reason };
		if (currentJob) {
			currentJob.checkpoints.push(cp);
			currentJob.updatedAt = isoNow();
			persistJob();
		}
		return cp;
	}

	// === Policy Gate 决策（安全准入）===
	async function evaluateToolCall(
		event: { toolName: string; toolCallId: string; input: JsonRecord },
		ctx: ExtensionContext,
	): Promise<PolicyDecision> {
		const policy = loadPolicy(ctx.cwd);
		const judgment = classifyRisk(event.toolName, event.input ?? {}, policy);

		if (judgment.level === "low") {
			// 只读：放行，不记 policy.check（决策 8：low 不刷 trace）。
			return { block: false };
		}

		if (judgment.level === "medium") {
			// 写操作：危险写前打 checkpoint（决策 6）+ 放行 + 记 policy.check（JSONL）。
			addCheckpoint(ctx, `before-${event.toolName}`);
			recorder.record("policy.check", ctx, {
				toolName: event.toolName,
				level: "medium",
				reason: judgment.reason,
			});
			return { block: false };
		}

		// high：checkpoint → 审批（决策 5/6）。
		addCheckpoint(ctx, `before-high-${event.toolName}`);
		recorder.record("policy.check", ctx, {
			toolName: event.toolName,
			level: "high",
			reason: judgment.reason,
			dangerPattern: judgment.dangerPattern,
		});

		const fingerprint = commandFingerprint(event.toolName, event.input ?? {});

		// 「本会话记住」命中 → 直接放行（但仅限具体指纹；blocked 级不在此列，见下）。
		if (rememberedApprovals.has(fingerprint)) {
			recorder.record("policy.approved", ctx, { toolName: event.toolName, reason: "remembered", fingerprint }, { anchor: true });
			return { block: false };
		}

		// 无 UI = fail-safe：一律 block（决策 5）。
		if (!ctx.hasUI) {
			if (currentJob) {
				currentJob.highRiskBlocked += 1;
				currentJob.status = "waitingApproval";
				currentJob.updatedAt = isoNow();
				persistJob();
			}
			const reason = `EvoPi Policy 拦截高危操作（${judgment.reason}）：无 UI 无法审批，已 block（fail-safe）。`;
			recorder.record("policy.blocked", ctx, { toolName: event.toolName, reason: judgment.reason, mode: "no-ui" }, { anchor: true });
			return { block: true, reason };
		}

		// 有 UI：弹审批。
		let approved = false;
		try {
			approved = await ctx.ui.confirm(
				"EvoPi 拦截高危操作",
				`${judgment.reason}\n工具: ${event.toolName}\n是否放行？（拒绝将作为错误结果返回给模型）`,
			);
		} catch {
			// confirm 异常→保守 block。
			approved = false;
		}

		if (approved) {
			if (currentJob) {
				currentJob.updatedAt = isoNow();
				persistJob();
			}
			// 记住选择：仅当不是「最危险」级（这里用 dangerPattern 命中危险命令视为最危险，不允许记住；受保护路径写可记住）。
			const isMostDangerous = !!judgment.dangerPattern && event.toolName === "bash";
			if (!isMostDangerous) rememberedApprovals.add(fingerprint);
			recorder.record("policy.approved", ctx, { toolName: event.toolName, reason: judgment.reason, remembered: !isMostDangerous }, { anchor: true });
			return { block: false };
		}

		if (currentJob) {
			currentJob.highRiskBlocked += 1;
			currentJob.updatedAt = isoNow();
			persistJob();
		}
		recorder.record("policy.denied", ctx, { toolName: event.toolName, reason: judgment.reason }, { anchor: true });
		return { block: true, reason: `EvoPi Policy 已拦截：${judgment.reason}（用户拒绝放行）。` };
	}

	function onToolCall() {
		if (currentJob) {
			currentJob.toolCalls += 1;
			currentJob.updatedAt = isoNow();
			persistJob();
		}
	}

	// === turn_end：记录 entryId 供 rewind（决策 2/6）===
	pi.on("turn_end", (_event, ctx) => {
		const entryId = ctx.sessionManager.getLeafEntry()?.id;
		if (currentJob && entryId) {
			currentJob.lastEntryId = entryId;
		}
	});

	// === tool_result：证据采集（error 计数 + 测试识别，决策 7）===
	pi.on("tool_result", (event, ctx) => {
		if (!currentJob) return;
		if (event.isError) {
			currentJob.toolErrors += 1;
		}
		// 测试证据：这次 tool_result 对应的 bash 命令是否是测试命令。
		const input = (event.input ?? {}) as JsonRecord;
		const command = typeof input.command === "string" ? input.command : "";
		if (command) {
			const policy = loadPolicy(ctx.cwd);
			if (isTestCommand(command, policy)) {
				currentJob.testsRan = true;
				currentJob.testsPassed = !event.isError;
			}
		}
		currentJob.updatedAt = isoNow();
		persistJob();
	});

	// === 命令 ===
	pi.registerCommand("evopi-job", {
		description: "Manage EvoPi governed job (Policy Gate / checkpoint / rewind / 证据验收)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed.startsWith("start ")) {
				const title = trimmed.slice(6).trim();
				if (!title) {
					ctx.ui.notify("Usage: /evopi-job start <title>", "warning");
					return;
				}
				currentJob = newJob(title, recorder.state.traceId);
				persistJob();
				recorder.record("job.start", ctx, currentJob as unknown as JsonRecord, { anchor: true });
				ctx.ui.notify(`Started ${currentJob.id}: ${currentJob.title}`, "info");
				return;
			}

			if (trimmed.startsWith("plan ")) {
				if (!currentJob) return void ctx.ui.notify("No active job. /evopi-job start <title> first.", "warning");
				currentJob.plan = trimmed.slice(5).trim();
				currentJob.updatedAt = isoNow();
				persistJob();
				recorder.record("job.plan", ctx, { jobId: currentJob.id, planLength: currentJob.plan.length });
				ctx.ui.notify(`Plan saved for ${currentJob.id}`, "info");
				return;
			}

			if (trimmed.startsWith("acceptance ")) {
				if (!currentJob) return void ctx.ui.notify("No active job. /evopi-job start <title> first.", "warning");
				currentJob.acceptance = trimmed.slice("acceptance ".length).trim();
				currentJob.updatedAt = isoNow();
				persistJob();
				recorder.record("job.acceptance", ctx, { jobId: currentJob.id, acceptanceLength: currentJob.acceptance.length });
				ctx.ui.notify(`Acceptance saved for ${currentJob.id}`, "info");
				return;
			}

			if (trimmed === "checkpoint") {
				if (!currentJob) return void ctx.ui.notify("No active job.", "warning");
				const cp = addCheckpoint(ctx, "manual");
				if (!cp) return void ctx.ui.notify("无法打 checkpoint（无当前 entry）。", "warning");
				recorder.record("job.checkpoint", ctx, { jobId: currentJob.id, entryId: cp.entryId, label: cp.label }, { anchor: true });
				ctx.ui.notify(`Checkpoint at ${cp.entryId} (${cp.label})`, "info");
				return;
			}

			if (trimmed.startsWith("rewind")) {
				if (!currentJob) return void ctx.ui.notify("No active job.", "warning");
				const arg = trimmed.slice("rewind".length).trim();
				const cps = currentJob.checkpoints;
				if (cps.length === 0) return void ctx.ui.notify("No checkpoints to rewind to.", "warning");
				// arg 可为序号（1-based）或 entryId；缺省回退到最近一个。
				let target: JobCheckpoint | undefined;
				if (!arg) target = cps[cps.length - 1];
				else if (/^\d+$/.test(arg)) target = cps[Number(arg) - 1];
				else target = cps.find((c) => c.entryId === arg || c.label === arg);
				if (!target) return void ctx.ui.notify(`No such checkpoint: ${arg}`, "warning");
				try {
					ctx.navigateTree(target.entryId);
				} catch (e) {
					return void ctx.ui.notify(`Rewind 失败: ${String(e instanceof Error ? e.message : e)}`, "warning");
				}
				recorder.record("job.rewind", ctx, { jobId: currentJob.id, entryId: target.entryId }, { anchor: true });
				ctx.ui.notify(`Rewound to ${target.entryId} (${target.reason})。注意：只回退对话/上下文，不回退文件改动。`, "info");
				return;
			}

			if (["queued", "running", "waitingApproval", "failed", "passed", "blocked"].includes(trimmed)) {
				if (!currentJob) return void ctx.ui.notify("No active job.", "warning");
				// 切 passed 前的证据警告（决策 7：人拍板，但有 error/高危/测试没过要提示）。
				if (trimmed === "passed") {
					const warnings: string[] = [];
					if (currentJob.toolErrors > 0) warnings.push(`有 ${currentJob.toolErrors} 个工具错误`);
					if (currentJob.highRiskBlocked > 0) warnings.push(`有 ${currentJob.highRiskBlocked} 个高危被拦未解决`);
					if (currentJob.testsRan && currentJob.testsPassed === false) warnings.push("识别到的测试未通过");
					if (warnings.length > 0) {
						ctx.ui.notify(`⚠️ 证据警告（仍标 passed，但请确认）：${warnings.join("；")}`, "warning");
					}
				}
				currentJob.status = trimmed as JobState["status"];
				currentJob.updatedAt = isoNow();
				persistJob();
				recorder.record("job.status", ctx, { jobId: currentJob.id, status: trimmed }, { anchor: true });
				ctx.ui.notify(`${currentJob.id} -> ${trimmed}`, "info");
				return;
			}

			// 默认：证据面板。
			if (!currentJob) {
				ctx.ui.notify("No active job. Use /evopi-job start <title>.", "info");
				return;
			}
			const evidence = [
				`id: ${currentJob.id}`,
				`title: ${currentJob.title}`,
				`status: ${currentJob.status}`,
				`traceId: ${currentJob.traceId}`,
				"",
				"— 证据面板 —",
				`toolCalls: ${currentJob.toolCalls}  toolErrors: ${currentJob.toolErrors}`,
				`highRiskBlocked: ${currentJob.highRiskBlocked}`,
				`checkpoints: ${currentJob.checkpoints.length}`,
				`tests: ${currentJob.testsRan ? (currentJob.testsPassed ? "PASS" : "FAIL") : "未识别到测试命令"}`,
				`plan: ${currentJob.plan ?? "unset"}`,
				`acceptance: ${currentJob.acceptance ?? "unset"}`,
				"",
				"Use: start|plan|acceptance|checkpoint|rewind [n]|passed|failed|...",
			];
			ctx.ui.notify(evidence.join("\n"), "info");
		},
	});

	return { evaluateToolCall, onToolCall };
}

// 供测试复用。
export { isTestCommand, commandFingerprint };
