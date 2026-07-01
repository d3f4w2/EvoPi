# EvoPi Demo · 让治理「看得见」

> 「治理型 agent」很抽象。这一页用**真实产出**证明它不是 PPT：
> `rm -rf` 真的被拦、缓存命中率真的被算、真实 provider usage 真的进了 JSONL。
>
> 下面每段输出都由**真实出货代码**跑出来（不是手写的假输出）。你也可以自己跑：

```bash
npx tsx demo/demo-guardrail.mts   # 执行治理：谁被放行、谁被拦、无 UI 时怎么 fail-safe
npx tsx demo/demo-cost.mts        # 上下文成本：命中率口径 + 压力分档
```

（`tsx` 来自根 `npm install`；若只装了 pi/ 参考仓，也可用 `pi/node_modules/.bin/tsx`。）

---

## Demo 1 · 执行治理：它真的拦得住 `rm -rf`

驱动真实的 [`classifyRisk`](../.pi/extensions/evopi-trace/job.ts)（模块 4）+ 共享 [`policy.ts`](../.pi/extensions/evopi-trace/policy.ts)（模块 3/4/5 单一事实源）。同一批 tool_call，在「有 UI」与「无 UI（CI/无人值守）」两种场景下的处置：

```text
▌场景：hasUI = true  （交互式，有终端 UI 可弹确认）
──────────────────────────────────────────────────────────────────────────────
  动作              风险      EvoPi 的处置                      判据（真码给的 reason）
──────────────────────────────────────────────────────────────────────────────
  列目录            🟢 low    ✅ 放行                           read-only bash
  看 git 状态       🟢 low    ✅ 放行                           read-only bash
  跑测试            🟡 medium ✅ 放行 + 打 checkpoint（可回退） mutating bash
  改业务源码        🟡 medium ✅ 放行 + 打 checkpoint（可回退） write file
  ☠ 递归删除       🔴 high   ⚠️  弹确认，等人拍板            dangerous command: rm -rf
  ☠ 强推覆盖远端   🔴 high   ⚠️  弹确认，等人拍板            dangerous command: git push --force
  ☠ 发布到 npm     🔴 high   ⚠️  弹确认，等人拍板            dangerous command: npm publish
  ☠ 写 .env 密钥   🔴 high   ⚠️  弹确认，等人拍板            protected path write: .env
  ☠ 动 .git 内部   🔴 high   ⚠️  弹确认，等人拍板            protected path write: .git/

▌场景：hasUI = false  （无人值守 / CI，没有 UI）
──────────────────────────────────────────────────────────────────────────────
  ☠ 递归删除       🔴 high   ⛔ BLOCK（无 UI fail-safe）       dangerous command: rm -rf
  ☠ 强推覆盖远端   🔴 high   ⛔ BLOCK（无 UI fail-safe）       dangerous command: git push --force
  ☠ 发布到 npm     🔴 high   ⛔ BLOCK（无 UI fail-safe）       dangerous command: npm publish
  ☠ 写 .env 密钥   🔴 high   ⛔ BLOCK（无 UI fail-safe）       protected path write: .env
  ☠ 动 .git 内部   🔴 high   ⛔ BLOCK（无 UI fail-safe）       protected path write: .git/
```

**读出的设计**：只读零打扰；变更类放行但**先 checkpoint**（可回退）；高危交互下弹确认；同样的高危动作**无 UI 时一律 BLOCK**——安全 > 便利。

---

## Demo 2 · 上下文成本：命中率与压力被真实算出

驱动真实的 [`computeCacheHitRate` / `pressureBand`](../.pi/extensions/evopi-trace/cost.ts)（模块 2），与 `/evopi-cost` 面板同源：

```text
① 缓存命中率口径 = cacheRead / (cacheRead + input)
────────────────────────────────────────────────────────────────
  第 1 轮（冷启动，全未命中）            input=  8000  cacheRead=     0  → 命中率 0.0%
  第 2 轮（系统提示已缓存）             input=  1200  cacheRead=  8000  → 命中率 87.0%
  第 5 轮（长历史大量复用）             input=   900  cacheRead= 28000  → 命中率 96.9%

② 上下文压力分档（128k 窗口，跨 80/90/95% 各告警一次）
────────────────────────────────────────────────────────────────
  用了  40000 / 128000 tokens  →  31.3% (ok)
  用了 104000 / 128000 tokens  →  81.3% (warning)
  用了 116000 / 128000 tokens  →  90.6% (high)
  用了 122000 / 128000 tokens  →  95.3% (critical)
```

---

## Demo 3 · 它真的在真实 Pi 里跑起来了（不是离线模拟）

真跑一轮 `pi --print --mode json --approve --model glm-4-flash`（智谱网关），`evopi-trace` 扩展被真实加载，产出 9 条事件到 `.pi/evopi/traces/<traceId>.jsonl`。其中 `cost.request` 抓到了**真实 provider usage**（原文摘录）：

```json
{
 "type": "cost.request",
 "model": { "provider": "zhipu", "id": "glm-4-flash", "name": "GLM-4 Flash" },
 "contextUsage": { "tokens": 8, "contextWindow": 128000, "percent": 0.00625 },
 "data": { "retention": "short", "messageCount": 2, "toolCount": 4 }
}
```

完整脚本、根因与证据见 [../docs/evopi-v1/impl/e2e-验证/](../docs/evopi-v1/impl/e2e-验证/)。

---

## 录一段 GIF（可选，观感加分）

上面的文字 demo 已经能证明价值；若想在 README 顶部放一段动图，按这个分镜录（推荐 [asciinema](https://asciinema.org/) 或 [terminalizer](https://github.com/faressoft/terminalizer)，都能导出 GIF）：

| 秒 | 画面 | 旁白/字幕 |
| --- | --- | --- |
| 0–3 | 终端输入 `npm test`，49 断言刷过、`全部通过 ✓` | 「49 个断言，跑的是真实模块」 |
| 3–8 | 输入 `npx tsx demo/demo-guardrail.mts`，表格出现 | 「同一批命令，EvoPi 怎么判」 |
| 8–12 | 光标停在 `☠ 递归删除 → ⛔ BLOCK` 那行 | 「无人值守时，rm -rf 直接挡下」 |
| 12–16 | 输入 `npx tsx demo/demo-cost.mts`，命中率/压力表出现 | 「成本与上下文压力，一处口径算清」 |

导出后把 GIF 放到 `demo/`（例如 `demo/evopi-demo.gif`），并在顶层 [README](../README.md) 的「30 秒看懂」区插入：

```markdown
![EvoPi demo](demo/evopi-demo.gif)
```

> 录屏需要真实终端交互，本仓库先提供**可复现脚本 + 已捕获的真实输出**；GIF 由你在本机录一次即可（一次性，几分钟）。
