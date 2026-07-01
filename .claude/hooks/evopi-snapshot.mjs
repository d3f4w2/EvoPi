#!/usr/bin/env node
/**
 * EvoPi 防失忆 · PreCompact hook（黑匣子快照）
 * 压缩前把「时间戳 + git 状态 + 未提交 diff 统计 + 最近提交」追加到
 * .pi/evopi/handoff/<UTC时间>.md。只追加、不解释语义、绝不改进度表——所以绝对安全。
 * 目的：长会话被压缩后，仍能从磁盘翻出“压缩那一刻做到哪了”的黑匣子。
 * 语义化的进度更新（勾 checkbox）由 Claude 手动做，不外包给 hook。
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const CWD = process.cwd();
const DIR = resolve(CWD, ".pi/evopi/handoff");

// 消费 stdin（PreCompact 负载含 trigger=manual/auto，读来标注）
let raw = "";
try {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  /* 忽略 */
}
let trigger = "unknown";
try {
  const j = JSON.parse(raw || "{}");
  trigger = j.trigger || j.hook_event_name || "unknown";
} catch {
  /* 非 JSON 忽略 */
}

function sh(cmd) {
  try {
    return execSync(cmd, {
      cwd: CWD,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const status = sh("git status --short");
const recent = sh("git log --oneline -5");
const diffstat = sh("git diff --stat");

const body =
  "\n---\n" +
  "# 快照 " + new Date().toISOString() + "（触发：" + trigger + "）\n\n" +
  "## git status --short\n```\n" + (status || "(工作区干净)") + "\n```\n\n" +
  "## 未提交 diff --stat\n```\n" + (diffstat || "(无)") + "\n```\n\n" +
  "## 最近 5 次提交\n```\n" + (recent || "(无)") + "\n```\n\n" +
  "> 黑匣子快照，不含语义进度。当前实现进度以 docs/evopi-v1/impl/进度.md 为准。\n";

let msg = "";
try {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(resolve(DIR, stamp + ".md"), body, "utf8");
  msg = "EvoPi：已落压缩前黑匣子快照 .pi/evopi/handoff/" + stamp + ".md";
} catch (e) {
  msg = "EvoPi 快照失败：" + String(e && e.message);
}

process.stdout.write(JSON.stringify({ systemMessage: msg, suppressOutput: true }));
