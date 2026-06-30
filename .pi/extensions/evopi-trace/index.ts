import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "evopi.trace";
const SCHEMA_VERSION = 1;

type JsonRecord = Record<string, unknown>;

interface TraceEvent {
	schemaVersion: 1;
	traceId: string;
	eventId: string;
	type: string;
	timestamp: string;
	sessionLeafId?: string;
	model?: {
		provider?: string;
		id?: string;
		name?: string;
	};
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
	data?: JsonRecord;
}

interface TraceState {
	traceId: string;
	sequence: number;
	startedAt: string;
	lastEventTypes: string[];
	counts: Record<string, number>;
	traceFile?: string;
}

interface CostState {
	providerRequests: number;
	providerResponses: number;
	lastProviderStatus?: number;
	lastPayload?: JsonRecord;
	lastContextUsage?: TraceEvent["contextUsage"];
}

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

function newTraceId(): string {
	const random = Math.random().toString(36).slice(2, 10);
	return `tr_${Date.now().toString(36)}_${random}`;
}

function isoNow(): string {
	return new Date().toISOString();
}

function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
}

function getTraceDir(cwd: string): string {
	return join(cwd, ".pi", "evopi", "traces");
}

function getEvoPiDir(cwd: string): string {
	return join(cwd, ".pi", "evopi");
}

function getMemoryDir(cwd: string): string {
	return join(getEvoPiDir(cwd), "memory");
}

function getEvalDir(cwd: string): string {
	return join(getEvoPiDir(cwd), "evals");
}

function getTraceFile(cwd: string, traceId: string): string {
	return join(getTraceDir(cwd), `${traceId}.jsonl`);
}

function readText(path: string): string {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8");
}

function countMarkdownEntries(path: string): number {
	return readText(path)
		.split(/\r?\n/)
		.filter((line) => line.startsWith("- ")).length;
}

function ensureMemoryFiles(cwd: string): void {
	const dir = getMemoryDir(cwd);
	ensureDir(dir);
	const files: Array<[string, string]> = [
		[
			"INDEX.md",
			"# EvoPi Memory Index\n\n- MEMORY.md: project facts, preferences, decisions, and commands.\n- SKILLS.md: reusable workflow and skill candidates.\n",
		],
		["MEMORY.md", "# EvoPi Project Memory\n\n"],
		["SKILLS.md", "# EvoPi Skill Candidates\n\n"],
	];
	for (const [name, initial] of files) {
		const path = join(dir, name);
		if (!existsSync(path)) {
			writeFileSync(path, initial, "utf8");
		}
	}
}

function appendMemory(cwd: string, text: string, traceId: string): string {
	ensureMemoryFiles(cwd);
	const path = join(getMemoryDir(cwd), "MEMORY.md");
	appendFileSync(path, `- ${isoNow()} [${traceId}] ${text.trim()}\n`, "utf8");
	return path;
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

function safeJson(value: unknown): unknown {
	try {
		JSON.stringify(value);
		return value;
	} catch {
		return "[unserializable]";
	}
}

function summarizeScalar(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return { type: "string", length: value.length };
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return { type: "array", length: value.length };
	if (typeof value === "object") return { type: "object", keys: Object.keys(value as JsonRecord).slice(0, 20) };
	return { type: typeof value };
}

function summarizeRecord(value: unknown): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { value: summarizeScalar(value) };
	}

	const record = value as JsonRecord;
	const summary: JsonRecord = {};
	for (const key of Object.keys(record).slice(0, 30)) {
		summary[key] = summarizeScalar(record[key]);
	}
	return summary;
}

function summarizeContent(content: unknown): JsonRecord {
	if (!Array.isArray(content)) {
		return { kind: typeof content };
	}

	let textItems = 0;
	let imageItems = 0;
	let totalTextLength = 0;
	let otherItems = 0;

	for (const item of content) {
		if (!item || typeof item !== "object") {
			otherItems++;
			continue;
		}
		const record = item as JsonRecord;
		if (record.type === "text") {
			textItems++;
			if (typeof record.text === "string") totalTextLength += record.text.length;
		} else if (record.type === "image") {
			imageItems++;
		} else {
			otherItems++;
		}
	}

	return {
		items: content.length,
		textItems,
		imageItems,
		otherItems,
		totalTextLength,
	};
}

