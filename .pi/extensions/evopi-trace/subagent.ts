// subagent.ts — 模块 6 的子代理执行层（从 eval.ts 拆出，控 ~500 行/文件）。
// 职责：agent card 解析 + 真 spawn `pi --mode json` 子进程跑评估 prompt + JSON 事件流解析。
// 契约：06-评测协作机制.md 决策 3（真 spawn，参考 Pi subagent 不 vendor）、决策 4（maxTurns 预算）。
//
// 本模块铁律（就近约定）：
//   - **真 spawn 子进程**：spawn `pi --mode json -p --no-session [--model][--tools]`，监听 message_end 计 turn。
//   - **turn 预算**：超 card.maxTurns 就 kill（决策 4）。piCommand/piArgsPrefix 可注入（测试用 stub 进程）。
//   - 评分/棘轮/命令在 eval.ts；本文件只管「怎么跑一个评估子代理」。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type JsonRecord, getEvoPiDir } from "./trace";

export interface AgentCard {
	name: string;
	description?: string;
	tools?: string[];
	model?: string;
	maxTurns?: number;
	systemPrompt?: string;
}

export interface SubagentRun {
	output: string;
	turns: number;
	exitCode: number;
	killedForBudget: boolean;
	stderr: string;
}

function agentsDir(cwd: string): string {
	return join(getEvoPiDir(cwd), "agents");
}

function stripQuotes(v: string): string {
	return v.replace(/^["']|["']$/g, "");
}

export function loadAgentCard(cwd: string, name: string): AgentCard | undefined {
	const file = join(agentsDir(cwd), `${name}.md`);
	if (!existsSync(file)) return undefined;
	try {
		return parseAgentCard(readFileSync(file, "utf8"), name);
	} catch {
		return undefined;
	}
}

/** 解析 agent card（复用 Pi frontmatter + EvoPi 扩展 maxTurns，决策 4）。 */
export function parseAgentCard(raw: string, fallbackName: string): AgentCard {
	const normalized = raw.replace(/^﻿/, "");
	const card: AgentCard = { name: fallbackName };
	if (!normalized.startsWith("---")) return { ...card, systemPrompt: normalized.trim() || undefined };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { ...card, systemPrompt: normalized.trim() || undefined };
	const yaml = normalized.slice(3, end);
	card.systemPrompt = normalized.slice(end + 4).replace(/^\r?\n/, "").trim() || undefined;
	for (const line of yaml.split(/\r?\n/)) {
		const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		const v = stripQuotes(m[2].trim());
		switch (m[1]) {
			case "name":
				card.name = v || fallbackName;
				break;
			case "description":
				card.description = v;
				break;
			case "model":
				card.model = v;
				break;
			case "tools":
				card.tools = v.split(",").map((s) => s.trim()).filter(Boolean);
				break;
			case "maxTurns":
				card.maxTurns = Number.isFinite(Number(v)) ? Number(v) : undefined;
				break;
		}
	}
	return card;
}

/**
 * spawn `pi --mode json -p --no-session` 跑 prompt，监听 message_end 计 turn、超 maxTurns kill。
 * 参考 Pi subagent 示例（不 vendor）。piCommand/piArgsPrefix 可注入（测试用 stub 进程）。
 */
export function spawnEvalAgent(
	prompt: string,
	card: AgentCard,
	cwd: string,
	opts?: { piCommand?: string; piArgsPrefix?: string[]; timeoutMs?: number },
): Promise<SubagentRun> {
	const command = opts?.piCommand ?? "pi";
	const args = [...(opts?.piArgsPrefix ?? []), "--mode", "json", "-p", "--no-session"];
	if (card.model) args.push("--model", card.model);
	if (card.tools && card.tools.length > 0) args.push("--tools", card.tools.join(","));
	const full = card.systemPrompt ? `${card.systemPrompt}\n\nTask: ${prompt}` : `Task: ${prompt}`;
	args.push(full);

	return new Promise<SubagentRun>((resolve) => {
		const run: SubagentRun = { output: "", turns: 0, exitCode: 0, killedForBudget: false, stderr: "" };
		let buffer = "";
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			run.exitCode = 1;
			run.stderr = String(e instanceof Error ? e.message : e);
			resolve(run);
			return;
		}

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: JsonRecord;
			try {
				event = JSON.parse(line) as JsonRecord;
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message as JsonRecord;
				if (msg.role === "assistant") {
					run.turns += 1;
					// 收集 assistant 文本作为 output（output_contains 用）。
					const content = msg.content;
					if (typeof content === "string") run.output += content;
					else if (Array.isArray(content)) {
						for (const c of content) {
							if (c && typeof c === "object" && (c as JsonRecord).type === "text") run.output += String((c as JsonRecord).text ?? "");
						}
					}
					// turn 预算（决策 4）：超 maxTurns kill。
					if (card.maxTurns && run.turns >= card.maxTurns) {
						run.killedForBudget = true;
						proc.kill("SIGTERM");
					}
				}
			}
		};

		proc.stdout?.on("data", (d: Buffer) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const l of lines) processLine(l);
		});
		proc.stderr?.on("data", (d: Buffer) => {
			run.stderr += d.toString();
		});
		proc.on("close", (code: number | null) => {
			if (buffer.trim()) processLine(buffer);
			run.exitCode = code ?? 0;
			resolve(run);
		});
		proc.on("error", (e: Error) => {
			run.exitCode = 1;
			run.stderr += String(e.message);
			resolve(run);
		});

		if (opts?.timeoutMs) {
			setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
			}, opts.timeoutMs);
		}
	});
}
