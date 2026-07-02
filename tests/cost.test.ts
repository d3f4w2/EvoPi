// tests/cost.test.ts — 上下文成本内核：缓存命中率口径 + 压力分档阈值。
//
// computeCacheHitRate / pressureBand 是模块 2 的纯算法核心（无副作用），
// 断言真实出货函数（含除零兜底、档位边界）。

import { computeCacheHitRate, pressureBand } from "../.pi/extensions/evopi-trace/cost";
import { describe, it, ok } from "./harness";

// ProviderUsage 只用到 input/output/cacheRead/cacheWrite 四个数字字段。
function usage(input: number, cacheRead: number): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	return { input, output: 0, cacheRead, cacheWrite: 0 };
}

describe("cost · computeCacheHitRate（cacheRead / (cacheRead + input)）", () => {
	it("全命中：input 0, cacheRead 100 → 1.0", () => {
		ok(computeCacheHitRate(usage(0, 100)), 1);
	});
	it("全未命中：input 100, cacheRead 0 → 0", () => {
		ok(computeCacheHitRate(usage(100, 0)), 0);
	});
	it("半命中：input 50, cacheRead 50 → 0.5", () => {
		ok(computeCacheHitRate(usage(50, 50)), 0.5);
	});
	it("除零兜底：input 0, cacheRead 0 → 0（不 NaN）", () => {
		ok(computeCacheHitRate(usage(0, 0)), 0);
	});
	it("四分之三命中：input 25, cacheRead 75 → 0.75", () => {
		ok(computeCacheHitRate(usage(25, 75)), 0.75);
	});
});

describe("cost · pressureBand（80/90/95 三档阈值）", () => {
	it("< 80 → ok", () => {
		ok(pressureBand(0), "0% (ok)");
		ok(pressureBand(79), "79% (ok)");
	});
	it(">= 80 → warning（边界值）", () => {
		ok(pressureBand(80), "80% (warning)");
		ok(pressureBand(89), "89% (warning)");
	});
	it(">= 90 → high（边界值）", () => {
		ok(pressureBand(90), "90% (high)");
		ok(pressureBand(94), "94% (high)");
	});
	it(">= 95 → critical（边界值）", () => {
		ok(pressureBand(95), "95% (critical)");
		ok(pressureBand(100), "100% (critical)");
	});
});
