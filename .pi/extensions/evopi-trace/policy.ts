// policy.ts — 模块 3/4/5 共享的策略单一事实源。
// 契约：结构冻结见 04-执行治理机制.md 决策 4（`.pi/evopi/policy.json`）。
//
// 本模块铁律（就近约定）：
//   1. **单一事实源**：危险动作黑名单 + 受保护路径 + 测试命令识别只在这里定义一次。
//      模块 3 静态扫 skill 文本、模块 4 运行时扫 tool_call、模块 5 工具禁区，全读这一份，**不各造黑名单**。
//   2. **结构冻结**：`dangerousCommands` / `protectedPaths` / `testCommandPatterns` 三键以 04 决策 4 为准。
//      加键向后兼容；改名/删键要记进度表变更日志。
//   3. **保守默认**：`.pi/evopi/policy.json` 缺失时用内置默认（总能拦高危），不因为没配置就放开。
//
// V1 只提供「加载 + 文本/命令/路径匹配原语」；运行时拦截/审批逻辑在模块 4/5 各自的文件里调用这些原语。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEvoPiDir } from "./trace";

export interface PolicyConfig {
	/** 危险命令子串（大小写不敏感匹配 tool 输入/skill 文本）。 */
	dangerousCommands: string[];
	/** 受保护路径子串（写入命中即高危）。 */
	protectedPaths: string[];
	/** 测试命令识别模式（模块 4 验收/模块 6 评分用；此处仅共享定义）。 */
	testCommandPatterns: string[];
}

/**
 * 内置默认（04 决策 4 冻结结构）。policy.json 缺失或字段缺失时兜底——保守默认：总能拦高危。
 */
export const DEFAULT_POLICY: PolicyConfig = {
	dangerousCommands: ["rm -rf", "git reset --hard", "git push --force", "git push -f", "curl|sh", "curl | sh", "npm publish"],
	protectedPaths: [".git/", ".env", "secrets/", "~/.ssh/", "id_rsa"],
	testCommandPatterns: ["npm test", "pytest", "go test", "cargo test", "vitest", "jest"],
};

export function getPolicyFile(cwd: string): string {
	return join(getEvoPiDir(cwd), "policy.json");
}

/**
 * 加载共享 policy。读 `.pi/evopi/policy.json`，与默认**合并**（缺的键用默认补，坏 JSON 退默认）。
 * 合并而非替换：即使用户 policy.json 只想覆盖一个键，其它键仍有保守默认，不会因为漏写而放开高危。
 */
export function loadPolicy(cwd: string): PolicyConfig {
	const file = getPolicyFile(cwd);
	if (!existsSync(file)) return { ...DEFAULT_POLICY };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PolicyConfig>;
		return {
			dangerousCommands: dedupeStrings(DEFAULT_POLICY.dangerousCommands, raw.dangerousCommands),
			protectedPaths: dedupeStrings(DEFAULT_POLICY.protectedPaths, raw.protectedPaths),
			testCommandPatterns: dedupeStrings(DEFAULT_POLICY.testCommandPatterns, raw.testCommandPatterns),
		};
	} catch {
		// 坏 JSON 不静默放开——退回全默认（保守）。
		return { ...DEFAULT_POLICY };
	}
}

function dedupeStrings(base: string[], extra: unknown): string[] {
	const out = [...base];
	if (Array.isArray(extra)) {
		for (const item of extra) {
			if (typeof item === "string" && item && !out.includes(item)) out.push(item);
		}
	}
	return out;
}

/** 命中详情：命中了哪条规则、哪类。 */
export interface PolicyHit {
	kind: "command" | "path";
	pattern: string;
}

/**
 * 扫描一段文本（skill 正文 / tool 命令行）里是否含危险命令或受保护路径。
 * 大小写不敏感的子串匹配——启发式，故意宽（漏判比误放行更该避免）。
 * 模块 3 静态扫 skill、模块 4/5 运行时扫 tool_call 都调它，判据一致。
 */
export function scanDangerousText(text: string, policy: PolicyConfig): PolicyHit[] {
	const hits: PolicyHit[] = [];
	const lower = text.toLowerCase();
	for (const cmd of policy.dangerousCommands) {
		if (cmd && lower.includes(cmd.toLowerCase())) hits.push({ kind: "command", pattern: cmd });
	}
	for (const path of policy.protectedPaths) {
		if (path && lower.includes(path.toLowerCase())) hits.push({ kind: "path", pattern: path });
	}
	return hits;
}

/** 单命令是否命中危险黑名单（模块 4/5 运行时用；此处提供原语）。 */
export function matchDangerousCommand(command: string, policy: PolicyConfig): string | undefined {
	const lower = command.toLowerCase();
	return policy.dangerousCommands.find((c) => c && lower.includes(c.toLowerCase()));
}

/** 写入路径是否命中受保护路径（模块 4/5 运行时用；此处提供原语）。 */
export function matchProtectedPath(path: string, policy: PolicyConfig): string | undefined {
	const lower = path.toLowerCase();
	return policy.protectedPaths.find((p) => p && lower.includes(p.toLowerCase()));
}
