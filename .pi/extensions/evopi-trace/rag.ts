// rag.ts — 模块（V2 增量）：Codebase RAG。
// 契约见 docs/evopi-v2/impl/进度.md「功能 1」+ 增量设计 docs/evopi-v2/增量设计/codebase-rag.md。
//
// 做什么：请求发出前，用**本地零 API 检索**把与当前任务最相关的代码片段直接注入 context，
// 让模型不必自己反复 grep/read 就先看到相关代码。挂 `context` 钩子（与 memory 注入并存、各自滤旧）。
//
// 本模块铁律（就近约定，呼应进度表冻结契约）：
//   1. 纯加法：不改任何已冻结事件字段 / policy / 现有模块行为。
//   2. 零 API：本地词频打分，不调 LLM、不发网络。
//   3. Anchor-only：`rag.retrieve` 只进 JSONL，不写 session anchor（逐次检索是观测）。
//   4. 保守注入：Top-K + 总字符软上限；空 query / 无命中不注入；先滤旧再注入防叠加。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type JsonRecord, type Recorder } from "./trace";

const INJECT_CUSTOM_TYPE = "evopi-rag";
const TOP_K = 8; // 注入片段数上限（保守，防爆 context）
const INJECT_MAX_CHARS = 6000; // 注入总字符软上限
const CHUNK_LINES = 40; // 每个检索片段的行数（滑动切片）
const MAX_FILE_BYTES = 200_000; // 超过此大小的文件跳过（多半是生成物/数据）
const MAX_INDEX_FILES = 2000; // 索引文件数上限，防超大仓库拖慢

// 只索引这些扩展名的文本源码。
const CODE_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
	".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".ps1",
	".json", ".md", ".yaml", ".yml", ".toml", ".sql",
]);

// 遍历时跳过的目录（噪音/体积/非项目源码）。
const SKIP_DIRS = new Set([
	"node_modules", "dist", "build", "out", ".git", ".pi", "pi", "coverage",
	".cache", ".next", ".turbo", "vendor", "__pycache__", ".venv", "venv",
]);

/** 一个可检索的代码片段。 */
export interface CodeChunk {
	path: string; // 仓库相对路径
	startLine: number; // 1-indexed
	endLine: number;
	text: string;
}

/** 分词：小写、按非字母数字切、拆驼峰、去太短的（与 memory.tokenize 同哲学，另拆 camelCase）。 */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	// 先按非字母数字（含下划线视为分隔）粗切
	for (const raw of text.split(/[^A-Za-z0-9]+/)) {
		if (!raw) continue;
		// 拆驼峰：fooBarBaz → foo bar baz；HTTPServer → http server
		const parts = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/\s+/);
		for (const p of parts) {
			const t = p.toLowerCase();
			if (t.length >= 2) out.push(t);
		}
	}
	return out;
}

/** 把一个文件切成带行号的滑动片段。 */
export function chunkFile(path: string, content: string, chunkLines = CHUNK_LINES): CodeChunk[] {
	const lines = content.split(/\r?\n/);
	const chunks: CodeChunk[] = [];
	for (let i = 0; i < lines.length; i += chunkLines) {
		const slice = lines.slice(i, i + chunkLines);
		if (slice.join("").trim() === "") continue; // 跳过纯空白片段
		chunks.push({
			path,
			startLine: i + 1,
			endLine: Math.min(i + chunkLines, lines.length),
			text: slice.join("\n"),
		});
	}
	return chunks;
}

/**
 * 给一个片段按 query 打分（零 API 词频）。
 * 内容命中 +1；**文件路径命中 +2**（路径/文件名往往是最强信号，如 query 含 "cost" → cost.ts 该排前）。
 */
export function scoreChunk(chunk: CodeChunk, queryTokens: string[]): number {
	if (queryTokens.length === 0) return 0;
	const bodyTokens = new Set(tokenize(chunk.text));
	const pathTokens = new Set(tokenize(chunk.path));
	let score = 0;
	for (const q of queryTokens) {
		if (bodyTokens.has(q)) score += 1;
		if (pathTokens.has(q)) score += 2;
	}
	return score;
}

/** 遍历目录建索引（切片列表）。跳过 SKIP_DIRS、非代码扩展名、超大文件；限文件总数。 */
export function buildIndex(cwd: string): CodeChunk[] {
	const chunks: CodeChunk[] = [];
	let fileCount = 0;

	function walk(dir: string): void {
		if (fileCount >= MAX_INDEX_FILES) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (fileCount >= MAX_INDEX_FILES) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
				walk(full);
			} else if (e.isFile()) {
				if (!CODE_EXTS.has(extname(e.name).toLowerCase())) continue;
				try {
					if (statSync(full).size > MAX_FILE_BYTES) continue;
					const content = readFileSync(full, "utf8");
					const rel = relative(cwd, full).split("\\").join("/");
					chunks.push(...chunkFile(rel, content));
					fileCount++;
				} catch {
					// 读不了就跳过，不让索引崩
				}
			}
		}
	}

	walk(cwd);
	return chunks;
}

