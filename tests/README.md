# EvoPi 测试

> 一句话：`npm install && npm test` → **49 个断言全过**，跑的是 `.pi/extensions/evopi-trace/` 里**真实出货的模块**（不是副本、不是 mock 实现）。

## 怎么跑

```bash
npm install     # 只装一个 devDependency：tsx（TS 运行器）
npm test        # = tsx tests/run.ts
```

不需要智谱 key、不需要联网、不需要先跑起 Pi——这些测试断的是**纯逻辑内核**，确定性、秒级完成。

可选（本地完整校验，需要 `pi/` 参考仓）：

```bash
npm run typecheck   # 用 Pi 自带的 strict tsc 检查扩展，0 错
```

## 为什么这样搭

- **零测试框架依赖**：EvoPi 扩展本身零运行时依赖（自包含 YAML 解析、自包含策略引擎），测试保持同一哲学——只用 `tsx` 当 TS 运行器，一个手写的极简断言器（[harness.ts](harness.ts)），不引 jest/vitest。这样 `npm test` 不受测试框架版本漂移影响。
- **测真码**：每个 `*.test.ts` 直接 `import ../.pi/extensions/evopi-trace/<模块>`。Pi 的 `import type` 在运行时被擦除，所以 tsx 能直接跑这些出货文件，断言的是**真实行为**。

## 覆盖什么（按「治理价值」挑的核心，非追平行数）

| 文件 | 被测真码 | 断了什么关键属性 |
| --- | --- | --- |
| [policy.test.ts](policy.test.ts) | `policy.ts`（模块 3/4/5 共享的安全单一事实源） | 危险命令（`rm -rf`/force-push/`npm publish`/`curl\|sh`）拦得住、受保护路径（`.env`/`.git`/`id_rsa`）识别、大小写不敏感、普通命令不误报；`policy.json` **缺失/坏 JSON/部分覆盖**时**合并而非替换**——即用户只想改一条也**不会漏放高危**（关键安全属性）。**含一条诚实断言：带 URL 的 `curl … \| sh` 当前字面模式漏判**（暴露的真实缺口，非测试 bug）。 |
| [eval.test.ts](eval.test.ts) | `eval.ts`（评测确定性内核） | golden task 极简 YAML 解析（4 类 check + 缺 id/prompt 判无效）；`runCheck` 四类 check（command 退出码正/反、file_changed、output_contains、no_forbidden）——靠**依赖注入** exec/fileChanged 做到不 shell out 的确定性；`scoreTask` 两种口径（all_checks_pass 二值 / weighted 平均 / 空列表不猜）。 |
| [cost.test.ts](cost.test.ts) | `cost.ts`（成本内核） | 缓存命中率口径 `cacheRead/(cacheRead+input)` 含**除零兜底**（不 NaN）；上下文压力 80/90/95 三档**边界值**分档。 |
| [trace.test.ts](trace.test.ts) | `trace.ts`（底座工具） | `traceId` 格式 + 50 个不重复；内容摘要**只记形状不记原文**（隐私：断言摘要里查不到用户消息全文）；`safeJson` 对循环引用兜底不抛。 |

## 一个诚实的说明

实现期曾有一批「真码离线驱动」的集成测（用 fake `pi`/`ctx` 加载真实 `registerCost`/`registerJob` 等驱动钩子、读磁盘 JSONL 断言），当时跑在临时目录、**未随实现进 git**，已不可复现。这套 `tests/` 是**重新写的、进了 git、CI 每次跑**的版本——先覆盖依赖最轻、价值最高的纯逻辑内核（安全判据 / 评分 / 成本 / 底座）。集成层（驱动生命周期钩子 + 读 JSONL 断言事件字段）作为下一步补充，接口位已就绪（生产代码本就为可测性做了依赖注入）。
