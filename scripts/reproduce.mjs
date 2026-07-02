// scripts/reproduce.mjs — 「从零复现」一键入口（跨平台，Node ≥ 18）。
//
// 目标：一条命令把这个项目从零验证一遍。分两段，诚实区分「需不需要密钥」：
//
//   A. 离线验证（永远能跑，无需密钥/网络/pi）：装依赖 → npm test（49 断言）→ 跑两个真码 demo。
//   B. 真 Pi 端到端（可选，需 ZHIPU_API_KEY + 本地 pi/ 参考仓）：真跑一轮模型、grep JSONL 事件。
//      缺密钥或缺 pi/ 时**不报错**，只清楚地告诉你怎么补——这样"从零"的人也能一键看到 A 段全绿。
//
// 用法：
//   node scripts/reproduce.mjs            # 只跑 A 段（离线，推荐先跑这个）
//   node scripts/reproduce.mjs --e2e      # A + B 段（B 需先 set ZHIPU_API_KEY，且 pi/ 已 npm install）

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wantE2E = process.argv.includes("--e2e");

// ── 小工具 ──────────────────────────────────────────────────────────────────
const isWin = process.platform === "win32";
let step = 0;

function banner(title) {
	console.log(`\n${"═".repeat(70)}\n  ${title}\n${"═".repeat(70)}`);
}
function head(title) {
	step++;
	console.log(`\n▶ [${step}] ${title}`);
}
/** 跑一条命令，继承 stdio；返回是否成功。失败不直接退出，交给调用方决定。 */
function run(cmd, args, opts = {}) {
	console.log(`   $ ${cmd} ${args.join(" ")}`);
	const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: isWin, ...opts });
	return res.status === 0;
}
const npm = isWin ? "npm.cmd" : "npm";
const npx = isWin ? "npx.cmd" : "npx";

// ── A 段：离线验证（永远能跑）─────────────────────────────────────────────────
banner("EvoPi 从零复现 · A 段：离线验证（无需密钥 / 网络 / pi）");

head("安装依赖（只有一个 devDependency：tsx）");
if (!run(npm, ["ci"])) {
	// 没有 lockfile 或环境差异时退回 install，不让复现卡死。
	console.log("   ↳ npm ci 未成功，改用 npm install …");
	if (!run(npm, ["install"])) fail("依赖安装失败——检查 Node 版本（需 ≥ 18）与网络。");
}

head("跑测试套件（49 断言，直接 import 真实扩展模块）");
if (!run(npm, ["test"])) fail("测试未全过——这不该发生，请把输出贴出来。");

head("跑可视化 demo（真码驱动：执行治理 + 上下文成本）");
run(npx, ["tsx", "demo/demo-guardrail.mts"]);
run(npx, ["tsx", "demo/demo-cost.mts"]);

console.log("\n✅ A 段完成：测试全绿 + demo 跑通。这部分不需要任何密钥，任何人都能一键复现。");

// ── B 段：真 Pi 端到端（可选）─────────────────────────────────────────────────
if (!wantE2E) {
	console.log("\n（想连真实模型跑端到端？加 --e2e，并先设置 ZHIPU_API_KEY、确保 pi/ 已 npm install。）");
	done();
}

banner("EvoPi 从零复现 · B 段：真 Pi + 真模型端到端（可选）");

const piDir = join(root, "pi");
const missing = [];
if (!process.env.ZHIPU_API_KEY) missing.push("环境变量 ZHIPU_API_KEY（模型网关 key，只进环境变量不写文件）");
if (!existsSync(piDir)) missing.push("本地 Pi 参考仓 pi/（克隆到项目根，见 README「从零复现」）");
else if (!existsSync(join(piDir, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx"))) {
	missing.push("在 pi/ 里跑 `npm install`（需要 jiti 扩展加载器 + tsx）");
}

if (missing.length > 0) {
	console.log("\n⏭  跳过 B 段——缺少以下前置（不算失败，A 段已证明核心可复现）：");
	for (const m of missing) console.log(`   · ${m}`);
	console.log("\n   补齐后重跑：node scripts/reproduce.mjs --e2e");
	console.log("   B 段的三条硬约束（信任 --approve / stdin 管道 / jiti）见：");
	console.log("   docs/evopi-v1/impl/e2e-验证/README.md");
	done();
}

head("端到端：真跑一轮 pi --print --mode json --approve（智谱 glm-4-flash）");
console.log("   （细节与断言在 PowerShell 脚本里；这里直接委托它，避免复述逻辑）");
if (isWin) {
	// Windows：直接用现成的、已被验证的 PowerShell 脚本。
	run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "docs/evopi-v1/impl/e2e-验证/run-e2e.ps1"]);
} else {
	// 非 Windows：pwsh 若在则用之；否则给出等价手动命令，不假装能跑。
	const hasPwsh = spawnSync("pwsh", ["-v"], { stdio: "ignore" }).status === 0;
	if (hasPwsh) {
		run("pwsh", ["-NoProfile", "-File", "docs/evopi-v1/impl/e2e-验证/run-e2e.ps1"]);
	} else {
		console.log("   未找到 pwsh。等价手动命令（非 Windows）：");
		console.log('   echo "Reply with exactly one word: OK" | \\');
		console.log("     pi/node_modules/.bin/tsx --tsconfig pi/tsconfig.json \\");
		console.log("     pi/packages/coding-agent/src/cli.ts --print --mode json --approve \\");
		console.log("     --provider zhipu --model glm-4-flash");
		console.log("   然后 grep .pi/evopi/traces/<最新>.jsonl 里的 cost.request / session.start。");
	}
}

done();

// ── 收尾 ────────────────────────────────────────────────────────────────────
function fail(msg) {
	console.error(`\n✗ 复现中断：${msg}`);
	process.exit(1);
}
function done() {
	console.log("\n🎉 复现结束。更多证据：tests/README.md · demo/README.md · docs/evopi-v1/impl/e2e-验证/");
	process.exit(0);
}
