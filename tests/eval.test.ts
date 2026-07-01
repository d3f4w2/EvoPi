// tests/eval.test.ts — 评测协作的确定性内核：golden task 解析 + 打分。
//
// 断言真实出货函数 parseGoldenTask / runCheck / scoreTask。
// runCheck 支持注入 exec / fileChanged（生产代码本就为可测性做了依赖注入），
// 故这里能**不 shell out** 地确定性验证四类 check 与两种评分口径。

import {
	parseGoldenTask,
	runCheck,
	scoreTask,
	type CheckSpec,
	type GoldenTask,
	type RunContext,
} from "../.pi/extensions/evopi-trace/eval";
import { describe, it, eq, ok, truthy } from "./harness";

// 一个受控 RunContext 工厂：命令退出码、文件是否改动、output 全可注入。
function rc(over: Partial<RunContext> = {}): RunContext {
	return {
		cwd: "/fake",
		exec: (cmd: string) => ({ exitCode: cmd.includes("FAIL") ? 1 : 0, stdout: `ran ${cmd}` }),
		fileChanged: () => false,
		output: "",
		...over,
	};
}

describe("eval · parseGoldenTask（自包含极简 YAML）", () => {
	const yaml = [
		"id: fix-bug",
		'description: "修一个 off-by-one"',
		'prompt: "把 loop 的边界改对"',
		"scoring: all_checks_pass",
		"checks:",
		'  - { type: command, run: "npm test", expect: exit_zero }',
		'  - { type: file_changed, path: "src/loop.ts" }',
		'  - { type: output_contains, marker: "DONE" }',
		'  - { type: no_forbidden, paths: [".env", ".git/"] }',
	].join("\n");

	it("顶层字段解析正确", () => {
		const t = parseGoldenTask(yaml) as GoldenTask;
		truthy(t, "解析成功");
		ok(t.id, "fix-bug");
		ok(t.prompt, "把 loop 的边界改对");
		ok(t.scoring, "all_checks_pass");
	});

	it("四类 check 全部解析", () => {
		const t = parseGoldenTask(yaml) as GoldenTask;
		ok(t.checks.length, 4);
		const cmd = t.checks[0] as Extract<CheckSpec, { type: "command" }>;
		ok(cmd.type, "command");
		ok(cmd.run, "npm test");
		ok(cmd.expect, "exit_zero");
		const fc = t.checks[1] as Extract<CheckSpec, { type: "file_changed" }>;
		ok(fc.path, "src/loop.ts");
		const oc = t.checks[2] as Extract<CheckSpec, { type: "output_contains" }>;
		ok(oc.marker, "DONE");
		const nf = t.checks[3] as Extract<CheckSpec, { type: "no_forbidden" }>;
		eq(nf.paths, [".env", ".git/"]);
	});

	it("缺 id 或 prompt → 判无效（返回 undefined，评分不猜）", () => {
		ok(parseGoldenTask("prompt: hi\nchecks:"), undefined);
		ok(parseGoldenTask("id: x\nchecks:"), undefined);
	});

	it("scoring 缺省为 all_checks_pass", () => {
		const t = parseGoldenTask('id: a\nprompt: "b"') as GoldenTask;
		ok(t.scoring, "all_checks_pass");
	});
});

describe("eval · runCheck（四类 check 确定性行为）", () => {
	it("command：退出码 0 且 expect exit_zero → pass", () => {
		const r = runCheck({ type: "command", run: "npm test", expect: "exit_zero" }, rc());
		ok(r.passed, true);
	});
	it("command：退出码非 0 且 expect exit_zero → fail", () => {
		const r = runCheck({ type: "command", run: "npm test FAIL", expect: "exit_zero" }, rc());
		ok(r.passed, false);
	});
	it("command：expect exit_nonzero 时反过来（失败命令算 pass）", () => {
		const r = runCheck({ type: "command", run: "grep FAIL", expect: "exit_nonzero" }, rc());
		ok(r.passed, true);
	});
	it("file_changed：注入 changed=true → pass", () => {
		const r = runCheck({ type: "file_changed", path: "a.ts" }, rc({ fileChanged: () => true }));
		ok(r.passed, true);
	});
	it("output_contains：output 含 marker → pass，不含 → fail", () => {
		ok(runCheck({ type: "output_contains", marker: "OK" }, rc({ output: "all OK here" })).passed, true);
		ok(runCheck({ type: "output_contains", marker: "OK" }, rc({ output: "nope" })).passed, false);
	});
	it("no_forbidden：碰了禁区路径 → fail，没碰 → pass", () => {
		const touched = runCheck({ type: "no_forbidden", paths: [".env"] }, rc({ fileChanged: (p) => p === ".env" }));
		ok(touched.passed, false);
		const clean = runCheck({ type: "no_forbidden", paths: [".env"] }, rc({ fileChanged: () => false }));
		ok(clean.passed, true);
	});
});

describe("eval · scoreTask（决策 5：all_checks_pass 二值 / weighted 平均）", () => {
	const twoChecks: CheckSpec[] = [
		{ type: "command", run: "pass1", expect: "exit_zero" },
		{ type: "command", run: "FAIL2", expect: "exit_zero" },
	];

	it("all_checks_pass：一个 check 挂 → score 0、passed false", () => {
		const task: GoldenTask = { id: "t", prompt: "p", checks: twoChecks, scoring: "all_checks_pass" };
		const s = scoreTask(task, rc());
		ok(s.score, 0);
		ok(s.passed, false);
	});

	it("all_checks_pass：全过 → score 1、passed true", () => {
		const task: GoldenTask = {
			id: "t",
			prompt: "p",
			checks: [{ type: "command", run: "ok", expect: "exit_zero" }],
			scoring: "all_checks_pass",
		};
		const s = scoreTask(task, rc());
		ok(s.score, 1);
		ok(s.passed, true);
	});

	it("weighted：两个 check 过一个 → score 0.5、passed false（未满分不算过）", () => {
		const task: GoldenTask = { id: "t", prompt: "p", checks: twoChecks, scoring: "weighted" };
		const s = scoreTask(task, rc());
		ok(s.score, 0.5);
		ok(s.passed, false);
	});

	it("空 check 列表 → score 0、passed false（不猜）", () => {
		const task: GoldenTask = { id: "t", prompt: "p", checks: [], scoring: "all_checks_pass" };
		const s = scoreTask(task, rc());
		ok(s.score, 0);
		ok(s.passed, false);
	});
});
