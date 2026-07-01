// eval.ts — 模块 6 · 评测协作（Eval Collaboration Harness）。V1 最后一个核心模块。
// 契约：06-评测协作机制.md（决策 2 确定性评分优先、决策 3 真 spawn 子代理、决策 4 agent card、
// 决策 5 golden task YAML、决策 6 退出码 echo $? + 绑 id、决策 7 棘轮半自动、决策 8 eval.* 事件与 anchor）。
//
// 本模块铁律（就近约定）：
//   1. **确定性评分优先**（决策 2）：command/file_changed/output_contains/no_forbidden 客观检查主力；
//      LLM 评分只留接口默认不开。评分不猜——解析失败记 invalid 不给假分（决策 4）。
//   2. **真 spawn 子进程**（决策 3）：spawn `pi --mode json -p --no-session [--model][--tools]`，
//      监听 message_end 计 turn、超 maxTurns kill（参考 Pi subagent 示例，不 vendor）。
//   3. **退出码 echo $?**（决策 6）：command check 跑 `<cmd>; echo EXIT:$?` 从输出解析，不依赖 Pi 把退出码藏异常。
//   4. **棘轮半自动**（决策 7）：候选→安全扫描(复用 policy)→replay 全量 golden task→baseline vs candidate→
//      **人拍板 enable**（不降即可，全自动留 V2）。绑 traceId+taskId+datasetId 可追溯。
//   5. **事件/anchor**（决策 8）：eval.gate（门禁裁决）+ eval.candidate（产生 task）写 session anchor；
//      eval.score/run/replay 只进 JSONL。eval.gate enable 是资产被接受时刻（闭环 skill.accepted）。

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type JsonRecord, type Recorder, ensureDir, getEvoPiDir, isoNow } from "./trace";
import { loadPolicy, scanDangerousText } from "./policy";
import { loadAgentCard, spawnEvalAgent } from "./subagent";

// ---------------------------------------------------------------------------
// Golden task 结构（决策 5）
// ---------------------------------------------------------------------------

export type CheckSpec =
	| { type: "command"; run: string; expect?: "exit_zero" | "exit_nonzero" }
	| { type: "file_changed"; path: string }
	| { type: "output_contains"; marker: string }
	| { type: "no_forbidden"; paths: string[] };

export interface GoldenTask {
	id: string;
	description?: string;
	prompt: string;
	checks: CheckSpec[];
	scoring: "all_checks_pass" | "weighted";
}

export interface CheckResult {
	type: string;
	passed: boolean;
	detail: string;
}

