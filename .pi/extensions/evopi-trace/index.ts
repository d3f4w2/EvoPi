// index.ts — EvoPi 扩展入口。
// 职责（见 impl/README §5）：读配置 + 依次 registerXxx(pi, shared) + 共享路由。
// 底座与共享工具在 trace.ts；各模块业务逻辑在各自 <模块>.ts。
//
// 迁出记录：
//   - 模块 1（Trace 底座）：recorder/事件写入/摘要工具 → trace.ts。
//   - 模块 2（Cost）：/evopi-cost + before/after_provider_request 钩子 → cost.ts（registerCost）。
//   - 模块 3（技能记忆）：/evopi-memory + /evopi-skill、context/resources_discover 钩子 → memory.ts/skill.ts；
//     共享策略 → policy.ts。旧 /evopi-memory MVP 已被 memory.ts 取代并删除。
//   - 模块 4（执行治理）：/evopi-job + Policy Gate + checkpoint/rewind + 证据验收 → job.ts（registerJob）。
//     Policy Gate 的决策函数由本文件的**单一 tool_call handler** 调用（安全>资源，模块 4 先于 5）；旧 /evopi-job MVP 已删除。
//   - 模块 5（工具运行时）：错误分类 + 延迟 + 预算 + /evopi-tools → tools.ts（createTools）。
//     预算决策接在单一 tool_call handler 里 policy **之后**（安全>资源）；tool.result 观测迁入 tools.ts。
//   - 模块 6（评测协作）：确定性评分 + golden task + 子代理 spawn + 棘轮门禁 + /evopi-eval → eval.ts（registerEval）。
//     旧 /evopi-eval MVP（record/list）已被 eval.ts 取代并删除。
//   V1 六个模块（2/3/4/5/6）全部拆分完毕；index.ts 只做注册 + 单一 tool_call 路由。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCost } from "./cost";
import { registerEval } from "./eval";
import { registerJob } from "./job";
import { registerMemory } from "./memory";
import { registerRag } from "./rag";
import { registerSkill } from "./skill";
import { createTools } from "./tools";
import {
	type JsonRecord,
	type Recorder,
	createRecorder,
	formatCounts,
	getTraceFile,
	summarizeMessage,
	summarizeRecord,
} from "./trace";

export default function evopiTraceExtension(pi: ExtensionAPI) {
	const recorder = createRecorder(pi);
	const shared: { recorder: Recorder } = { recorder };

	// 模块 2：Cost —— 自注册 provider 钩子 + /evopi-cost。
	registerCost(pi, shared);

	// 模块 3：技能记忆 —— Memory(context 注入/压缩抢救/evopi-memory) + Skill(resources_discover 过滤/统计/evopi-skill)。
	registerMemory(pi, shared);
	registerSkill(pi, shared);

	// 模块 4：执行治理 —— /evopi-job + Policy Gate。返回决策函数交给下面的单一 tool_call handler（安全>资源）。
	const job = registerJob(pi, shared);

	// 模块 5：工具运行时 —— 错误分类 + 延迟 + 预算。预算决策接在 policy 之后（安全>资源）；tool.result 观测在 tools.ts。
	const tools = createTools(shared);

	// 模块 6：评测协作 —— /evopi-eval（确定性评分 / golden task / 子代理 spawn / 棘轮门禁）。
	registerEval(pi, shared);

	// V2 增量：Codebase RAG —— context 钩子做本地代码预检索注入（与 memory 注入并存）+ /evopi-rag。
	registerRag(pi, shared);

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

	// /evopi-memory 由 registerMemory（memory.ts）注册；/evopi-job 由 registerJob（job.ts）注册。旧 MVP 已删除。

	pi.registerCommand("evopi-tools", {
		description: "Show EvoPi tool runtime stats (错误分类 / 延迟 / 预算)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(tools.renderStats(), "info");
		},
	});

	// /evopi-eval 由 registerEval（eval.ts）注册；旧 MVP（record/list）已删除。

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
		// 模块 5：per-turn 预算重置（防单轮死循环，决策 4）。
		tools.resetTurn();
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

	// 单一 tool_call handler（安全 > 资源，决策 6）：① 模块 4 Policy Gate 安全准入 → 命中 block 立即返回；
	// ② 模块 5 预算资源硬限 → 命中 block 返回；③ 都放行才做观测（trace + 计入 job/预算计时）。
	// 安全先于资源：rm -rf 比「次数超限」严重，用户应先知道是危险被拦（原因确定，不靠注册顺序）。
	pi.on("tool_call", async (event, ctx) => {
		// ① 安全准入（模块 4）。
		const security = await job.evaluateToolCall(
			{ toolName: event.toolName, toolCallId: event.toolCallId, input: (event.input ?? {}) as JsonRecord },
			ctx,
		);
		// ② 资源预算（模块 5），仅在安全放行后才判。
		const budget = security.block ? { block: false } : tools.evaluateBudget(event, ctx);
		const blocked = security.block || budget.block;
		const reason = security.block ? security.reason : budget.reason;

		// 观测：无论放行与否都记 tool.call（这是一次「尝试」）。
		recorder.record("tool.call", ctx, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: summarizeRecord(event.input),
			blocked: blocked || undefined,
		});

		if (blocked) {
			// 被拦截：不计入执行/预算/job（它没真正执行）。
			return { block: true, reason };
		}

		// 放行后的执行观测：计入 job + 预算计时/计数（软限告警在 onToolCall 内）。
		job.onToolCall();
		tools.onToolCall(event, ctx);
		return undefined;
	});

	// tool_result：模块 5 统一处理（latency + errorClass + stats + 记 tool.result）。
	// job 的错误/测试证据采集在 job.ts 自己的 tool_result handler；两者都是观测，Pi 全执行。
	pi.on("tool_result", (event, ctx) => {
		tools.onToolResult(
			{
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				isError: event.isError,
				input: (event.input ?? {}) as JsonRecord,
				content: event.content,
				details: event.details,
			},
			ctx,
		);
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
