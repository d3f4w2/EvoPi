// tests/harness.ts — 极简零依赖测试框架。
//
// 为什么不引 jest/vitest：EvoPi 扩展本身零运行时依赖（自包含 YAML 解析、自包含策略引擎），
// 测试也保持同一哲学——只借 Pi 参考仓已有的 `tsx` 当 TS 运行器，不新增任何 devDependency。
// 这样 `npm test` 在任何机器上「装好 pi/ 依赖 → 直接跑」，不受测试框架版本漂移影响。
//
// 用法：各 *.test.ts 顶部 `import { describe, it, eq, ok, throws, truthy } from "./harness";`
// 断言即注册；`run.ts` 汇总并按失败数设置退出码（CI 门禁靠这个非零退出）。

interface TestCase {
	suite: string;
	name: string;
	fn: () => void;
}

const cases: TestCase[] = [];
let currentSuite = "(root)";

/** 声明一个测试分组。 */
export function describe(suite: string, body: () => void): void {
	const prev = currentSuite;
	currentSuite = suite;
	body();
	currentSuite = prev;
}

/** 声明一个测试用例（同步；断言失败即抛）。 */
export function it(name: string, fn: () => void): void {
	cases.push({ suite: currentSuite, name, fn });
}

class AssertionError extends Error {}

/** 深相等断言（结构化比较，适合对象/数组）。 */
export function eq(actual: unknown, expected: unknown, msg?: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new AssertionError(`${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
	}
}

/** 严格 `===` 断言（适合标量/引用）。 */
export function ok<T>(actual: T, expected: T, msg?: string): void {
	if (actual !== expected) {
		throw new AssertionError(`${msg ? msg + ": " : ""}expected ${String(expected)}, got ${String(actual)}`);
	}
}

/** 真值断言。 */
export function truthy(actual: unknown, msg?: string): void {
	if (!actual) {
		throw new AssertionError(`${msg ? msg + ": " : ""}expected truthy, got ${String(actual)}`);
	}
}

/** 断言 fn 抛错（可选校验错误信息子串）。 */
export function throws(fn: () => void, contains?: string): void {
	let threw = false;
	try {
		fn();
	} catch (e) {
		threw = true;
		if (contains && !(e instanceof Error && e.message.includes(contains))) {
			throw new AssertionError(`threw but message missing "${contains}": ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (!threw) throw new AssertionError(`expected throw${contains ? ` containing "${contains}"` : ""}, but did not throw`);
}

export interface RunSummary {
	total: number;
	passed: number;
	failed: number;
	failures: { suite: string; name: string; error: string }[];
}

/** 跑完所有已注册用例，打印结果，返回汇总（调用方据 failed 设退出码）。 */
export function runAll(): RunSummary {
	const summary: RunSummary = { total: cases.length, passed: 0, failed: 0, failures: [] };
	let lastSuite = "";
	for (const c of cases) {
		if (c.suite !== lastSuite) {
			console.log(`\n${c.suite}`);
			lastSuite = c.suite;
		}
		try {
			c.fn();
			summary.passed++;
			console.log(`  ✓ ${c.name}`);
		} catch (e) {
			summary.failed++;
			const error = e instanceof Error ? e.message : String(e);
			summary.failures.push({ suite: c.suite, name: c.name, error });
			console.log(`  ✗ ${c.name}`);
			console.log(`      ${error}`);
		}
	}
	return summary;
}
