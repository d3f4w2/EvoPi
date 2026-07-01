// index.ts — EvoPi 扩展入口。
// 职责（见 impl/README §5）：读配置 + 依次 registerXxx(pi, shared) + 共享路由。
// 底座与共享工具在 trace.ts；各模块业务逻辑在各自 <模块>.ts。
//
// 迁出记录：
//   - 模块 1（Trace 底座）：recorder/事件写入/摘要工具 → trace.ts。
//   - 模块 2（Cost）：/evopi-cost + before/after_provider_request 钩子 → cost.ts（registerCost）。
//   - 模块 3（技能记忆）：/evopi-memory + /evopi-skill、context/resources_discover 钩子 → memory.ts/skill.ts；
//     共享策略 → policy.ts。旧 /evopi-memory MVP 已被 memory.ts 取代并删除。
//   - 其余模块（job/tools/eval）MVP 暂留本文件，按各自模块开工时再迁出（模块 4/5/6）。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCost } from "./cost";
import { registerMemory } from "./memory";
import { registerSkill } from "./skill";
import {
	type JsonRecord,
	type Recorder,
	createRecorder,
	ensureDir,
	formatCounts,
	getEvoPiDir,
	getTraceFile,
	isoNow,
	summarizeContent,
	summarizeMessage,
	summarizeRecord,
	summarizeScalar,
} from "./trace";

// --- 以下模块（job/tools/eval）仍是 MVP，等对应模块开工再迁出到各自 .ts ---

interface ToolStat {
	calls: number;
	errors: number;
	lastUsedAt?: string;
}

interface JobState {
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
}

interface EvalRecord {
	id: string;
	name: string;
	score: number;
	notes?: string;
	traceId: string;
	timestamp: string;
}

function getEvalDir(cwd: string): string {
	return join(getEvoPiDir(cwd), "evals");
}

function readText(path: string): string {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8");
}

function getEvalRunsFile(cwd: string): string {
	return join(getEvalDir(cwd), "runs.jsonl");
}

function appendEvalRecord(cwd: string, record: EvalRecord): string {
	ensureDir(getEvalDir(cwd));
	const path = getEvalRunsFile(cwd);
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	return path;
}

