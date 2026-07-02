# evopi-trace · EvoPi 治理扩展

> 一个 [Pi 编码 agent](../../../pi/) 的**项目级扩展**：在不改 Pi 内核的前提下，通过生命周期钩子给 agent 套上一圈治理——观测、成本、记忆、执行准入、工具运行时、评测。
>
> 顶层项目介绍见 [../../../README.md](../../../README.md)；本文件讲**这个扩展本身怎么装、怎么用、由什么组成**。

## 这是什么

`evopi-trace` 是一个单一入口（`index.ts` 的 default export）的 Pi 扩展。加载后它：

1. 建一条统一的 **Trace 事件流**（每次运行一个 `traceId`），双写 `.pi/evopi/traces/<traceId>.jsonl`（全量观测）+ session anchor（仅关键治理决策）。
2. 注册六个模块的钩子与命令（下表）。
3. 用**单一 `tool_call` handler** 做安全准入 + 预算决策（安全 > 资源）。

约 3.2k 行 TypeScript，10 个文件，零运行时依赖（自包含 YAML/frontmatter 解析、自包含策略引擎）。

## 安装（装进一个 Pi 项目）

Pi 会自动发现**受信任项目**下的 `.pi/extensions/` 里的扩展。把本目录放到目标项目的 `.pi/extensions/evopi-trace/` 即可：

```bash
# 在你的项目根目录
mkdir -p .pi/extensions
cp -r /path/to/EvoPi/.pi/extensions/evopi-trace .pi/extensions/

# 交互式跑 Pi：首次会问是否信任本项目，选信任即加载扩展
pi

# 非交互 / CI 模式：必须显式信任，否则 .pi/extensions 会被跳过（见下方「三条硬约束」）
echo "your prompt" | pi --print --mode json --approve
```

加载成功的判据：产出的 `session.start` 事件里 `data.trusted: true`，且 `.pi/evopi/traces/` 下出现新的 `<traceId>.jsonl`。

### 三条硬约束（非交互模式，都被 Pi 源码验证过）

1. **依赖**：Pi 参考仓需 `npm install`（扩展加载器 `jiti` + TS 运行器 `tsx`）。
2. **信任**：`--print` / `--mode json` 是非交互模式，项目信任默认 `false` → `.pi/extensions` 会被**跳过**。必须加 `--approve`。
3. **stdin**：非 TTY 下 prompt 必须走管道喂入（否则等 EOF 死锁）。

根因分析与可复现脚本见 [端到端验证](../../../docs/evopi-v1/impl/e2e-验证/README.md)。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/evopi-trace` | Trace 状态总览 |
| `/evopi-cost` | 上下文与 provider 成本信号（命中率 / 累计 token·成本 / 压力档位 / 请求数）；`/evopi-cost detail` 看原始 usage |
| `/evopi-memory` | 三级 scope 项目记忆（关键词检索）；`add` / `review` / 摘要 |
| `/evopi-skill` | 受治理的 skill（trust 分级 / 审批 / 危险扫描）；列表 / `approve` / `block` |
| `/evopi-job` | 受治理的 Job（Policy Gate / checkpoint / rewind / 证据验收） |
| `/evopi-tools` | 工具运行时统计（错误 7 类分类 / 延迟 avg·max / 预算用量） |
| `/evopi-eval` | 评测（确定性评分 / golden task / 棘轮门禁 `replay`·`gate`·`candidate`） |

## 模块组成

| 文件 | 模块 | 职责 |
| --- | --- | --- |
| [index.ts](index.ts) | 入口 | 注册各 `registerXxx` + 单一 `tool_call` 路由（安全>资源） |
| [trace.ts](trace.ts) | ① 底座 | `traceId` / 事件写入 / JSONL / anchor 判定 / 摘要工具（只记形状不记原文） |
| [cost.ts](cost.ts) | ② 成本 | `cost.request`/`cache`/`pressure` + `/evopi-cost` |
| [policy.ts](policy.ts) | 3/4/5 共享 | 危险命令黑名单 + 受保护路径 + 扫描原语（**单一事实源**，不各造黑名单） |
| [memory.ts](memory.ts) | ③ 记忆 | 三级 scope + 关键词检索注入 + 压缩抢救 + `/evopi-memory` |
| [skill.ts](skill.ts) | ③ 技能 | trust 四级 + `resources_discover` 过滤 + 危险扫描 + `/evopi-skill` |
| [job.ts](job.ts) | ④ 执行 | Job 信封 + Policy Gate + checkpoint/rewind + 证据验收 + `/evopi-job` |
| [tools.ts](tools.ts) | ⑤ 工具 | 错误 7 类分类 + 延迟统计 + 预算 + `/evopi-tools` |
| [eval.ts](eval.ts) + [subagent.ts](subagent.ts) | ⑥ 评测 | 确定性评分 + golden task + 子代理 spawn + 棘轮门禁 + `/evopi-eval` |

## 配置

治理策略读同一份 `.pi/evopi/policy.json`（模块 3/4/5 共享）。缺失或字段缺失时用内置保守默认（总能拦高危），且是**合并而非替换**——即用户只想覆盖一个键，其它键仍有默认，不会漏放高危。结构：

```json
{
  "dangerousCommands": ["rm -rf", "git push --force", "npm publish", "..."],
  "protectedPaths": [".git/", ".env", "secrets/", "id_rsa"],
  "testCommandPatterns": ["npm test", "pytest", "go test"]
}
```

运行数据写在 `.pi/evopi/`（traces / memory / skills / evals / handoff），已 gitignore。

## 事件流与 Anchor-only

所有模块的事件都是 Trace 的统一事件，**全部**进 JSONL，**只有**「资产产生 / 审批 / 关键治理决策」额外写 session anchor（如 `memory.write` / `skill.approved` / `policy.approved·denied·blocked` / `job.*` / `tool.budget`(硬限) / `eval.gate·candidate`）；逐次观测（`cost.*` / `tool.result` / `policy.check` / `*.retrieve` 等）只进 JSONL。事件字段 schema 与 anchor 判据见各模块的[设计文档](../../../docs/evopi-v1/)。

## 测试与类型检查

见仓库根：`npm test`（49 断言，直接 import 本目录模块）、`npm run typecheck`（用 Pi 的 strict tsc，0 错）。测试说明见 [../../../tests/README.md](../../../tests/README.md)。
