// skill.ts — 模块 3 · Skill 层（技能治理）。
// 契约：03-技能记忆机制.md（决策 3 扩展 SKILL.md、决策 4/5 resources_discover 按 trust 过滤、
// 决策 8 trust 四级、决策 9 危险扫描复用 policy、决策 10 skill.* 事件与 anchor）。
//
// 本模块铁律（就近约定）：
//   1. **扩展 Pi 的 SKILL.md**：治理字段(trust/source/evidence/approved_by/rollback)塞 frontmatter 额外键；
//      Pi 照常加载、EvoPi 读这些字段治理。技能本体在 .pi/evopi/skills/<name>/SKILL.md（目录名==name）。
//   2. **resources_discover additive → 只返回 trusted 的路径**：candidate/untrusted/blocked 不返回=不加载进上下文
//      （查证：resources_discover 只能加，不能删 Pi 默认 skill，故治理 skill 单独放 .pi/evopi/skills/）。
//   3. **危险扫描复用 policy.ts**（决策 9）：扫 SKILL.md 正文命中黑名单/受保护路径 → 建议/落 blocked，不各造黑名单。
//   4. **V1 统计只采集不决策**（决策 7）：从 tool_call 采集 skill 被 read 的次数/成败，写 skill.invoke/outcome，
//      为 V2 棘轮铺数据。Pi 里 skill 靠 read 其 SKILL.md 加载，故用 read 命中 skill 路径作调用信号。
//   5. **事件/anchor**（决策 10）：skill.approved 写 session anchor（审批=语义锁点）；
//      skill.invoke/outcome/filtered/blocked 只进 JSONL。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type JsonRecord, type Recorder, getEvoPiDir } from "./trace";
import { type PolicyConfig, type PolicyHit, loadPolicy, scanDangerousText } from "./policy";

export type SkillTrust = "trusted" | "candidate" | "untrusted" | "blocked";

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	trust?: SkillTrust;
	source?: string;
	evidence?: string;
	approved_by?: string | null;
	rollback?: string;
}

export interface GovernedSkill {
	name: string;
	dir: string;
	file: string; // SKILL.md 绝对路径
	frontmatter: SkillFrontmatter;
	body: string;
	trust: SkillTrust;
	dangerHits: PolicyHit[];
}

function skillsDir(cwd: string): string {
	return join(getEvoPiDir(cwd), "skills");
}

// ---------------------------------------------------------------------------
// 极简 frontmatter 解析（SKILL.md frontmatter 是扁平 key: value；避免耦合 Pi 内部导出）
// ---------------------------------------------------------------------------

export function parseSkillMd(raw: string): { frontmatter: SkillFrontmatter; body: string } {
	const normalized = raw.replace(/^﻿/, "");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: normalized };
	const yaml = normalized.slice(3, end);
	const body = normalized.slice(end + 4).replace(/^\r?\n/, "");

	const fm: SkillFrontmatter = {};
	for (const line of yaml.split(/\r?\n/)) {
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1];
		let value: string | null = m[2].trim();
		// 去引号
		value = value.replace(/^["']|["']$/g, "");
		if (value === "null" || value === "") value = value === "null" ? null : value;
		switch (key) {
			case "name":
				fm.name = value ?? undefined;
				break;
			case "description":
				fm.description = value ?? undefined;
				break;
			case "trust":
				fm.trust = normalizeTrust(value);
				break;
			case "source":
				fm.source = value ?? undefined;
				break;
			case "evidence":
				fm.evidence = value ?? undefined;
				break;
			case "approved_by":
				fm.approved_by = value;
				break;
			case "rollback":
				fm.rollback = value ?? undefined;
				break;
		}
	}
	return { frontmatter: fm, body };
}

function normalizeTrust(v: string | null): SkillTrust | undefined {
	if (v === "trusted" || v === "candidate" || v === "untrusted" || v === "blocked") return v;
	return undefined;
}

// ---------------------------------------------------------------------------
// 加载治理 skill + 决定有效 trust
// ---------------------------------------------------------------------------

/**
 * 决定一个 skill 的有效 trust：
 *   - 危险扫描命中 → 一律 blocked（决策 9，安全优先，覆盖 frontmatter 声明）。
 *   - 否则用 frontmatter.trust；缺省 → candidate（保守：来源不明按候选，不自动可见）。
 */
function effectiveTrust(fm: SkillFrontmatter, dangerHits: PolicyHit[]): SkillTrust {
	if (dangerHits.length > 0) return "blocked";
	return fm.trust ?? "candidate";
}

