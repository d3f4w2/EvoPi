// tests/run.ts — 测试入口。import 各 *.test.ts（副作用即注册用例）→ 汇总 → 按失败数设退出码。
//
// 跑法：`npm test`（= tsx tests/run.ts，tsx 借自 pi/ 参考仓，见 package.json 与 README）。
// CI（.github/workflows/ci.yml）也跑这个：failed>0 → 退出 1 → 红叉。

import "./policy.test";
import "./eval.test";
import "./cost.test";
import "./trace.test";
import { runAll } from "./harness";

const summary = runAll();

console.log("\n" + "─".repeat(48));
console.log(`合计 ${summary.total} 个断言：${summary.passed} 通过，${summary.failed} 失败`);

if (summary.failed > 0) {
	console.log("\n失败明细：");
	for (const f of summary.failures) {
		console.log(`  · [${f.suite}] ${f.name}\n    ${f.error}`);
	}
	process.exit(1);
}

console.log("全部通过 ✓");
process.exit(0);
