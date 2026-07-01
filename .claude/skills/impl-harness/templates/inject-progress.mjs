#!/usr/bin/env node
/**
 * Impl harness - SessionStart hook (anti-amnesia, inject side)
 * Inject only the key sections of the implementation progress table into a new
 * session: "current WIP + frozen conventions + next-step pointer" (not the whole
 * file, to save tokens). Pure Node, no deps, cross-platform.
 *
 * Usage: copy into the project hook dir (a NON-gitignored location); edit
 * PROGRESS_REL below to point at your progress table.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// <- set to your progress table path, relative to project root
const PROGRESS_REL = "docs/impl/进度.md";
// <- heading keywords to inject (headings ##~#### containing these are captured)
const SECTION_KEYWORDS = ["冻结的全局约定", "待办指针"];
// <- markers that flag the "current WIP" line (pulled out and shown on top)
const CURRENT_MARKERS = ["\u{1F504}", "\u{1F449}"];

const PROGRESS = resolve(process.cwd(), PROGRESS_REL);

/** Capture ##~#### sections whose heading contains any keyword, until the next same/higher heading. */
function extractSections(md, keywords) {
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
      if (!capturing && keywords.some((k) => title.includes(k))) {
        capturing = true;
        capLevel = level;
      }
    }
    if (capturing) out.push(line);
  }
  return out.join("\n").trim();
}

// consume stdin (payload unused, but drain it to avoid pipe stalls)
let _raw = "";
try {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) _raw += chunk;
} catch {
  /* stdin optional */
}

let context;
try {
  const md = readFileSync(PROGRESS, "utf8");
  const picked = extractSections(md, SECTION_KEYWORDS);
  const current = md
    .split(/\r?\n/)
    .filter((l) => CURRENT_MARKERS.some((mk) => l.includes(mk)))
    .join("\n")
    .trim();
  context =
    "[Impl progress - anti-amnesia inject]\n" +
    "Excerpt from " + PROGRESS_REL + " (single source of truth for impl). " +
    "Align with current WIP and frozen conventions before starting; read the file for full progress.\n\n" +
    (current ? "## Current WIP / next\n" + current + "\n\n" : "") +
    picked;
} catch (e) {
  context =
    "[Anti-amnesia] Failed to read " + PROGRESS_REL + " (" + String(e && e.message) +
    "). Open the progress table manually before starting.";
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
