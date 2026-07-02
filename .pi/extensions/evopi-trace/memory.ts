// memory.ts — 模块 3 · Memory 层（项目记忆）。
// 契约：03-技能记忆机制.md（决策 2 三级 scope、决策 6 关键词+时间邻近检索、决策 7 写入时机、
// 决策 10 memory.* 事件与 anchor 判据；条目格式见「记忆条目格式」节）。
//
// 本模块铁律（就近约定）：
//   1. **三级 scope**：project(.pi/evopi/memory/) / user(~/.evopi/memory/) / global(V1 占位)。
//      冲突/合并时 project > user > global（就近）。add 默认 project，--user/--global 写对应层。
//   2. **保守生效**：/evopi-memory add 显式写=直接 active；session_before_compact 抢救=candidate（不注入，待 review）。
//      每轮自动抽取=V1 不做（噪声大）。
//   3. **零 API 检索**：query 词频 + tags 命中 + 最近优先本地打分取 Top-K，不调 LLM、不全量注入（决策 6）。
//   4. **注入走 context 钩子的 CustomMessage**：prepend customType="evopi-memory" 的消息，先 filter 掉旧的（同 plan-mode 模式）。
//   5. **事件/anchor**：memory.write（显式）写 session anchor（资产产生）；memory.retrieve/review 只进 JSONL（决策 10）。
//      只有 active 记忆参与注入；candidate 不注入。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type JsonRecord, type Recorder, ensureDir, getEvoPiDir, isoNow } from "./trace";

export type MemoryScope = "project" | "user" | "global";
export type MemoryStatus = "active" | "candidate";

export interface MemoryEntry {
	title: string;
	scope: MemoryScope;
	source: string;
	created: string;
	status: MemoryStatus;
	tags: string[];
	body: string;
}

const INJECT_CUSTOM_TYPE = "evopi-memory";
const TOP_K = 5; // 注入条数上限（决策 6：Top-K，不全量）
const INJECT_MAX_CHARS = 4000; // 注入总字符软上限，防长记忆爆 context

// ---------------------------------------------------------------------------
// 存储路径（三级 scope）
// ---------------------------------------------------------------------------

function projectMemoryDir(cwd: string): string {
	return join(getEvoPiDir(cwd), "memory");
}

function userMemoryDir(): string {
	return join(homedir(), ".evopi", "memory");
}

/** scope → 目录。global V1 占位（暂等同 user 目录下的 global 子集，V1 不单独存储）。 */
function memoryDirFor(cwd: string, scope: MemoryScope): string {
	if (scope === "user" || scope === "global") return userMemoryDir();
	return projectMemoryDir(cwd);
}

function memoryFileFor(cwd: string, scope: MemoryScope): string {
	return join(memoryDirFor(cwd, scope), "MEMORY.md");
}

// ---------------------------------------------------------------------------
// 条目解析 / 序列化（轻量元数据 + Markdown 正文）
// ---------------------------------------------------------------------------

/**
 * 解析一个 MEMORY.md 文本为条目数组。兼容两种格式：
 *   - 新结构化：`## [scope] title` + `- key: value` 元数据行 + 正文。
 *   - 旧 MVP 流水账：`- <iso> [trace] text`（每行一条，宽松兜底为 active/project）。
 */
export function parseMemoryFile(text: string, scope: MemoryScope): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	const lines = text.split(/\r?\n/);

	let i = 0;
	// 跳过文件级标题（# ...）。
	while (i < lines.length && !lines[i].startsWith("## ")) {
		// 旧 MVP 流水账行：`- <iso> [trace] text`
		const legacy = /^- (\S+) \[([^\]]*)\]\s+(.*)$/.exec(lines[i]);
		if (legacy) {
			entries.push({
				title: legacy[3].slice(0, 60),
				scope,
				source: legacy[2] || "legacy",
				created: legacy[1],
				status: "active",
				tags: [],
				body: legacy[3],
			});
		}
		i++;
	}

	// 结构化小节。
	while (i < lines.length) {
		const header = /^##\s+(?:\[(\w+)\]\s*)?(.*)$/.exec(lines[i]);
		if (!header) {
			i++;
			continue;
		}
		const headerScope = (header[1] as MemoryScope) || scope;
		const title = header[2].trim();
		i++;

		const meta: Record<string, string> = {};
		const bodyLines: string[] = [];
		while (i < lines.length && !lines[i].startsWith("## ")) {
			const m = /^-\s+(scope|source|created|status|tags):\s*(.*)$/.exec(lines[i]);
			if (m) {
				meta[m[1]] = m[2].trim();
			} else if (lines[i].trim() !== "") {
				bodyLines.push(lines[i]);
			}
			i++;
		}

		entries.push({
			title,
			scope: (meta.scope as MemoryScope) || headerScope,
			source: meta.source || "unknown",
			created: meta.created || "",
			status: meta.status === "candidate" ? "candidate" : "active",
			tags: parseTags(meta.tags),
			body: bodyLines.join("\n").trim() || title,
		});
	}

	return entries;
}

