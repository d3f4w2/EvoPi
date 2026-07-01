// demo/demo-guardrail.mts — 「治理准入」可视化 demo。
//
// 驱动的是**真实出货代码**：`job.ts` 的 classifyRisk + `policy.ts` 的共享黑名单。
// 打印每个 tool_call 会被判什么风险、为什么、无 UI 时会不会被 fail-safe 拦下。
// 这就是决定「rm -rf 会不会弹确认 / 无人值守时会不会被挡」的那段真码。
//
// 跑法：`npx tsx demo/demo-guardrail.mts`（或 `node scripts/... ` 见 demo/README.md）。

import { classifyRisk } from "../.pi/extensions/evopi-trace/job.ts";
import { DEFAULT_POLICY } from "../.pi/extensions/evopi-trace/policy.ts";

interface Case {
	label: string;
	toolName: string;
	input: Record<string, unknown>;
}

// 一组有代表性的 tool_call（只读 / 变更 / 高危命令 / 写受保护路径）。
const cases: Case[] = [
	{ label: "列目录", toolName: "bash", input: { command: "ls -la src/" } },
	{ label: "看 git 状态", toolName: "bash", input: { command: "git status" } },
	{ label: "跑测试", toolName: "bash", input: { command: "npm test" } },
	{ label: "改业务源码", toolName: "write", input: { path: "src/index.ts" } },
	{ label: "☠ 递归删除", toolName: "bash", input: { command: "rm -rf /" } },
	{ label: "☠ 强推覆盖远端", toolName: "bash", input: { command: "git push --force origin main" } },
	{ label: "☠ 发布到 npm", toolName: "bash", input: { command: "npm publish --access public" } },
	{ label: "☠ 写 .env 密钥", toolName: "write", input: { path: ".env" } },
	{ label: "☠ 动 .git 内部", toolName: "edit", input: { path: ".git/config" } },
];

// EvoPi 的准入规则（对照 job.ts 的 Policy Gate）：
//   low    → 放行，不打扰、不记 policy.check
//   medium → 放行 + 写前打 checkpoint（可回退）
//   high   → 弹 confirm 审批；**无 UI（如 CI / 无人值守）时一律 block**（fail-safe，安全优先）
function gateAction(level: string, hasUI: boolean): string {
	if (level === "low") return "✅ 放行";
	if (level === "medium") return "✅ 放行 + 打 checkpoint（可回退）";
	// high
	return hasUI ? "⚠️  弹确认，等人拍板" : "⛔ BLOCK（无 UI fail-safe）";
}

function icon(level: string): string {
	return level === "high" ? "🔴" : level === "medium" ? "🟡" : "🟢";
}

function pad(s: string, n: number): string {
	// 中文按 2 宽估算，粗略对齐
	let w = 0;
	for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
	return s + " ".repeat(Math.max(0, n - w));
}

function render(hasUI: boolean): void {
	console.log(`\n▌场景：hasUI = ${hasUI}  （${hasUI ? "交互式，有终端 UI 可弹确认" : "无人值守 / CI，没有 UI"}）`);
	console.log("─".repeat(78));
	console.log(`${pad("  动作", 20)}${pad("风险", 10)}${pad("EvoPi 的处置", 34)}判据（真码给的 reason）`);
	console.log("─".repeat(78));
	for (const c of cases) {
		const j = classifyRisk(c.toolName, c.input as never, DEFAULT_POLICY);
		console.log(`${pad("  " + c.label, 20)}${pad(icon(j.level) + " " + j.level, 10)}${pad(gateAction(j.level, hasUI), 34)}${j.reason}`);
	}
}

console.log("╔══════════════════════════════════════════════════════════════════════════╗");
console.log("║  EvoPi 执行治理 · Policy Gate demo（驱动真实 classifyRisk + 共享 policy）   ║");
console.log("╚══════════════════════════════════════════════════════════════════════════╝");

render(true); // 交互式：高危弹确认
render(false); // 无人值守：高危一律 block（fail-safe）

console.log("\n要点：");
console.log("  · 只读命令（ls/git status）零打扰，不刷 trace；");
console.log("  · 变更类（写源码）放行但**先打 checkpoint**，出事可回退；");
console.log("  · 高危（rm -rf / force-push / npm publish / 写 .env·.git）交互下**弹确认**；");
console.log("  · 同样的高危动作，在**无 UI（CI/无人值守）下一律 BLOCK**——安全 > 便利，fail-safe。");
console.log("  · 危险判据全部来自**同一份 policy**（policy.ts），模块 3/4/5 共用，不各造黑名单。\n");
