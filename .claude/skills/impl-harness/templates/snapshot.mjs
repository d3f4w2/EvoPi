#!/usr/bin/env node
/**
 * Impl harness - PreCompact hook (anti-amnesia, black-box snapshot)
 * Before compaction, APPEND "timestamp + git status + recent changes" to a
 * snapshot file under the data dir. Append-only, no semantic interpretation,
 * NEVER touches the progress table -> therefore always safe.
 * Purpose: after a long session gets compacted, you can still recover from disk
 * "what was in flight at compaction time". Semantic progress updates (ticking
 * checkboxes) are done by the human/agent, not outsourced to this hook.
 *
 * Usage: copy into the project hook dir; edit SNAPSHOT_DIR_REL to a gitignored
 * data directory.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// <- gitignored data dir for black-box snapshots
const SNAPSHOT_DIR_REL = ".data/handoff";

const CWD = process.cwd();
const DIR = resolve(CWD, SNAPSHOT_DIR_REL);

// consume stdin (PreCompact payload carries trigger=manual/auto; read to label)
let raw = "";
try {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  /* ignore */
}
let trigger = "unknown";
try {
  const j = JSON.parse(raw || "{}");
  trigger = j.trigger || j.hook_event_name || "unknown";
} catch {
  /* non-JSON, ignore */
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
  "# Snapshot " + new Date().toISOString() + " (trigger: " + trigger + ")\n\n" +
  "## git status --short\n```\n" + (status || "(clean)") + "\n```\n\n" +
  "## uncommitted diff --stat\n```\n" + (diffstat || "(none)") + "\n```\n\n" +
  "## last 5 commits\n```\n" + (recent || "(none)") + "\n```\n\n" +
  "> Black-box snapshot, no semantic progress. Source of truth is the progress table.\n";

let msg = "";
try {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(resolve(DIR, stamp + ".md"), body, "utf8");
  msg = "Impl harness: wrote pre-compact snapshot " + SNAPSHOT_DIR_REL + "/" + stamp + ".md";
} catch (e) {
  msg = "Impl harness snapshot failed: " + String(e && e.message);
}

process.stdout.write(JSON.stringify({ systemMessage: msg, suppressOutput: true }));
