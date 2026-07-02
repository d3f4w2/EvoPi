// scripts/typecheck.mjs — 对 EvoPi 扩展做严格类型检查（strict tsc）。
//
// 为什么不是简单的 `tsc`：EvoPi 扩展用 Pi 的构建配置（jiti/tsx 加载器 + Pi tsconfig 的 paths
// 解析 `@earendil-works/pi-coding-agent`、扩展内部用 extensionless 相对导入）。所以类型检查
// 复用 Pi 参考仓自带的 tsc + Pi 的 tsconfig，只挑出 evopi-trace 自己的报错（Pi 仓库本身的
// 无关告警忽略）。这与实现期「借 pi/node_modules 的 tsc、strict 0 错」的做法一致。
//
// 依赖：本地存在 D:\evopi\pi 参考仓且已 `npm install`（见 README「从零复现」）。不存在 → 优雅跳过（退出 0），
// 因为 CI 的强制门禁是 `npm test`（自洽、不依赖 pi/），类型检查是本地/完整校验的加分项。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const piDir = join(root, "pi");
const tsc = process.platform === "win32" ? join(piDir, "node_modules", ".bin", "tsc.cmd") : join(piDir, "node_modules", ".bin", "tsc");
const tsconfig = join(piDir, "tsconfig.json");

if (!existsSync(tsc) || !existsSync(tsconfig)) {
	console.log("⏭  跳过类型检查：未找到 pi/ 参考仓的 tsc（见 README「从零复现」先 clone + npm install 参考仓）。");
	console.log("   注：强制质量门禁是 `npm test`（49 断言，跑真实模块，无需 pi/）。");
	process.exit(0);
}

console.log("→ 用 Pi 参考仓的 strict tsc 检查 .pi/extensions/evopi-trace/ …");
const res = spawnSync(tsc, ["--project", tsconfig, "--noEmit"], { cwd: root, encoding: "utf8" });
const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

// 只关心 evopi-trace 的报错（Pi 仓库自身的无关告警不计）。
const ours = out
	.split(/\r?\n/)
	.filter((l) => l.includes("evopi-trace") && /error TS\d+/.test(l));

if (ours.length > 0) {
	console.log("✗ EvoPi 扩展类型检查发现错误：");
	for (const l of ours) console.log(`  ${l}`);
	process.exit(1);
}

console.log("✓ EvoPi 扩展 strict 类型检查 0 错。");
process.exit(0);