/** 取与 query 最相关的 Top-K 片段（score>0）。 */
export function retrieveTopK(index: CodeChunk[], query: string, k = TOP_K): { chunk: CodeChunk; score: number }[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];
	return index
		.map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTokens) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path))
		.slice(0, k);
}

/** 从 messages 里取最后一条 user 文本做 query（与 memory 同逻辑）。 */
export function lastUserText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as JsonRecord;
		if (!m || m.role !== "user") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const texts = content
				.filter((c) => c && typeof c === "object" && (c as JsonRecord).type === "text")
				.map((c) => String((c as JsonRecord).text ?? ""));
			if (texts.length) return texts.join("\n");
		}
	}
	return "";
}

/** 渲染注入文本（带文件路径+行号，受总字符上限约束）。 */
export function renderInjection(hits: { chunk: CodeChunk; score: number }[]): string {
	let out =
		"[EvoPi Codebase RAG · 检索注入]\n以下是与当前请求相关的代码片段（EvoPi 本地零 API 检索，非用户本轮输入，仅供参考，必要时用工具读全文）：\n";
	let used = out.length;
	for (const { chunk } of hits) {
		const block = `\n--- ${chunk.path}:${chunk.startLine}-${chunk.endLine} ---\n${chunk.text}\n`;
		if (used + block.length > INJECT_MAX_CHARS) break;
		out += block;
		used += block.length;
	}
	return out;
}

/**
 * 注册 RAG（V2 增量）。挂 context 钩子做预检索注入 + 记 rag.retrieve + /evopi-rag。
 * 索引惰性构建并缓存（首次检索时建，命令可强制重建）。
 */
export function registerRag(pi: ExtensionAPI, shared: { recorder: Recorder }): void {
	const { recorder } = shared;
	let index: CodeChunk[] | undefined;
	let lastHits: { chunk: CodeChunk; score: number }[] = [];

	function ensureIndex(cwd: string): CodeChunk[] {
		if (!index) index = buildIndex(cwd);
		return index;
	}

	// --- 检索注入：context 钩子（复用 memory 的滤旧+注入模式，各自 customType 互不干扰） ---
	pi.on("context", (event, ctx) => {
		const messages = (event.messages ?? []) as JsonRecord[];
		// 先滤掉上一轮注入的 evopi-rag 消息（防叠加）。
		const cleaned = messages.filter((m: JsonRecord) => m.customType !== INJECT_CUSTOM_TYPE);

		const query = lastUserText(cleaned);
		if (!query) return { messages: cleaned };

		const idx = ensureIndex(ctx.cwd);
		const hits = retrieveTopK(idx, query);
		lastHits = hits;
		if (hits.length === 0) return { messages: cleaned };

		// rag.retrieve：只进 JSONL，不 anchor（守 Anchor-only）。
		recorder.record("rag.retrieve", ctx, {
			query: { length: query.length },
			hits: hits.map((h) => ({
				path: h.chunk.path,
				startLine: h.chunk.startLine,
				endLine: h.chunk.endLine,
				score: h.score,
			})),
			k: hits.length,
			indexedChunks: idx.length,
		});

		const injected = {
			customType: INJECT_CUSTOM_TYPE,
			content: renderInjection(hits),
			display: false,
		} as unknown as (typeof cleaned)[number];

		return { messages: [injected, ...cleaned] };
	});

	// --- 命令：/evopi-rag（状态 / 上轮命中 / reindex） ---
	pi.registerCommand("evopi-rag", {
		description: "EvoPi Codebase RAG: 本地代码检索预注入（状态 / 上轮命中 / reindex）",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "reindex") {
				index = buildIndex(ctx.cwd);
				ctx.ui.notify(`[EvoPi RAG] 已重建索引：${index.length} 个片段。`, "info");
				return;
			}
			ctx.ui.notify(renderStatus(ctx, index, lastHits), "info");
		},
	});
}

/** /evopi-rag 状态面板。 */
export function renderStatus(
	ctx: ExtensionContext,
	index: CodeChunk[] | undefined,
	lastHits: { chunk: CodeChunk; score: number }[],
): string {
	const lines: string[] = ["[EvoPi Codebase RAG]"];
	lines.push(`索引：${index ? `${index.length} 个片段（已建）` : "未建（首次检索时惰性构建）"}`);
	if (lastHits.length > 0) {
		lines.push(`上轮命中 ${lastHits.length} 个片段：`);
		for (const h of lastHits) {
			lines.push(`  · ${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine}  (score ${h.score})`);
		}
	} else {
		lines.push("上轮无命中（或尚未检索）。");
	}
	lines.push("命令：/evopi-rag reindex 重建索引。");
	void ctx;
	return lines.join("\n");
}