export function loadGovernedSkills(cwd: string, policy: PolicyConfig): GovernedSkill[] {
	const dir = skillsDir(cwd);
	if (!existsSync(dir)) return [];
	const out: GovernedSkill[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	for (const name of names) {
		const subdir = join(dir, name);
		let isDir = false;
		try {
			isDir = statSync(subdir).isDirectory();
		} catch {
			isDir = false;
		}
		if (!isDir) continue;
		const file = join(subdir, "SKILL.md");
		if (!existsSync(file)) continue;
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseSkillMd(raw);
		const dangerHits = scanDangerousText(body, policy);
		out.push({
			name: frontmatter.name || name,
			dir: subdir,
			file,
			frontmatter,
			body,
			trust: effectiveTrust(frontmatter, dangerHits),
			dangerHits,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// 写回 trust（approve/block 命令用）——只改 frontmatter 的 trust/approved_by，保留其它
// ---------------------------------------------------------------------------

function setTrust(file: string, trust: SkillTrust, approvedBy?: string): boolean {
	if (!existsSync(file)) return false;
	const raw = readFileSync(file, "utf8");
	const { body } = parseSkillMd(raw);
	const normalized = raw.replace(/^﻿/, "");
	if (!normalized.startsWith("---")) return false;
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return false;
	const yaml = normalized.slice(3, end);

	const lines = yaml.split(/\r?\n/);
	let sawTrust = false;
	let sawApprovedBy = false;
	const newLines = lines.map((line) => {
		if (/^trust:/.test(line)) {
			sawTrust = true;
			return `trust: ${trust}`;
		}
		if (/^approved_by:/.test(line)) {
			sawApprovedBy = true;
			return `approved_by: ${approvedBy ?? "null"}`;
		}
		return line;
	});
	if (!sawTrust) newLines.push(`trust: ${trust}`);
	if (!sawApprovedBy && approvedBy) newLines.push(`approved_by: ${approvedBy}`);

	const rebuilt = `---\n${newLines.join("\n").replace(/^\n+|\n+$/g, "")}\n---\n${body}`;
	writeFileSync(file, rebuilt, "utf8");
	return true;
}

// ---------------------------------------------------------------------------
// 统计（V1 采集不用）——skill 被 read 加载视为一次 invoke
// ---------------------------------------------------------------------------

interface SkillStat {
	invokes: number;
	errors: number;
	lastUsedAt?: string;
}

/** 从 tool 输入里抽出所有字符串值，用于匹配 skill 文件路径。 */
function collectStringValues(input: unknown, acc: string[], depth = 0): void {
	if (depth > 4 || input == null) return;
	if (typeof input === "string") {
		acc.push(input);
		return;
	}
	if (Array.isArray(input)) {
		for (const v of input) collectStringValues(v, acc, depth + 1);
		return;
	}
	if (typeof input === "object") {
		for (const v of Object.values(input as JsonRecord)) collectStringValues(v, acc, depth + 1);
	}
}

/** 判断一次 tool_call 是否在读某个治理 skill 的 SKILL.md；返回命中的 skill name。 */
function matchSkillInvocation(input: unknown, skills: GovernedSkill[]): GovernedSkill | undefined {
	const strings: string[] = [];
	collectStringValues(input, strings);
	if (strings.length === 0) return undefined;
	const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
	for (const s of skills) {
		const target = norm(s.file);
		if (strings.some((v) => norm(v).includes(target))) return s;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export function registerSkill(pi: ExtensionAPI, shared: { recorder: Recorder }): void {
	const { recorder } = shared;
	const stats = new Map<string, SkillStat>();
	// 记住上一次 discover 时的 skill 集合（用于 tool_call 命中判断），随 discover 刷新。
	let knownSkills: GovernedSkill[] = [];
	// tool_call → 记录本次调用命中的 skill（供 tool_result 归因 outcome）。
	const invocationByCallId = new Map<string, string>();

	// --- resources_discover：只把 trusted 的 skill 交给 Pi 加载（决策 4/5/8） ---
	pi.on("resources_discover", (_event, ctx) => {
		const policy = loadPolicy(ctx.cwd);
		const skills = loadGovernedSkills(ctx.cwd, policy);
		knownSkills = skills;

		const trusted = skills.filter((s) => s.trust === "trusted");
		const filtered = skills.filter((s) => s.trust !== "trusted");

		// 被过滤掉的（candidate/untrusted/blocked）记一条 skill.filtered（只进 JSONL）。
		if (filtered.length > 0) {
			recorder.record("skill.filtered", ctx, {
				filtered: filtered.map((s) => ({ name: s.name, trust: s.trust, dangerHits: s.dangerHits.length })),
				loaded: trusted.map((s) => s.name),
			});
		}

		// 返回 trusted skill 的目录路径（resource-loader 会在目录里找 SKILL.md）。
		return { skillPaths: trusted.map((s) => s.dir) };
	});

	// --- 统计采集：skill 被 read 加载 = 一次 invoke（决策 7，V1 采集不用） ---
	pi.on("tool_call", (event, ctx) => {
		if (knownSkills.length === 0) return;
		const hit = matchSkillInvocation(event.input, knownSkills);
		if (!hit) return;
		const stat = stats.get(hit.name) ?? { invokes: 0, errors: 0 };
		stat.invokes += 1;
		stat.lastUsedAt = new Date().toISOString();
		stats.set(hit.name, stat);
		invocationByCallId.set(event.toolCallId, hit.name);
		recorder.record("skill.invoke", ctx, { skill: hit.name, trust: hit.trust, toolCallId: event.toolCallId });
	});

	pi.on("tool_result", (event, ctx) => {
		const skillName = invocationByCallId.get(event.toolCallId);
		if (!skillName) return;
		invocationByCallId.delete(event.toolCallId);
		if (event.isError) {
			const stat = stats.get(skillName) ?? { invokes: 0, errors: 0 };
			stat.errors += 1;
			stats.set(skillName, stat);
		}
		recorder.record("skill.outcome", ctx, { skill: skillName, isError: event.isError });
	});

	// --- 命令 ---
	pi.registerCommand("evopi-skill", {
		description: "Manage EvoPi governed skills (trust 分级 / 审批 / 危险扫描)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const policy = loadPolicy(ctx.cwd);
			const skills = loadGovernedSkills(ctx.cwd, policy);

			if (trimmed === "review") {
				const pending = skills.filter((s) => s.trust !== "trusted");
				if (pending.length === 0) {
					ctx.ui.notify("No skills需要 review（全部 trusted，或 .pi/evopi/skills/ 为空）。", "info");
					return;
				}
				const lines = pending.map((s) => {
					const danger = s.dangerHits.length
						? ` ⚠️危险命中: ${s.dangerHits.map((h) => `${h.kind}:${h.pattern}`).join(", ")}`
						: "";
					return `- ${s.name} [${s.trust}] source=${s.frontmatter.source ?? "?"}${danger}`;
				});
				ctx.ui.notify(
					[
						`${pending.length} skill(s) 待审:`,
						...lines,
						"",
						"审批: /evopi-skill approve <name> | block <name>",
						"（命中危险动作的会被强制 blocked，approve 也不会放行，需先移除危险内容）",
					].join("\n"),
					"info",
				);
				return;
			}

			if (trimmed.startsWith("approve ")) {
				const name = trimmed.slice(8).trim();
				const skill = skills.find((s) => s.name === name);
				if (!skill) {
					ctx.ui.notify(`No such governed skill: ${name}`, "warning");
					return;
				}
				if (skill.dangerHits.length > 0) {
					// 命中危险的不允许 approve（决策 9：命中黑名单强制 blocked）。
					recorder.record("skill.blocked", ctx, {
						skill: name,
						reason: "danger-scan",
						dangerHits: skill.dangerHits,
					});
					ctx.ui.notify(
						`拒绝 approve：${name} 命中危险动作 ${skill.dangerHits
							.map((h) => h.pattern)
							.join(", ")}，已保持 blocked。先移除危险内容再审。`,
						"warning",
					);
					return;
				}
				const okWrite = setTrust(skill.file, "trusted", "user");
				if (!okWrite) {
					ctx.ui.notify(`写回 trust 失败（frontmatter 缺失?）: ${skill.file}`, "warning");
					return;
				}
				// 审批=资产接受，写 session anchor（决策 10）。
				recorder.record("skill.approved", ctx, { skill: name, approvedBy: "user" }, { anchor: true });
				ctx.ui.notify(`Approved skill '${name}' → trusted（下次会话加载生效）。`, "info");
				return;
			}

			if (trimmed.startsWith("block ")) {
				const name = trimmed.slice(6).trim();
				const skill = skills.find((s) => s.name === name);
				if (!skill) {
					ctx.ui.notify(`No such governed skill: ${name}`, "warning");
					return;
				}
				setTrust(skill.file, "blocked");
				recorder.record("skill.blocked", ctx, { skill: name, reason: "manual" }, { anchor: true });
				ctx.ui.notify(`Blocked skill '${name}' → 永不加载。`, "info");
				return;
			}

			// 默认：列表 + trust + 统计。
			if (skills.length === 0) {
				ctx.ui.notify(
					[
						`skillsDir: ${skillsDir(ctx.cwd)}`,
						"（空）放置治理 skill: .pi/evopi/skills/<name>/SKILL.md，frontmatter 加 trust: trusted|candidate|...",
						"",
						"Use: /evopi-skill review | approve <name> | block <name>",
					].join("\n"),
					"info",
				);
				return;
			}
			const lines = skills.map((s) => {
				const st = stats.get(s.name);
				const usage = st ? ` used=${st.invokes} err=${st.errors}` : "";
				const danger = s.dangerHits.length ? " ⚠️danger" : "";
				return `- ${s.name} [${s.trust}]${danger}${usage}`;
			});
			ctx.ui.notify(
				[
					`skillsDir: ${skillsDir(ctx.cwd)}`,
					`${skills.length} governed skill(s):`,
					...lines,
					"",
					"Use: /evopi-skill review | approve <name> | block <name>",
				].join("\n"),
				"info",
			);
		},
	});
}

// 供测试复用。
export { skillsDir, setTrust, effectiveTrust, matchSkillInvocation };
