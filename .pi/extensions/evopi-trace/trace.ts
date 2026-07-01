// trace.ts — EvoPi Trace 底座（模块 1）。
//
// 本模块铁律（就近约定，见 impl/README §5）：
//   1. 所有 *.* 事件写入 **统一走本文件的 recorder.record()**——一处控制 JSONL + session anchor 判定。
//      各消费者模块（cost/memory/policy/...）不自己拼 JSONL、不自己决定写不写 anchor。
//   2. **Anchor-only**：只有「资产产生/审批/关键治理决策」才写 session anchor（pi.appendEntry）。
//      逐次观测/执行细节只进 JSONL。判据见 00-整体架构.md 第四节。默认 anchor=false。
//   3. 事件形状 = TraceEvent（schemaVersion 冻结为 1）。加字段向后兼容，改名/删字段要记变更日志。
//
// 这里只放**底座与共享工具**：traceId、事件写入、JSONL、path 解析、payload/message 摘要。
// 各模块的业务逻辑在各自 <模块>.ts。

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CUSTOM_TYPE = "evopi.trace";
export const SCHEMA_VERSION = 1 as const;

export type JsonRecord = Record<string, unknown>;

export interface TraceEvent {
	schemaVersion: typeof SCHEMA_VERSION;
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

export interface TraceState {
	traceId: string;
	sequence: number;
	startedAt: string;
	lastEventTypes: string[];
	counts: Record<string, number>;
	traceFile?: string;
}

/** 写事件时的可选项。anchor=true 才把事件写进 session（Anchor-only 守门）。 */
export interface RecordOptions {
	/** 是否额外写 session anchor（pi.appendEntry）。默认 false=只进 JSONL。 */
	anchor?: boolean;
}

export interface Recorder {
	state: TraceState;
	/** 记一条 trace 事件。默认只写 JSONL；传 {anchor:true} 才额外写 session anchor。 */
	record(type: string, ctx: ExtensionContext, data?: JsonRecord, options?: RecordOptions): void;
	/** 新会话开始时重置 traceId / 计数 / 文件句柄。 */
	reset(cwd: string): void;
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function newTraceId(): string {
	const random = Math.random().toString(36).slice(2, 10);
	return `tr_${Date.now().toString(36)}_${random}`;
}

export function isoNow(): string {
	return new Date().toISOString();
}

export function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
}

export function getEvoPiDir(cwd: string): string {
	return join(cwd, ".pi", "evopi");
}

export function getTraceDir(cwd: string): string {
	return join(getEvoPiDir(cwd), "traces");
}

export function getTraceFile(cwd: string, traceId: string): string {
	return join(getTraceDir(cwd), `${traceId}.jsonl`);
}

// ---------------------------------------------------------------------------
// 上下文 / 模型信息读取
// ---------------------------------------------------------------------------

export function getModelSummary(ctx: ExtensionContext): TraceEvent["model"] | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	const record = model as unknown as JsonRecord;
	return {
		provider: typeof record.provider === "string" ? record.provider : undefined,
		id: typeof record.id === "string" ? record.id : undefined,
		name: typeof record.name === "string" ? record.name : undefined,
	};
}

export function getSessionLeafId(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getLeafEntry()?.id;
}

// ---------------------------------------------------------------------------
// 序列化 / 摘要工具（大 payload 永不整体进上下文，只留摘要）
// ---------------------------------------------------------------------------

export function safeJson(value: unknown): unknown {
	try {
		JSON.stringify(value);
		return value;
	} catch {
		return "[unserializable]";
	}
}

export function summarizeScalar(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return { type: "string", length: value.length };
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return { type: "array", length: value.length };
	if (typeof value === "object") return { type: "object", keys: Object.keys(value as JsonRecord).slice(0, 20) };
	return { type: typeof value };
}

export function summarizeRecord(value: unknown): JsonRecord {
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

export function summarizeContent(content: unknown): JsonRecord {
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

export function summarizeMessage(message: unknown): JsonRecord {
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

export function summarizeProviderPayload(payload: unknown): JsonRecord {
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
			summary[toolKey] = { count: (record[toolKey] as unknown[]).length };
		}
	}

	if (typeof record.model === "string") summary.model = record.model;
	if (typeof record.max_tokens === "number") summary.maxTokens = record.max_tokens;
	if (typeof record.max_output_tokens === "number") summary.maxOutputTokens = record.max_output_tokens;
	if (typeof record.temperature === "number") summary.temperature = record.temperature;

	return summary;
}

// ---------------------------------------------------------------------------
// Recorder — 事件写入的单一入口
// ---------------------------------------------------------------------------

export function createRecorder(pi: ExtensionAPI): Recorder {
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

	function record(type: string, ctx: ExtensionContext, data?: JsonRecord, options?: RecordOptions): void {
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

		// Anchor-only：默认只写 JSONL；只有关键语义事件（options.anchor=true）才写 session。
		if (options?.anchor) {
			pi.appendEntry(CUSTOM_TYPE, event);
		}
		appendFileSync(state.traceFile, `${JSON.stringify(event)}\n`, "utf8");
	}

	return { state, record, reset };
}

export function formatCounts(counts: Record<string, number>): string[] {
	const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return ["No events recorded yet."];
	return entries.map(([type, count]) => `${type}: ${count}`);
}