function parseTags(raw?: string): string[] {
	if (!raw) return [];
	return raw
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

/** 序列化一条为结构化小节文本。 */
export function serializeEntry(entry: MemoryEntry): string {
	return [
		`## [${entry.scope}] ${entry.title}`,
		`- scope: ${entry.scope}`,
		`- source: ${entry.source}`,
		`- created: ${entry.created}`,
		`- status: ${entry.status}`,
		`- tags: [${entry.tags.join(", ")}]`,
		"",
		entry.body,
		"",
	].join("\n");
}

// ---------------------------------------------------------------------------
// 读 / 写
// ---------------------------------------------------------------------------

function ensureMemoryFile(cwd: string, scope: MemoryScope): string {
	const dir = memoryDirFor(cwd, scope);
	ensureDir(dir);
	const file = memoryFileFor(cwd, scope);
	if (!existsSync(file)) {
		writeFileSync(file, `# EvoPi ${scope} memory\n\n`, "utf8");
	}
	return file;
}

function readEntries(cwd: string, scope: MemoryScope): MemoryEntry[] {
	const file = memoryFileFor(cwd, scope);
	if (!existsSync(file)) return [];
	return parseMemoryFile(readFileSync(file, "utf8"), scope);
}

/** 读全部 scope 的记忆（project + user；global V1 占位在 user 目录）。 */
function readAllEntries(cwd: string): MemoryEntry[] {
	return [...readEntries(cwd, "project"), ...readEntries(cwd, "user")];
}

function appendEntry(cwd: string, entry: MemoryEntry): string {
	const file = ensureMemoryFile(cwd, entry.scope);
	const existing = readFileSync(file, "utf8");
	const sep = existing.endsWith("\n") ? "" : "\n";
	writeFileSync(file, existing + sep + serializeEntry(entry) + "\n", "utf8");
	return file;
}

// ---------------------------------------------------------------------------
// 检索（关键词 + tags + 时间邻近，本地零 API）
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}_]+/u)
		.filter((t) => t.length >= 2);
}

/**
 * 对一条记忆按 query 打分：词频命中(正文/标题) + tags 命中(加权) + 最近优先(轻微)。
 * 纯本地、可解释（决策 6）。返回 0 表示完全不相关。
 */
export function scoreEntry(entry: MemoryEntry, queryTokens: string[], now: number): number {
	if (queryTokens.length === 0) return 0;
	const haystack = tokenize(`${entry.title}\n${entry.body}`);
	const hay = new Set(haystack);
	const tagSet = new Set(entry.tags.map((t) => t.toLowerCase()));

	let score = 0;
	for (const q of queryTokens) {
		if (hay.has(q)) score += 1;
		if (tagSet.has(q)) score += 2; // tag 命中权重更高
	}
	if (score === 0) return 0;

	// 时间邻近：越新加成越大，最多 +0.5，避免盖过内容相关性。
	const createdMs = Date.parse(entry.created);
	if (Number.isFinite(createdMs)) {
		const ageDays = Math.max(0, (now - createdMs) / 86_400_000);
		score += 0.5 / (1 + ageDays / 30); // 30 天半衰量级
	}
	return score;
}

/** 取与 query 最相关的 Top-K active 记忆（candidate 不参与）。 */
export function retrieveTopK(entries: MemoryEntry[], query: string, now: number, k = TOP_K): MemoryEntry[] {
	const queryTokens = tokenize(query);
	const scored = entries
		.filter((e) => e.status === "active")
		.map((e) => ({ e, s: scoreEntry(e, queryTokens, now) }))
		.filter((x) => x.s > 0)
		.sort((a, b) => b.s - a.s);
	return scored.slice(0, k).map((x) => x.e);
}

