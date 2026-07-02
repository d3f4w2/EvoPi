# V2 增量 · Codebase RAG（代码库本地检索预注入，属新增能力 / 挂在 Trace+Memory 一侧）

> 请求发出前，用**本地零 API 检索**把与当前任务最相关的代码片段直接注入 context，让模型不必自己反复 grep/read 就先看到相关代码。

## 1. V1 现状（查证结论）

- **Pi 内核有代码搜索工具**：`grep.ts` / `find.ts` / `read.ts`（`pi/packages/coding-agent/src/core/tools/`）。但它们是**模型主动调用**——模型得自己想到"搜什么、搜几次"，消耗 tool 轮次和 token，且可能忘搜/搜错。
- **Pi 内核没有**"请求前自动把相关代码预检索并注入 context"的能力。这是本增量的空间。
- **EvoPi 已有可复用基建**：
  - 注入挂点——`memory.ts` 的 `context` 钩子（memory.ts:295-320）已在生产中用 `customType` + `display:false` 注入检索结果，并带"先滤旧再注入防叠加"模式；`context` 钩子契约 `ContextEventResult`（Pi types.ts:1022，注释"Can modify messages"）确认可注入。
  - 本地检索算法——`memory.ts` 的 `scoreEntry`（词频+tag+时间邻近）/`retrieveTopK`/`tokenize`/`lastUserText` 可直接借鉴。

## 2. 这次增量（改什么）

**纯加法**，不改任何已冻结的事件字段 / policy / 现有模块行为：

- 新增本地代码检索：把项目源码文件切成可检索单元，按当前 query（最后一条 user 文本）做**零 API 词频打分**取 Top-K 片段。
- 新增注入：在 `context` 钩子里，把 Top-K 代码片段以 `customType="evopi-rag"`、`display:false` 注入（与 memory 注入并存、各自滤旧、互不干扰）。
- 新增可观测：记 `rag.retrieve` 事件（只进 JSONL，不 anchor——逐次检索是观测，守 Anchor-only）。
- 新增命令 `/evopi-rag`：查看上轮检索命中了哪些文件/片段、以及索引状态（可解释、可调试）。

## 3. 实现前后的区别（最关键）

| 维度 | 实现前（Pi 原生） | 实现后（V2 RAG） |
| --- | --- | --- |
| 相关代码怎么进上下文 | 模型自己 grep/read，多轮试探 | 请求前本地预检索，Top-K 直接注入 |
| 花费 | 每次搜索占 tool 轮次 + token | 本地零 API，不占模型轮次 |
| 失败模式 | 模型忘了搜 / 搜错关键词 → 没看到关键代码 | 本地检索兜底，先喂一批相关片段 |
| 可解释性 | 搜了什么散在对话里 | `/evopi-rag` + `rag.retrieve` 事件可查 |

> 注意：RAG **不替代** Pi 的 grep/read（模型仍可主动搜）；它是"预热"——先把大概率相关的喂进去，降低冷启动搜索成本。

## 4. 怎么做 + 落点

- **新建 `rag.ts`**（不塞进 cost/memory，职责独立）：
  - `buildIndex(cwd)`：遍历项目源码（尊重 .gitignore 思路：跳过 node_modules/dist/.git/pi 等），按文件+滑动窗口切片；
  - `retrieveTopK(query, index, k)`：借鉴 memory 的词频打分（含路径/文件名加权），零 API；
  - `registerRag(pi, shared)`：挂 `context` 钩子注入（customType="evopi-rag"、display:false、先滤旧）、记 `rag.retrieve`、注册 `/evopi-rag`。
- **index.ts**：加 `registerRag(pi, shared)` 一行（与其它 registerXxx 并列）。
- **不碰**：cost/job/tools/eval/policy、任何已冻结事件字段、单一 tool_call handler。

## 5. 怎么验收（Done = 全绿）

1. **单元测试进 `tests/`**（秒级、无需 key、无需 Pi）：
   - 检索打分：给一组假代码片段 + query，断言相关片段排前、无关的不进 Top-K；
   - 切片：一个长文件被切成多个带行号的片段；
   - 注入形状：给定命中片段，产出的注入消息 `customType="evopi-rag"`、`display:false`、含文件路径、不超字符上限；
   - 边界：query 为空 → 不注入；无命中 → 不注入；先滤旧再注入不叠加。
2. `npm test` 从 49 条增加到 ~60+ 条，全绿。
3.（可选，用真 Pi）跑一轮让模型改某功能，`/evopi-rag` 能看到预检索命中了对的文件、JSONL 有 `rag.retrieve`。

## 6. 再往后（V3 留口）

- 词频检索 → 升级为 embedding 语义检索（V1/V2 先本地零 API，够用且省钱，见 mempalace 参考）。
- 与 Cost 联动：注入前后对比"模型主动搜索轮次"下降多少（量化价值）。
- 索引增量更新（文件变更时只重切变更文件），而非每次全量。