export interface EvalResult {
	evalId: string;
	taskId: string;
	traceId: string;
	datasetId: string;
	score: number; // 0..1
	passed: boolean;
	checkResults: CheckResult[];
	timestamp: string;
	invalid?: boolean; // 解析/执行失败=无效评分（不猜，决策 4）
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function evalsDir(cwd: string): string {
	return join(getEvoPiDir(cwd), "evals");
}
function tasksDir(cwd: string): string {
	return join(evalsDir(cwd), "tasks");
}
function runsFile(cwd: string): string {
	return join(evalsDir(cwd), "runs.jsonl");
}

// ---------------------------------------------------------------------------
// 极简 YAML 解析（golden task：扁平 scalar + `checks:` 下的 `- {k: v, ...}` 内联列表）
// 不引运行时 YAML 依赖，与 skill.ts frontmatter 同哲学（自包含、够用）。
// ---------------------------------------------------------------------------

export function parseGoldenTask(text: string): GoldenTask | undefined {
	const lines = text.split(/\r?\n/);
	const top: Record<string, string> = {};
	const checks: CheckSpec[] = [];
	let inChecks = false;

	for (const raw of lines) {
		const line = raw.replace(/\s+#.*$/, ""); // 去行尾注释（简化：# 前需空白）
		if (!line.trim()) continue;

		if (/^checks:\s*$/.test(line)) {
			inChecks = true;
			continue;
		}
		if (inChecks && /^\s*-\s*\{/.test(line)) {
			const check = parseInlineCheck(line);
			if (check) checks.push(check);
			continue;
		}
		// 顶层 key: value（缩进 0）
		const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
		if (m && !line.startsWith(" ")) {
			inChecks = false;
			top[m[1]] = stripQuotes(m[2].trim());
		}
	}

	if (!top.id || !top.prompt) return undefined;
	const scoring = top.scoring === "weighted" ? "weighted" : "all_checks_pass";
	return {
		id: top.id,
		description: top.description,
		prompt: top.prompt,
		checks,
		scoring,
	};
}

function stripQuotes(v: string): string {
	return v.replace(/^["']|["']$/g, "");
}

/** 解析 `- { type: command, run: "npm test", expect: exit_zero }` 这类内联对象。 */
function parseInlineCheck(line: string): CheckSpec | undefined {
	const inner = line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
	const obj: Record<string, string> = {};
	// 按逗号切，但保护引号内的逗号
	const parts = splitTopLevel(inner);
	for (const p of parts) {
		const idx = p.indexOf(":");
		if (idx === -1) continue;
		const k = p.slice(0, idx).trim();
		const v = stripQuotes(p.slice(idx + 1).trim());
		obj[k] = v;
	}
	switch (obj.type) {
		case "command":
			return { type: "command", run: obj.run ?? "", expect: obj.expect === "exit_nonzero" ? "exit_nonzero" : "exit_zero" };
		case "file_changed":
			return { type: "file_changed", path: obj.path ?? "" };
		case "output_contains":
			return { type: "output_contains", marker: obj.marker ?? "" };
		case "no_forbidden": {
			// paths: [".env", "package.json"] —— 从原行抓方括号
			const arr = /\[([^\]]*)\]/.exec(line);
			const paths = arr ? arr[1].split(",").map((s) => stripQuotes(s.trim())).filter(Boolean) : [];
			return { type: "no_forbidden", paths };
		}
		default:
			return undefined;
	}
}

function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote = "";
	let cur = "";
	for (const ch of s) {
		if (quote) {
			if (ch === quote) quote = "";
			cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
		} else if (ch === "[" || ch === "{") {
			depth++;
			cur += ch;
		} else if (ch === "]" || ch === "}") {
			depth--;
			cur += ch;
		} else if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim()) out.push(cur);
	return out;
}

export function loadGoldenTask(cwd: string, taskId: string): GoldenTask | undefined {
	const file = join(tasksDir(cwd), `${taskId}.yaml`);
	if (!existsSync(file)) return undefined;
	try {
		return parseGoldenTask(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

export function listGoldenTasks(cwd: string): string[] {
	const dir = tasksDir(cwd);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".yaml"))
			.map((f) => f.replace(/\.yaml$/, ""));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// 确定性检查执行（决策 2/6）——主力评分，可离线可重复
// ---------------------------------------------------------------------------

export interface RunContext {
	cwd: string;
	/** 子代理产出的 stdout/文本（output_contains 用）。 */
	output?: string;
	/** exec：跑一条命令返回 {exitCode, stdout}。默认用 execSync；测试可注入。 */
	exec?: (command: string, cwd: string) => { exitCode: number; stdout: string };
	/** 文件是否被改动（file_changed 用）；默认用 git diff。测试可注入。 */
	fileChanged?: (path: string, cwd: string) => boolean;
}

function defaultExec(command: string, cwd: string): { exitCode: number; stdout: string } {
	// 决策 6：`<cmd>; echo EXIT:$?` 可靠取退出码（不依赖 Pi 把退出码藏异常）。
	// 用 POSIX shell（sh）保证 `$?` 语义跨平台一致——EvoPi 目标是 bash/sh 可用的开发环境
	// （项目全程用 Git Bash）；cmd.exe 下 `$?` 不展开，故显式指定 shell。
	const wrapped = `${command}; echo EXIT:$?`;
	try {
		const stdout = execSync(wrapped, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: "sh" });
		return parseExit(stdout);
	} catch (e) {
		// execSync 抛错：① 命令自身 `exit N` 会让 wrapper shell 直接以 N 退出、echo 没跑到
		//   → 用 error.status（真实退出码）兜底；② 有 stdout 就优先解析 EXIT: 标记。
		const err = e as { stdout?: Buffer | string; status?: number | null };
		const stdout = err.stdout ? String(err.stdout) : "";
		const parsed = parseExit(stdout);
		if (/EXIT:\d+/.test(stdout)) return parsed; // echo 跑到了，标记可信
		const code = typeof err.status === "number" ? err.status : parsed.exitCode || 1;
		return { exitCode: code, stdout: parsed.stdout };
	}
}

function parseExit(stdout: string): { exitCode: number; stdout: string } {
	const m = /EXIT:(\d+)\s*$/.exec(stdout.trim());
	if (!m) return { exitCode: 0, stdout };
	const code = Number(m[1]);
	const clean = stdout.replace(/EXIT:\d+\s*$/, "").trimEnd();
	return { exitCode: code, stdout: clean };
}

function defaultFileChanged(path: string, cwd: string): boolean {
	try {
		const out = execSync(`git status --porcelain -- ${JSON.stringify(path)}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

/** 跑一个 check，返回结果。 */
export function runCheck(check: CheckSpec, rc: RunContext): CheckResult {
	const exec = rc.exec ?? defaultExec;
	const fileChanged = rc.fileChanged ?? defaultFileChanged;
	switch (check.type) {
		case "command": {
			const { exitCode, stdout } = exec(check.run, rc.cwd);
			const wantZero = (check.expect ?? "exit_zero") === "exit_zero";
			const passed = wantZero ? exitCode === 0 : exitCode !== 0;
			return { type: "command", passed, detail: `\`${check.run}\` exit=${exitCode} (want ${wantZero ? "0" : "!=0"})${stdout ? ` out=${stdout.slice(0, 80)}` : ""}` };
		}
		case "file_changed": {
			const passed = fileChanged(check.path, rc.cwd);
			return { type: "file_changed", passed, detail: `${check.path} ${passed ? "changed" : "unchanged"}` };
		}
		case "output_contains": {
			const passed = (rc.output ?? "").includes(check.marker);
			return { type: "output_contains", passed, detail: `marker "${check.marker}" ${passed ? "found" : "missing"}` };
		}
		case "no_forbidden": {
			const touched = check.paths.filter((p) => fileChanged(p, rc.cwd));
			const passed = touched.length === 0;
			return { type: "no_forbidden", passed, detail: passed ? "no forbidden path touched" : `touched: ${touched.join(", ")}` };
		}
	}
}

/** 对 golden task 的所有 check 打分（决策 5：默认 all_checks_pass 二值；weighted 平均）。 */
export function scoreTask(task: GoldenTask, rc: RunContext): { score: number; passed: boolean; checkResults: CheckResult[] } {
	const checkResults = task.checks.map((c) => runCheck(c, rc));
	if (checkResults.length === 0) return { score: 0, passed: false, checkResults };
	const passedCount = checkResults.filter((r) => r.passed).length;
	if (task.scoring === "weighted") {
		const score = passedCount / checkResults.length;
		return { score, passed: score >= 1, checkResults };
	}
	const allPass = passedCount === checkResults.length;
	return { score: allPass ? 1 : 0, passed: allPass, checkResults };
}

// 子代理 spawn（决策 3）+ agent card 在 subagent.ts（拆出控文件行数）。

// ---------------------------------------------------------------------------
// 记录 / 棘轮门禁
// ---------------------------------------------------------------------------

function appendRun(cwd: string, result: EvalResult): string {
	ensureDir(evalsDir(cwd));
	const file = runsFile(cwd);
	appendFileSync(file, `${JSON.stringify(result)}\n`, "utf8");
	return file;
}

/** 读某 task 的历史最佳分（棘轮 baseline，决策 7）。 */
export function baselineFor(cwd: string, taskId: string): number | undefined {
	const file = runsFile(cwd);
	if (!existsSync(file)) return undefined;
	let best: number | undefined;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as EvalResult;
			if (r.taskId === taskId && !r.invalid && (best === undefined || r.score > best)) best = r.score;
		} catch {
			/* skip */
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export function registerEval(pi: ExtensionAPI, shared: { recorder: Recorder }): void {
	const { recorder } = shared;

	function makeResult(task: GoldenTask, s: { score: number; passed: boolean; checkResults: CheckResult[] }): EvalResult {
		return {
			evalId: `eval_${Date.now().toString(36)}`,
			taskId: task.id,
			traceId: recorder.state.traceId,
			datasetId: "default",
			score: s.score,
			passed: s.passed,
			checkResults: s.checkResults,
			timestamp: isoNow(),
		};
	}

	pi.registerCommand("evopi-eval", {
		description: "EvoPi eval: 确定性评分 / golden task / 棘轮门禁",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// --- record <name> <score> [notes]（保留 MVP）---
			if (trimmed.startsWith("record ")) {
				const parts = trimmed.slice(7).trim().split(/\s+/);
				const name = parts[0];
				const score = Number(parts[1]);
				if (!name || !Number.isFinite(score)) {
					ctx.ui.notify("Usage: /evopi-eval record <name> <score> [notes]", "warning");
					return;
				}
				const result: EvalResult = {
					evalId: `eval_${Date.now().toString(36)}`,
					taskId: name,
					traceId: recorder.state.traceId,
					datasetId: "manual",
					score,
					passed: score >= 1,
					checkResults: [],
					timestamp: isoNow(),
				};
				const file = appendRun(ctx.cwd, result);
				recorder.record("eval.score", ctx, result as unknown as JsonRecord);
				ctx.ui.notify(`Eval recorded in ${file}`, "info");
				return;
			}

			// --- run <task>：跑 golden task 的确定性 check（V1 默认不 spawn，除非 --spawn <agent>）---
			if (trimmed.startsWith("run ")) {
				const rest = trimmed.slice(4).trim().split(/\s+/);
				const taskId = rest[0];
				const task = loadGoldenTask(ctx.cwd, taskId);
				if (!task) {
					ctx.ui.notify(`No golden task: ${taskId}（放 .pi/evopi/evals/tasks/${taskId}.yaml）`, "warning");
					return;
				}
				// V1：确定性 check 直接在当前 cwd 跑（子代理 spawn 是 --spawn 显式开，见下）。
				let output: string | undefined;
				const spawnIdx = rest.indexOf("--spawn");
				if (spawnIdx !== -1) {
					const agentName = rest[spawnIdx + 1];
					const card = (agentName && loadAgentCard(ctx.cwd, agentName)) || { name: agentName ?? "eval-scorer" };
					ctx.ui.notify(`spawning eval agent '${card.name}'…（需 pi 可执行 + 模型）`, "info");
					try {
						const runResult = await spawnEvalAgent(task.prompt, card, ctx.cwd, { timeoutMs: 120000 });
						output = runResult.output;
						if (runResult.killedForBudget) ctx.ui.notify(`（子代理超 maxTurns=${card.maxTurns} 被 kill）`, "warning");
					} catch (e) {
						ctx.ui.notify(`spawn 失败: ${String(e instanceof Error ? e.message : e)}`, "warning");
					}
				}
				const s = scoreTask(task, { cwd: ctx.cwd, output });
				const result = makeResult(task, s);
				appendRun(ctx.cwd, result);
				recorder.record("eval.run", ctx, { taskId: task.id, score: s.score, passed: s.passed, checks: s.checkResults.length });
				ctx.ui.notify(
					[
						`task ${task.id}: ${s.passed ? "PASS" : "FAIL"} (score ${s.score.toFixed(2)})`,
						...s.checkResults.map((r) => `  ${r.passed ? "✓" : "✗"} ${r.type}: ${r.detail}`),
					].join("\n"),
					s.passed ? "info" : "warning",
				);
				return;
			}

			// --- replay <task>：棘轮 replay（决策 7）——跑 task，对比 baseline，展示不裁决 ---
			if (trimmed.startsWith("replay ")) {
				const taskId = trimmed.slice(7).trim();
				const task = loadGoldenTask(ctx.cwd, taskId);
				if (!task) {
					ctx.ui.notify(`No golden task: ${taskId}`, "warning");
					return;
				}
				const baseline = baselineFor(ctx.cwd, taskId);
				const s = scoreTask(task, { cwd: ctx.cwd });
				const result = makeResult(task, s);
				appendRun(ctx.cwd, result);
				recorder.record("eval.replay", ctx, { taskId: task.id, score: s.score, baseline: baseline ?? null });
				const verdict =
					baseline === undefined
						? "无 baseline（首次）"
						: s.score >= baseline
							? `不降（candidate ${s.score.toFixed(2)} ≥ baseline ${baseline.toFixed(2)}）✓ 可 gate`
							: `⬇ 退步（candidate ${s.score.toFixed(2)} < baseline ${baseline.toFixed(2)}）✗ 不应 enable`;
				ctx.ui.notify(
					[`replay ${task.id}:`, `  candidate score: ${s.score.toFixed(2)}`, `  baseline: ${baseline?.toFixed(2) ?? "n/a"}`, `  ${verdict}`, "", "确认启用: /evopi-eval gate " + taskId + " enable"].join("\n"),
					"info",
				);
				return;
			}

			// --- gate <task> <enable|reject>：门禁裁决（决策 7/8，人拍板，写 anchor）---
			if (trimmed.startsWith("gate ")) {
				const parts = trimmed.slice(5).trim().split(/\s+/);
				const taskId = parts[0];
				const decision = parts[1];
				if (!taskId || (decision !== "enable" && decision !== "reject")) {
					ctx.ui.notify("Usage: /evopi-eval gate <task> <enable|reject>", "warning");
					return;
				}
				const baseline = baselineFor(ctx.cwd, taskId);
				// gate 是治理裁决 → 写 session anchor（决策 8）。enable 即资产被接受时刻（闭环 skill.accepted）。
				recorder.record("eval.gate", ctx, { taskId, decision, baseline: baseline ?? null, approvedBy: "user" }, { anchor: true });
				ctx.ui.notify(
					decision === "enable"
						? `✅ gate ${taskId} enable —— 候选被接受（此即 skill.accepted / 记忆生效的闭环点）。`
						: `⛔ gate ${taskId} reject —— 候选被拒绝。`,
					"info",
				);
				return;
			}

			// --- candidate <task-from-trace>：从失败 trace 生成 golden task 候选（决策 5，写 anchor）---
			if (trimmed.startsWith("candidate ")) {
				const taskId = trimmed.slice("candidate ".length).trim();
				if (!taskId) {
					ctx.ui.notify("Usage: /evopi-eval candidate <taskId>", "warning");
					return;
				}
				// 危险扫描（复用 policy，决策 7）——候选内容不应含危险动作。
				const policy = loadPolicy(ctx.cwd);
				const hits = scanDangerousText(taskId, policy);
				// 生成一个空壳 golden task 供人补全（真实内容从失败 trace 提取是 V1+，此处落骨架）。
				ensureDir(tasksDir(ctx.cwd));
				const file = join(tasksDir(ctx.cwd), `${taskId}.yaml`);
				if (!existsSync(file)) {
					writeFileSync(
						file,
						[
							`id: ${taskId}`,
							`description: 从失败 trace ${recorder.state.traceId} 生成的候选（待人补全）`,
							`prompt: TODO 描述要复现/防回归的任务`,
							`checks:`,
							`  - { type: command, run: "echo TODO", expect: exit_zero }`,
							`scoring: all_checks_pass`,
							"",
						].join("\n"),
						"utf8",
					);
				}
				// candidate 产生新资产 → 写 session anchor（决策 8）。
				recorder.record("eval.candidate", ctx, { taskId, sourceTrace: recorder.state.traceId, dangerHits: hits.length }, { anchor: true });
				ctx.ui.notify(`golden task 候选骨架已建: ${file}（请补全 prompt/checks 后 /evopi-eval run ${taskId}）`, "info");
				return;
			}

			// --- 默认：列 task + 最近 runs ---
			const tasks = listGoldenTasks(ctx.cwd);
			const rf = runsFile(ctx.cwd);
			const runCount = existsSync(rf) ? readFileSync(rf, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
			ctx.ui.notify(
				[
					`tasksDir: ${tasksDir(ctx.cwd)}`,
					`golden tasks (${tasks.length}): ${tasks.join(", ") || "（空）"}`,
					`eval runs: ${runCount}`,
					"",
					"Use: run <task> [--spawn <agent>] | replay <task> | gate <task> <enable|reject> | candidate <task> | record <name> <score>",
				].join("\n"),
				"info",
			);
		},
	});
}

// 供测试复用。
export { defaultExec, parseExit, appendRun, runsFile, tasksDir };
