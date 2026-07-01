# EvoPi 端到端验证（真 Pi + 真 model）

把「真码离线驱动」的模块自测，升级为**真实 Pi 运行时 + 真实模型对话**的端到端闭环：
确认 `evopi-trace` 扩展被真实加载、各模块 handler 真实触发、事件带真实数据落 JSONL。

这是 `impl/进度.md` 里「统一遗留」的闭合证据。**2026-07-01 首次跑通。**

---

## 一句话结论

真跑一轮 `pi --print --mode json --approve --model glm-4-flash`（智谱网关），
`evopi-trace` 扩展真实产出 9 条事件到 `.pi/evopi/traces/<traceId>.jsonl`，
覆盖完整生命周期 + 关键的 `cost.request`（带真实 provider usage）。

---

## 怎么跑

```powershell
$env:ZHIPU_API_KEY = "<你的网关 key>"   # key 只进环境变量，不写进任何文件
cd D:\evopi\docs\evopi-v1\impl\e2e-验证
./run-e2e.ps1
```

脚本会：冒烟 `--list-models` → 真跑一轮 → grep 新 JSONL → 对 5 条断言打分。

---

## 三条硬约束（都被 Pi 源码验证过，缺一不可）

排查过程踩了三个坑，每个都定位到源码根因，记在这里避免重复踩：

### 1. 依赖：Pi 参考仓需 `npm install`
`D:\evopi\pi` 初始 `node_modules` 不完整（`.bin` 空、`jiti`/`tsx` 缺失）。
- `jiti` 是 Pi 扩展加载器（`core/extensions/loader.ts` 用 `createJiti` 编译扩展 TS），缺了扩展加载不了。
- `tsx` 是 TS 运行器（`pi-test.sh`/`pi-test.ps1` 官方入口，免构建直接跑 `packages/coding-agent/src/cli.ts`）。
- 补齐：在 `D:\evopi\pi` 跑 `npm install`（写入 `pi/node_modules`，已 gitignore，不改 pi 源码）。

### 2. 信任：非交互模式必须 `--approve`
**这是「扩展没加载」的真正根因。** `--print`/`--mode json` 是非交互模式：
- `main.ts` → `trustPromptMode` 非 `"interactive"` → `hasUI=false` → 项目信任默认 **false**。
- `core/package-manager.ts`（`addAutoDiscoveredResources`）**只在 `projectTrusted===true` 时**才加载
  项目级 `.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes`；否则**完全跳过**。
- 解法：加 `--approve`（简写 `-a`）→ `projectTrustOverride=true` → 扩展加载。
  验证证据：产出的 `session.start` 事件里 `data.trusted: true`。
- 持久化方式（可选）：项目信任写在 `~/.pi/agent/trust.json`，键=规范化项目路径，值=`true`。

### 3. stdin：prompt 必须走管道
非 TTY 下 Pi 会 `process.stdin.resume()` 阻塞等 EOF（`main.ts` 仅当 `stdin.isTTY` 才跳过）。
PowerShell 后台进程 stdin 既非 TTY 又不结束 → **死锁**。
- 解法：prompt 从 stdin 管道喂入（`"prompt" | tsx ... cli.ts --print`），管道关闭即 EOF。
- 附带坑：PowerShell 管道传中文会丢成 `?`，验证 prompt 用英文（`Reply with exactly one word: OK`）。

### 附：模型名
用户生产配置的 `glm-5-turbo-nothinking` 在网关 `/v1/models` 里**不存在**（会 503 No available channel）。
网关实际可用：`glm-4-flash`（稳定快）、`glm-5-turbo`、`glm-4-plus` 等。验证用 `glm-4-flash`。

---

## 首次跑通的真实产出（2026-07-01）

`.pi/evopi/traces/tr_mr23npd4_eo9efmx3.jsonl`，9 条事件：

| 事件 | 次数 | 说明 |
| --- | --- | --- |
| `session.start` | 1 | `data.trusted:true`、`model:{zhipu, glm-4-flash}` —— 扩展真加载 |
| `agent.start` | 1 | |
| `turn.start` | 1 | |
| `message.end` | 2 | user + assistant |
| `turn.end` | 1 | |
| `cost.request` | 1 | **关键**：`contextUsage.tokens:8`、`data:{retention:"short", messageCount:2, toolCount:4}` —— 模块 2 真抓到 provider usage |
| `agent.end` | 1 | |
| `session.shutdown` | 1 | |

模型真实回话（`stopReason:"stop"`，流式输出），非空壳。

`cost.request` 关键字段实样：
```json
{"type":"cost.request","model":{"provider":"zhipu","id":"glm-4-flash","name":"GLM-4 Flash"},
 "contextUsage":{"tokens":8,"contextWindow":128000,"percent":0.00625},
 "data":{"contextEstimate":{"tokens":8,"window":128000,"percent":0.00625},
         "retention":"short","messageCount":2,"toolCount":4}}
```

---

## 覆盖边界（诚实标注）

- ✅ **已验**：扩展加载、session/agent/turn 生命周期、`message.end`、`cost.request`（真实 usage）、
  provider 请求真实往返、字段对齐设计文档。
- ⬜ **本轮未覆盖**（prompt 是纯文本回复，未触发工具/多轮/压缩）：
  `tool.call`/`tool.result`（需模型调工具）、`policy.*`（需危险工具触发 Gate）、
  `tool.budget`（需超预算）、`compact.*`（需上下文压缩）、`skill`/`memory`/`eval` 命令路径。
  这些的**逻辑与写盘路径已在真码离线驱动自测覆盖**（254 断言）；如需真 Pi 触发，
  可扩展 prompt 让模型执行 bash/read 等工具，再 grep 对应事件。
