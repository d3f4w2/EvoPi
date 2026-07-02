// demo/demo-cost.mts — 「上下文成本」可视化 demo。
//
// 驱动真实出货代码：`cost.ts` 的 computeCacheHitRate + pressureBand。
// 展示 EvoPi 怎么把 provider 返回的 usage 翻成「命中率 / 上下文压力档位」——
// 这就是 /evopi-cost 面板背后的口径，也是 e2e 里真跑智谱 glm-4-flash 抓到的那类 usage。

import { computeCacheHitRate, pressureBand } from "../.pi/extensions/evopi-trace/cost.ts";

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║  EvoPi 上下文成本 demo（驱动真实 computeCacheHitRate/pressureBand） ║");
console.log("╚══════════════════════════════════════════════════════════════╝");

console.log("\n① 缓存命中率口径 = cacheRead / (cacheRead + input)");
console.log("─".repeat(64));
console.log("  一次典型多轮对话里，随着系统提示 + 历史被 Anthropic 缓存复用：");
const samples = [
	{ round: "第 1 轮（冷启动，全未命中）", input: 8000, cacheRead: 0 },
	{ round: "第 2 轮（系统提示已缓存）", input: 1200, cacheRead: 8000 },
	{ round: "第 5 轮（长历史大量复用）", input: 900, cacheRead: 28000 },
];
for (const s of samples) {
	const usage = { input: s.input, output: 0, cacheRead: s.cacheRead, cacheWrite: 0 };
	const rate = computeCacheHitRate(usage);
	console.log(`  ${s.round.padEnd(26)} input=${String(s.input).padStart(6)}  cacheRead=${String(s.cacheRead).padStart(6)}  → 命中率 ${pct(rate)}`);
}
console.log("  （命中率越高＝越省钱：缓存读比全价输入便宜得多）");

console.log("\n② 上下文压力分档（128k 窗口为例，跨 80/90/95% 各告警一次）");
console.log("─".repeat(64));
const windowTokens = 128000;
const points = [8, 40000, 104000, 116000, 122000];
for (const tokens of points) {
	const percent = Math.round((tokens / windowTokens) * 1000) / 10;
	console.log(`  用了 ${String(tokens).padStart(6)} / ${windowTokens} tokens  →  ${pressureBand(percent)}`);
}
console.log("  （EvoPi 首次跨 80%/90%/95% 各弹一次 cost.pressure，不每轮刷；回落后允许再报）");

console.log("\n要点：");
console.log("  · 命中率/压力口径写死在 cost.ts，一处定义、/evopi-cost 面板与本 demo 同源；");
console.log("  · e2e 真跑智谱 glm-4-flash 时，cost.request 抓到真实 provider usage（tokens:8），");
console.log("    证明这条链路不是模拟——真实 usage 进 JSONL，可被 SQLite/看板下游消费。\n");