/** 从 messages 里取最后一条 user 文本做检索 query。 */
function lastUserText(messages: unknown[]): string {
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

function renderInjection(entries: MemoryEntry[]): string {
	let out = "[EvoPi 项目记忆 · 检索注入]\n以下是与当前请求相关的项目记忆（EvoPi 本地检索，非用户本轮输入）：\n";
	let used = out.length;
	for (const e of entries) {
		const block = `\n- (${e.scope}) ${e.title}: ${e.body}`;
		if (used + block.length > INJECT_MAX_CHARS) break;
		out += block;
		used += block.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// 命令解析
// ---------------------------------------------------------------------------

interface AddArgs {
	scope: MemoryScope;
	text: string;
	tags: string[];
}

function parseAddArgs(raw: string): AddArgs {
	let scope: MemoryScope = "project";
	const tags: string[] = [];
	const words = raw.split(/\s+/);
	const rest: string[] = [];
	for (const w of words) {
		if (w === "--user") scope = "user";
		else if (w === "--global") scope = "global";
		else if (w.startsWith("--tag=")) tags.push(...parseTags(w.slice(6)));
		else rest.push(w);
	}
	return { scope, text: rest.join(" ").trim(), tags };
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export function registerMemory(pi: ExtensionAPI, shared: { recorder: Recorder }): void {
	const { recorder } = shared;

	// --- 检索注入：context 钩子（决策 4/6） ---
	pi.on("context", (event, ctx) => {
		// 先滤掉上一轮注入的 evopi-memory 消息（防叠加），再按当前 query 重新注入。
		const messages = (event.messages ?? []) as JsonRecord[];
		const cleaned = messages.filter((m: JsonRecord) => m.customType !== INJECT_CUSTOM_TYPE);

		const query = lastUserText(cleaned);
		if (!query) return { messages: cleaned };

		const all = readAllEntries(ctx.cwd);
		const top = retrieveTopK(all, query, Date.now());
		if (top.length === 0) return { messages: cleaned };

		recorder.record("memory.retrieve", ctx, {
			query: { length: query.length },
			matched: top.length,
			titles: top.map((e) => e.title).slice(0, TOP_K),
		});

		const injected = {
			customType: INJECT_CUSTOM_TYPE,
			content: renderInjection(top),
			display: false,
		} as unknown as (typeof cleaned)[number];

		// prepend：放在最前，作为背景资料。
		return { messages: [injected, ...cleaned] };
	});

	// --- 压缩前抢救成候选（决策 7） ---
	pi.on("session_before_compact", (event, ctx) => {
		// 抢救一条「压缩发生」的候选，标 candidate（不自动注入），等 /evopi-memory review 确认。
		// V1 只落一条锚点式候选，不做内容抽取（内容抽取=V2）。
		const entry: MemoryEntry = {
			title: `compaction rescue @ ${isoNow()}`,
			scope: "project",
			source: `trace ${recorder.state.traceId}`,
			created: isoNow(),
			status: "candidate",
			tags: ["compaction", "rescue"],
			body:
				`会话在 ${isoNow()} 触发压缩（reason=${event.reason}，willRetry=${event.willRetry}，` +
				`branchEntries=${event.branchEntries.length}）。此为自动抢救候选，请 /evopi-memory review 确认要保留哪些事实。`,
		};
		const path = appendEntry(ctx.cwd, entry);
		// review/候选产生只进 JSONL（非「显式资产产生」，不写 anchor）。
		recorder.record("memory.review", ctx, {
			action: "rescue-candidate",
			path,
			reason: event.reason,
		});
	});

	// --- 命令 ---
	pi.registerCommand("evopi-memory", {
		description: "Manage EvoPi project memory (three scopes, keyword retrieval)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed.startsWith("add ")) {
				const parsed = parseAddArgs(trimmed.slice(4));
				if (!parsed.text) {
					ctx.ui.notify("Usage: /evopi-memory add <fact> [--user|--global] [--tag=a,b]", "warning");
					return;
				}
				const entry: MemoryEntry = {
					title: parsed.text.slice(0, 60),
					scope: parsed.scope,
					source: "用户显式",
					created: isoNow(),
					status: "active", // 显式写直接生效（决策 7）
					tags: parsed.tags,
					body: parsed.text,
				};
				const path = appendEntry(ctx.cwd, entry);
				// 显式 memory.write 是「资产产生」→ 写 session anchor（决策 10）。
				recorder.record(
					"memory.write",
					ctx,
					{ path, scope: parsed.scope, textLength: parsed.text.length, tags: parsed.tags },
					{ anchor: true },
				);
				ctx.ui.notify(`Memory (${parsed.scope}) saved to ${path}`, "info");
				return;
			}

			if (trimmed === "review") {
				const all = readAllEntries(ctx.cwd);
				const candidates = all.filter((e) => e.status === "candidate");
				recorder.record("memory.review", ctx, { action: "list", candidates: candidates.length });
				if (candidates.length === 0) {
					ctx.ui.notify("No candidate memories. (显式 add 的记忆直接 active，无需 review)", "info");
					return;
				}
				const lines = candidates.map(
					(e, idx) => `${idx + 1}. [${e.scope}] ${e.title} (source: ${e.source})`,
				);
				ctx.ui.notify(
					[
						`${candidates.length} candidate memory/memories (来自压缩抢救，需人审):`,
						...lines,
						"",
						"编辑 MEMORY.md 把要保留的候选 status 改为 active，或删掉不要的。",
					].join("\n"),
					"info",
				);
				return;
			}

			// 默认：状态摘要。
			const all = readAllEntries(ctx.cwd);
			const active = all.filter((e) => e.status === "active").length;
			const candidate = all.filter((e) => e.status === "candidate").length;
			ctx.ui.notify(
				[
					`projectMemory: ${memoryFileFor(ctx.cwd, "project")}`,
					`userMemory: ${memoryFileFor(ctx.cwd, "user")}`,
					`entries: ${all.length} (active ${active}, candidate ${candidate})`,
					"",
					"Use: /evopi-memory add <fact> [--user|--global] [--tag=a,b] | review",
				].join("\n"),
				"info",
			);
		},
	});
}

// 供测试/其它模块复用。
export { readAllEntries, appendEntry, memoryFileFor };