export default function evopiTraceExtension(pi: ExtensionAPI) {
	const recorder = createRecorder(pi);
	const shared: { recorder: Recorder } = { recorder };

	// 模块 2：Cost —— 自注册 provider 钩子 + /evopi-cost。
	registerCost(pi, shared);

	// 模块 3：技能记忆 —— Memory(context 注入/压缩抢救/evopi-memory) + Skill(resources_discover 过滤/统计/evopi-skill)。
	registerMemory(pi, shared);
	registerSkill(pi, shared);

	const toolStats = new Map<string, ToolStat>();
	let currentJob: JobState | undefined;

	function persistJob() {
		if (currentJob) {
			pi.appendEntry<JobState>("evopi.job", currentJob);
		}
	}

	function updateJobStatus(status: JobState["status"]) {
		if (!currentJob) return;
		currentJob.status = status;
		currentJob.updatedAt = isoNow();
		persistJob();
	}

	pi.registerCommand("evopi-trace", {
		description: "Show EvoPi trace status",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "path") {
				ctx.ui.notify(recorder.state.traceFile ?? getTraceFile(ctx.cwd, recorder.state.traceId), "info");
				return;
			}
			if (command === "last") {
				const last = recorder.state.lastEventTypes.length
					? recorder.state.lastEventTypes.join(" -> ")
					: "No events recorded yet.";
				ctx.ui.notify(last, "info");
				return;
			}

			const lines = [
				`traceId: ${recorder.state.traceId}`,
				`startedAt: ${recorder.state.startedAt}`,
				`traceFile: ${recorder.state.traceFile ?? getTraceFile(ctx.cwd, recorder.state.traceId)}`,
				"",
				...formatCounts(recorder.state.counts),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// /evopi-memory 由 registerMemory（memory.ts）注册；旧 MVP 已删除。

	pi.registerCommand("evopi-job", {
		description: "Manage EvoPi governed job state",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.startsWith("start ")) {
				const title = trimmed.slice(6).trim();
				if (!title) {
					ctx.ui.notify("Usage: /evopi-job start <title>", "warning");
					return;
				}
				currentJob = {
					id: `job_${Date.now().toString(36)}`,
					title,
					status: "running",
					createdAt: isoNow(),
					updatedAt: isoNow(),
					toolCalls: 0,
					toolErrors: 0,
					traceId: recorder.state.traceId,
				};
				persistJob();
				// job 起始是治理锚点 → 写 session anchor。
				recorder.record("job.start", ctx, currentJob as unknown as JsonRecord, { anchor: true });
				ctx.ui.notify(`Started ${currentJob.id}: ${currentJob.title}`, "info");
				return;
			}

			if (trimmed.startsWith("plan ")) {
				if (!currentJob) {
					ctx.ui.notify("No active job. Use /evopi-job start <title> first.", "warning");
					return;
				}
				currentJob.plan = trimmed.slice(5).trim();
				currentJob.updatedAt = isoNow();
				persistJob();
				recorder.record("job.plan", ctx, { jobId: currentJob.id, planLength: currentJob.plan.length });
				ctx.ui.notify(`Plan saved for ${currentJob.id}`, "info");
				return;
			}

			if (trimmed.startsWith("acceptance ")) {
				if (!currentJob) {
					ctx.ui.notify("No active job. Use /evopi-job start <title> first.", "warning");
					return;
				}
				currentJob.acceptance = trimmed.slice("acceptance ".length).trim();
				currentJob.updatedAt = isoNow();
				persistJob();
				recorder.record("job.acceptance", ctx, {
					jobId: currentJob.id,
					acceptanceLength: currentJob.acceptance.length,
				});
				ctx.ui.notify(`Acceptance checklist saved for ${currentJob.id}`, "info");
				return;
			}

			if (["queued", "running", "waitingApproval", "failed", "passed", "blocked"].includes(trimmed)) {
				updateJobStatus(trimmed as JobState["status"]);
				// job 终态是治理锚点 → 写 session anchor。
				recorder.record("job.status", ctx, { jobId: currentJob?.id, status: trimmed }, { anchor: true });
				ctx.ui.notify(currentJob ? `${currentJob.id} -> ${trimmed}` : "No active job.", currentJob ? "info" : "warning");
				return;
			}

			if (!currentJob) {
				ctx.ui.notify("No active job. Use /evopi-job start <title>.", "info");
				return;
			}

			const lines = [
				`id: ${currentJob.id}`,
				`title: ${currentJob.title}`,
				`status: ${currentJob.status}`,
				`traceId: ${currentJob.traceId}`,
				`toolCalls: ${currentJob.toolCalls}`,
				`toolErrors: ${currentJob.toolErrors}`,
				`plan: ${currentJob.plan ?? "unset"}`,
				`acceptance: ${currentJob.acceptance ?? "unset"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("evopi-tools", {
		description: "Show EvoPi tool runtime stats",
		handler: async (_args, ctx) => {
			if (toolStats.size === 0) {
				ctx.ui.notify("No tool calls recorded yet.", "info");
				return;
			}
			const lines = Array.from(toolStats.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, stat]) => `${name}: calls=${stat.calls} errors=${stat.errors} lastUsed=${stat.lastUsedAt ?? "never"}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("evopi-eval", {
		description: "Record or show EvoPi eval scores",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.startsWith("record ")) {
				const parts = trimmed.slice(7).trim().split(/\s+/);
				const name = parts[0];
				const scoreText = parts[1];
				const score = Number(scoreText);
				const notes = parts.slice(2).join(" ");
				if (!name || !Number.isFinite(score)) {
					ctx.ui.notify("Usage: /evopi-eval record <name> <score> [notes]", "warning");
					return;
				}
				const record: EvalRecord = {
					id: `eval_${Date.now().toString(36)}`,
					name,
					score,
					notes: notes || undefined,
					traceId: recorder.state.traceId,
					timestamp: isoNow(),
				};
				const path = appendEvalRecord(ctx.cwd, record);
				recorder.record("eval.score", ctx, record as unknown as JsonRecord);
				ctx.ui.notify(`Eval recorded in ${path}`, "info");
				return;
			}

			const path = getEvalRunsFile(ctx.cwd);
			const lines = readText(path).trim().split(/\r?\n/).filter(Boolean);
			ctx.ui.notify(
				[
					`evalRunsFile: ${path}`,
					`records: ${lines.length}`,
					"",
					"Use: /evopi-eval record <name> <score> [notes]",
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_start", (event, ctx) => {
		recorder.reset(ctx.cwd);
		// 记忆文件由 memory.ts 首次写入时惰性创建，session_start 不再预建。
		// 会话起始是关键语义锚点 → 写 session anchor。
		recorder.record(
			"session.start",
			ctx,
			{
				reason: event.reason,
				previousSessionFile: event.previousSessionFile,
				trusted: ctx.isProjectTrusted(),
			},
			{ anchor: true },
		);
	});

	pi.on("agent_start", (_event, ctx) => {
		recorder.record("agent.start", ctx, {
			activeTools: pi.getActiveTools().length,
		});
	});

	pi.on("agent_end", (event, ctx) => {
		recorder.record("agent.end", ctx, {
			messages: event.messages.length,
		});
	});

	pi.on("turn_start", (event, ctx) => {
		recorder.record("turn.start", ctx, {
			turnIndex: event.turnIndex,
			timestamp: event.timestamp,
		});
	});

	pi.on("turn_end", (event, ctx) => {
		recorder.record("turn.end", ctx, {
			turnIndex: event.turnIndex,
			finalMessage: summarizeMessage(event.message),
			toolResults: event.toolResults.length,
		});
	});

	pi.on("tool_call", (event, ctx) => {
		const stat = toolStats.get(event.toolName) ?? { calls: 0, errors: 0 };
		stat.calls += 1;
		stat.lastUsedAt = isoNow();
		toolStats.set(event.toolName, stat);
		if (currentJob) {
			currentJob.toolCalls += 1;
			currentJob.updatedAt = isoNow();
			persistJob();
		}
		recorder.record("tool.call", ctx, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: summarizeRecord(event.input),
		});
	});

	pi.on("tool_result", (event, ctx) => {
		const stat = toolStats.get(event.toolName) ?? { calls: 0, errors: 0 };
		if (event.isError) {
			stat.errors += 1;
		}
		stat.lastUsedAt = isoNow();
		toolStats.set(event.toolName, stat);
		if (currentJob && event.isError) {
			currentJob.toolErrors += 1;
			currentJob.status = "failed";
			currentJob.updatedAt = isoNow();
			persistJob();
		}
		recorder.record("tool.result", ctx, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
			inputKeys: Object.keys(event.input ?? {}).slice(0, 30),
			content: summarizeContent(event.content),
			details: summarizeScalar(event.details),
		});
	});

	pi.on("message_end", (event, ctx) => {
		recorder.record("message.end", ctx, {
			message: summarizeMessage(event.message),
		});
	});

	pi.on("session_before_compact", (event, ctx) => {
		// compaction 前后是关键语义锚点 → 写 session anchor。
		recorder.record(
			"compact.before",
			ctx,
			{
				reason: event.reason,
				willRetry: event.willRetry,
				branchEntries: event.branchEntries.length,
			},
			{ anchor: true },
		);
	});

	pi.on("session_compact", (event, ctx) => {
		recorder.record(
			"compact.after",
			ctx,
			{
				reason: event.reason,
				willRetry: event.willRetry,
				compactionEntryId: event.compactionEntry.id,
				fromExtension: event.fromExtension,
			},
			{ anchor: true },
		);
	});

	pi.on("session_shutdown", (event, ctx) => {
		recorder.record(
			"session.shutdown",
			ctx,
			{
				reason: event.reason,
				targetSessionFile: event.targetSessionFile,
			},
			{ anchor: true },
		);
	});
}