function summarizeMessage(message: unknown): JsonRecord {
	if (!message || typeof message !== "object") {
		return { kind: typeof message };
	}

	const record = message as JsonRecord;
	const summary: JsonRecord = {
		role: record.role,
		type: record.type,
		keys: Object.keys(record).slice(0, 20),
	};

	if (typeof record.content === "string") {
		summary.content = { type: "string", length: record.content.length };
	} else if (Array.isArray(record.content)) {
		summary.content = summarizeContent(record.content);
	}

	if (Array.isArray(record.toolCalls)) {
		summary.toolCalls = record.toolCalls.length;
	}

	return summary;
}

function summarizeProviderPayload(payload: unknown): JsonRecord {
	if (!payload || typeof payload !== "object") {
		return { kind: typeof payload };
	}

	const record = payload as JsonRecord;
	const summary: JsonRecord = {
		keys: Object.keys(record).slice(0, 30),
	};

	if (Array.isArray(record.messages)) {
		const roleCounts: Record<string, number> = {};
		for (const message of record.messages) {
			const role =
				message && typeof message === "object" && "role" in message
					? String((message as { role?: unknown }).role ?? "unknown")
					: "unknown";
			roleCounts[role] = (roleCounts[role] ?? 0) + 1;
		}
		summary.messages = {
			count: record.messages.length,
			roleCounts,
		};
	}

	for (const toolKey of ["tools", "functions"] as const) {
		if (Array.isArray(record[toolKey])) {
			summary[toolKey] = { count: record[toolKey].length };
		}
	}

	if (typeof record.model === "string") summary.model = record.model;
	if (typeof record.max_tokens === "number") summary.maxTokens = record.max_tokens;
	if (typeof record.max_output_tokens === "number") summary.maxOutputTokens = record.max_output_tokens;
	if (typeof record.temperature === "number") summary.temperature = record.temperature;

	return summary;
}

function getModelSummary(ctx: ExtensionContext): TraceEvent["model"] | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	const record = model as unknown as JsonRecord;
	return {
		provider: typeof record.provider === "string" ? record.provider : undefined,
		id: typeof record.id === "string" ? record.id : undefined,
		name: typeof record.name === "string" ? record.name : undefined,
	};
}

function getSessionLeafId(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getLeafEntry()?.id;
}

function createRecorder(pi: ExtensionAPI): {
	state: TraceState;
	record(type: string, ctx: ExtensionContext, data?: JsonRecord): void;
	reset(cwd: string): void;
} {
	const state: TraceState = {
		traceId: newTraceId(),
		sequence: 0,
		startedAt: isoNow(),
		lastEventTypes: [],
		counts: {},
	};

	function reset(cwd: string): void {
		state.traceId = newTraceId();
		state.sequence = 0;
		state.startedAt = isoNow();
		state.lastEventTypes = [];
		state.counts = {};
		state.traceFile = getTraceFile(cwd, state.traceId);
		ensureDir(getTraceDir(cwd));
	}

	function record(type: string, ctx: ExtensionContext, data?: JsonRecord): void {
		if (!state.traceFile) {
			state.traceFile = getTraceFile(ctx.cwd, state.traceId);
			ensureDir(getTraceDir(ctx.cwd));
		}

		state.sequence += 1;
		state.counts[type] = (state.counts[type] ?? 0) + 1;
		state.lastEventTypes.push(type);
		state.lastEventTypes = state.lastEventTypes.slice(-10);

		const event: TraceEvent = {
			schemaVersion: SCHEMA_VERSION,
			traceId: state.traceId,
			eventId: `${state.traceId}:${state.sequence}`,
			type,
			timestamp: isoNow(),
			sessionLeafId: getSessionLeafId(ctx),
			model: getModelSummary(ctx),
			contextUsage: ctx.getContextUsage(),
			data: data ? (safeJson(data) as JsonRecord) : undefined,
		};

		pi.appendEntry(CUSTOM_TYPE, event);
		appendFileSync(state.traceFile, `${JSON.stringify(event)}\n`, "utf8");
	}

	return { state, record, reset };
}

