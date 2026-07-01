#!/usr/bin/env node
/**
 * EvoPi 防失忆 · SessionStart hook
 * 把「实现进度」的关键几节注入上下文——只注入「当前进行中 + 冻结约定 + 待办指针」，
 * 不注入全文（进度表 200+ 行，全注入费 token，违背控-token 目标）。
 * 纯 Node、无第三方依赖、跨平台。读 stdin 的 hook JSON（消费掉即可）。
 * 输出 hookSpecificOutput.additionalContext（注入模型上下文）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROGRESS = resolve(process.cwd(), "docs/evopi-v1/impl/进度.md");

/** 抓取标题包含 headings 里任一关键词的 ##~#### 小节，直到下一个同级/更高级标题。 */
function extractSections(md, headings) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let capturing = false;
  let capLevel = 0;
  for (const line of lines) {
    const m = /^(#{2,4})\s+(.*)$/.exec(line);
    if (m) {
      const level = m[1].length;
      const title = m[2].trim();
      if (capturing && level <= capLevel) capturing = false;
      if (!capturing && headings.some((h) => title.includes(h))) {
        capturing = true;
        capLevel = level;
      }
    }
    if (capturing) out.push(line);
  }
  return out.join("\n").trim();
}

// 消费 stdin（SessionStart 负载用不到，但要读掉避免管道阻塞）
let _raw = "";
try {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) _raw += chunk;
} catch {
  /* stdin 可选 */
}

let context;
try {
  const md = readFileSync(PROGRESS, "utf8");
  const picked = extractSections(md, ["冻结的全局约定", "待办指针"]);
  const current = md
    .split(/\r?\n/)
    .filter((l) => l.includes("🔄") || l.includes("👉"))
    .join("\n")
    .trim();
  context =
    "【EvoPi 实现进度 · 防失忆注入】\n" +
    "以下摘自 docs/evopi-v1/impl/进度.md（实现阶段单一事实源）。开工前先对齐" +
    "「当前进行中」与「冻结约定」；完整进度请读该文件。\n\n" +
    (current ? "## 当前进行中 / 待办\n" + current + "\n\n" : "") +
    picked;
} catch (e) {
  context =
    "【EvoPi 防失忆】未能读取 docs/evopi-v1/impl/进度.md（" +
    String(e && e.message) +
    "）。请手动打开进度表后再开工。";
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