function formatCounts(counts: Record<string, number>): string[] {
	const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return ["No events recorded yet."];
	return entries.map(([type, count]) => `${type}: ${count}`);
}

export default function evopiTraceExtension(pi: ExtensionAPI) {
	const recorder = createRecorder(pi);
	const costState: CostState = {
		providerRequests: 0,
		providerResponses: 0,
	};
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

	pi.registerCommand("evopi-cost", {
		description: "Show EvoPi context and provider cost signals",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const lines = [
				`model: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`,
				`context: ${
					usage
						? `${usage.tokens ?? "unknown"} / ${usage.contextWindow} (${usage.percent ?? "unknown"}%)`
						: "unknown"
				}`,
				`providerRequests: ${costState.providerRequests}`,
				`providerResponses: ${costState.providerResponses}`,
				`lastProviderStatus: ${costState.lastProviderStatus ?? "none"}`,
				`lastPayload: ${JSON.stringify(costState.lastPayload ?? {})}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("evopi-memory", {
		description: "Manage EvoPi project memory",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			ensureMemoryFiles(ctx.cwd);

			if (trimmed.startsWith("add ")) {
				const text = trimmed.slice(4).trim();
				if (!text) {
					ctx.ui.notify("Usage: /evopi-memory add <fact or decision>", "warning");
					return;
				}
				const path = appendMemory(ctx.cwd, text, recorder.state.traceId);
				recorder.record("memory.write", ctx, { path, textLength: text.length });
				pi.appendEntry("evopi.memory", {
					traceId: recorder.state.traceId,
					path,
					text,
					timestamp: isoNow(),
				});
				ctx.ui.notify(`Memory appended to ${path}`, "info");
				return;
			}

			const dir = getMemoryDir(ctx.cwd);
			const memoryPath = join(dir, "MEMORY.md");
			const skillsPath = join(dir, "SKILLS.md");
			const lines = [
				`memoryDir: ${dir}`,
				`memoryEntries: ${countMarkdownEntries(memoryPath)}`,
				`skillCandidates: ${countMarkdownEntries(skillsPath)}`,
				"",
				"Use: /evopi-memory add <fact or decision>",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

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
				recorder.record("job.start", ctx, currentJob as unknown as JsonRecord);
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
				recorder.record("job.status", ctx, { jobId: currentJob?.id, status: trimmed });
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
				pi.appendEntry("evopi.eval", record);
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
		ensureMemoryFiles(ctx.cwd);
		recorder.record("session.start", ctx, {
			reason: event.reason,
			previousSessionFile: event.previousSessionFile,
			trusted: ctx.isProjectTrusted(),
		});
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

	pi.on("before_provider_request", (event, ctx) => {
		costState.providerRequests += 1;
		costState.lastPayload = summarizeProviderPayload(event.payload);
		costState.lastContextUsage = ctx.getContextUsage();
		recorder.record("provider.request", ctx, {
			payload: costState.lastPayload,
		});
	});

	pi.on("after_provider_response", (event, ctx) => {
		costState.providerResponses += 1;
		costState.lastProviderStatus = event.status;
		recorder.record("provider.response", ctx, {
			status: event.status,
			headers: {
				"x-request-id": event.headers["x-request-id"],
				"request-id": event.headers["request-id"],
				"content-type": event.headers["content-type"],
			},
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
		recorder.record("compact.before", ctx, {
			reason: event.reason,
			willRetry: event.willRetry,
			branchEntries: event.branchEntries.length,
		});
	});

	pi.on("session_compact", (event, ctx) => {
		recorder.record("compact.after", ctx, {
			reason: event.reason,
			willRetry: event.willRetry,
			compactionEntryId: event.compactionEntry.id,
			fromExtension: event.fromExtension,
		});
	});

	pi.on("session_shutdown", (event, ctx) => {
		recorder.record("session.shutdown", ctx, {
			reason: event.reason,
			targetSessionFile: event.targetSessionFile,
		});
	});
}

