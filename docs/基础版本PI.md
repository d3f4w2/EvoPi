# 基础版本 PI —— 架构、可扩展性与改造方向

> 本文档记录的是 **未经任何改动的原始 Pi 项目** 的样子。
> 目的：在你动手改造之前，先彻底搞清楚它现在长什么样、关键机制怎么跑、以及"你后续能从哪些地方插手改造"。
>
> 阅读重点：**第 3 章（Agent 关键机制）**、**第 4 章（可扩展性 / 挂点）**、**第 5 章（10 个最火热的改造方向）**。
>
> 文档里所有代码引用都是**可点击跳转**的（VSCode 扩展里点一下即跳到对应文件对应行）。文档位于 `docs/`，链接用相对路径 `../pi/...` 指向代码。

---

## 0. 一句话概括

**Pi 是一个开源的、自我可扩展的 AI 编程智能体（coding agent）框架**，定位类似 Claude Code / Cursor CLI / Codex CLI。它把"和大模型对话 + 调用工具改代码"这件事做成了一套分层、可插拔的工程。

它最大的设计特点是：**核心循环极简且不可被污染，所有定制能力都通过一套"事件挂点（hooks）+ 注册 API"的扩展系统暴露出来**。更关键的是——**Pi 官方刻意不内置 MCP、子代理、权限弹窗、计划模式、待办、后台 bash 这些功能，全部留给扩展去实现**（见 [coding-agent/docs/usage.md](../pi/packages/coding-agent/docs/usage.md#L306) 第 306 行、[coding-agent/README.md](../pi/packages/coding-agent/README.md#L490) 第 490 行）。

这句话对你极其重要：**官方留白 = 你的改造空间**。你想做的几乎每一个"现代 Agent 必备能力"，Pi 都把地基（挂点）打好了、把楼（功能）留给你盖。这正是它适合当简历项目的原因。

---

## 1. 项目整体结构

这是一个 npm **monorepo**（一个仓库装多个包），用 TypeScript 写，跑在 Node ≥ 22.19。共 4 个核心包，**自下而上**分层，下层不依赖上层：

| 层 | 包名（npm） | 目录 | 代码量 | 职责 |
|----|------|------|--------|------|
| 4 | `@earendil-works/pi-coding-agent` | [coding-agent](../pi/packages/coding-agent) | ~5 万行 / 158 文件 | **编程智能体本体**：内置工具、会话、压缩、扩展系统、CLI 入口 |
| 3 | `@earendil-works/pi-agent-core` | [agent](../pi/packages/agent) | ~8 千行 / 25 文件 | **通用 Agent 运行核心**：对话循环、工具调用、状态机（不绑定"编程"场景） |
| 2 | `@earendil-works/pi-ai` | [ai](../pi/packages/ai) | ~3.2 万行 / 55 文件 | **统一大模型 API**：一套接口接通 ~15 家厂商（OpenAI/Anthropic/Google/Bedrock/Azure/Mistral…），自动发现模型 |
| 1 | `@earendil-works/pi-tui` | [tui](../pi/packages/tui) | ~1.2 万行 / 28 文件 | **终端 UI 库**：差分渲染、编辑器组件、键位、自动补全 |

> 关键认知：**[agent](../pi/packages/agent) 包是"通用智能体引擎"，[coding-agent](../pi/packages/coding-agent) 包才是"会写代码的那个产品"。**
> 你要做的改造，绝大部分挂点都在 **coding-agent 的扩展系统**里，而真正驱动对话的发动机在 **agent 包的 [agent-loop.ts](../pi/packages/agent/src/agent-loop.ts)**。这两块是本文档的核心。

依赖方向（谁用谁）：
```
coding-agent  ──→  agent  ──→  ai
      └──────────────────────→  tui
```

---

## 2. 数据流总览：一句话怎么变成一次代码改动

先建立全局直觉。用户敲一句话后，数据大致这样流动（每一步都标了"它在哪个挂点"）：

```
用户输入 (TUI 编辑器, pi-tui)
   │
   ▼
[挂点 input]            ← 扩展可在这里改写/拦截用户输入
   │
   ▼
组装 system prompt + 历史消息 (coding-agent: system-prompt.ts)
   │
   ▼
[挂点 before_agent_start]  ← 扩展可改 system prompt / 注入首条消息
   │
   ▼
进入 Agent 循环 (agent 包: agent-loop.ts 的 runLoop)
   │
   ├─ [挂点 context]            ← 每次请求大模型前，扩展可改整段 messages（记忆注入的关键点）
   ├─ transformContext()        ← 上下文裁剪/压缩的低层钩子
   ├─ convertToLlm()            ← AgentMessage[] 转成大模型能懂的 Message[]
   │
   ▼
[挂点 before_provider_request]  ← 扩展可改最终发给厂商的 payload
   │
   ▼
调用大模型，流式拿回 (pi-ai: stream.ts / providers/*)
   │
   ▼
[挂点 message_update / message_end]  ← 逐 token 更新；消息收完后扩展可改写整条消息
   │
   ▼
大模型要求调用工具？
   │
   ├─ [挂点 tool_call]          ← 扩展可【阻止】或【改写入参】（安全/权限的关键点）
   │
   ▼
执行工具 (coding-agent: core/tools/*，如 bash/edit/write/read/grep/find/ls)
   │
   ├─ [挂点 tool_result]        ← 扩展可改写工具结果
   │
   ▼
工具结果塞回对话 → 回到循环顶部，再问大模型……
   │
   ▼ (大模型不再要求工具时)
[挂点 turn_end] → [挂点 agent_end] → 结束，等下一句
```

记住这张图。后面所有细节都是在给这张图填血肉。

---

## 3. Agent 关键机制（最重要的一章）

这一章讲清楚"发动机"是怎么转的。核心在 **[agent](../pi/packages/agent) 包**，只有 3 个关键文件：

- [agent-loop.ts](../pi/packages/agent/src/agent-loop.ts)（748 行）—— **对话循环本身**，纯函数式，无状态
- [agent.ts](../pi/packages/agent/src/agent.ts)（557 行）—— **有状态的封装类 `Agent`**，持有当前对话、对外暴露 `prompt()` 等方法
- [types.ts](../pi/packages/agent/src/types.ts)（423 行）—— **所有契约和挂点的类型定义**，是理解一切的钥匙

### 3.1 核心抽象：`AgentMessage` 与 `AgentTool`

**`AgentMessage`** —— 对话里流动的"消息"。它是一个联合类型：标准大模型消息（user/assistant/toolResult）**+ 应用自定义消息**。
- 见 [types.ts:308](../pi/packages/agent/src/types.ts#L308)
- 妙处在 `CustomAgentMessages` 这个空接口（[types.ts:300](../pi/packages/agent/src/types.ts#L300)）：上层应用可以用 TypeScript 的"声明合并"往里加自己的消息类型（比如 UI 通知、状态消息），既类型安全，又不污染核心。
- 既然对话里可以混入"非大模型消息"，那就必须有人负责在真正调大模型前把它们过滤/转换掉——这就是 `convertToLlm` 的活（见 3.4）。

**`AgentTool`** —— 一个工具的定义。见 [types.ts:366](../pi/packages/agent/src/types.ts#L366)。关键字段：
```ts
interface AgentTool {
  name: string;                 // 大模型用它来点名调用
  label: string;                // UI 显示名
  description: string;
  parameters: TSchema;          // 用 TypeBox 描述的参数 schema（带类型校验）
  execute(toolCallId, params, signal?, onUpdate?): Promise<AgentToolResult>;
  prepareArguments?(args): ...; // 校验前的兼容性修正（可选）
  executionMode?: "sequential" | "parallel";  // 并发策略
}
```
- `execute` 的约定很关键：**失败就抛异常，不要把错误编码进返回值**（[types.ts:374](../pi/packages/agent/src/types.ts#L374)）。循环会捕获异常并自动生成一条"错误工具结果"喂回大模型。
- `onUpdate` 回调让工具能流式吐进度（比如 bash 跑一半的输出）。

### 3.2 对话循环：`runLoop`（发动机本体）

位置：[agent-loop.ts:155](../pi/packages/agent/src/agent-loop.ts#L155)。这是整个项目最该读懂的一段。它是**双层循环**：

**内层循环**（`while (hasMoreToolCalls || pendingMessages.length > 0)`，[agent-loop.ts:174](../pi/packages/agent/src/agent-loop.ts#L174)）——这是"一个回合接一个回合"的主体：
1. **注入待处理消息**（[agent-loop.ts:182](../pi/packages/agent/src/agent-loop.ts#L182)）：如果有用户中途插话（steering，见 3.5），先塞进上下文。
2. **流式拿大模型回复**（`streamAssistantResponse`，[agent-loop.ts:193](../pi/packages/agent/src/agent-loop.ts#L193)）。
3. **若回复是 error/aborted**：直接发 `turn_end` + `agent_end`，退出（[agent-loop.ts:196](../pi/packages/agent/src/agent-loop.ts#L196)）。
4. **检查回复里有没有工具调用**（[agent-loop.ts:203](../pi/packages/agent/src/agent-loop.ts#L203)）：
   - 有 → 执行（`executeToolCalls`，见 3.3），把工具结果塞回上下文（[agent-loop.ts:207](../pi/packages/agent/src/agent-loop.ts#L207)）。
   - 没有 → `hasMoreToolCalls = false`，本回合结束。
5. **发 `turn_end` 事件**（[agent-loop.ts:218](../pi/packages/agent/src/agent-loop.ts#L218)）。
6. **`prepareNextTurn` 钩子**（[agent-loop.ts:226](../pi/packages/agent/src/agent-loop.ts#L226)）：允许在下一次请求前**替换上下文 / 换模型 / 改思考强度**。
7. **`shouldStopAfterTurn` 钩子**（[agent-loop.ts:241](../pi/packages/agent/src/agent-loop.ts#L241)）：返回 true 就优雅停下（比如"上下文快满了，先停"）。
8. **再拉一次 steering 消息**（[agent-loop.ts:253](../pi/packages/agent/src/agent-loop.ts#L253)），回到循环顶部。

**外层循环**（`while (true)`，[agent-loop.ts:170](../pi/packages/agent/src/agent-loop.ts#L170)）——处理"本该停了，但有后续消息（follow-up）排队"的情况：
- 内层退出后，问 `getFollowUpMessages()`（[agent-loop.ts:257](../pi/packages/agent/src/agent-loop.ts#L257)）。有就继续转；没有就彻底结束（发 `agent_end`，[agent-loop.ts:268](../pi/packages/agent/src/agent-loop.ts#L268)）。

> **理解要点**：`turn`（回合）= 一次大模型回复 + 它触发的所有工具执行。大模型只要还在要求调工具，循环就一直转；直到它给出不带工具调用的回复，一个 prompt 才算处理完。

### 3.3 工具执行：顺序 vs 并行

位置：[agent-loop.ts:373](../pi/packages/agent/src/agent-loop.ts#L373)。

- 默认是 **parallel（并行）**（[types.ts:254](../pi/packages/agent/src/types.ts#L254)，默认值在 [agent.ts:218](../pi/packages/agent/src/agent.ts#L218)）。
- 但只要这批工具里**有任何一个标了 `executionMode: "sequential"`**，整批就退化为顺序执行（[agent-loop.ts:381](../pi/packages/agent/src/agent-loop.ts#L381)）。
- 每个工具调用都经历三段式：**prepare（校验参数 + 跑 `beforeToolCall` 钩子） → execute（真正执行 + 流式 update） → finalize（跑 `afterToolCall` 钩子）**：
  - `prepareToolCall`：[agent-loop.ts:562](../pi/packages/agent/src/agent-loop.ts#L562)。找不到工具 → 立刻返回错误结果；参数校验失败 → 错误结果；`beforeToolCall` 返回 `{block:true}` → 阻止执行并生成错误结果（[agent-loop.ts:598](../pi/packages/agent/src/agent-loop.ts#L598)）。**这是安全拦截的底层机制。**
  - `executePreparedToolCall`：[agent-loop.ts:628](../pi/packages/agent/src/agent-loop.ts#L628)。执行中通过 `onUpdate` 发 `tool_execution_update` 事件。**抛异常会被捕获并转成错误结果**（[agent-loop.ts:659](../pi/packages/agent/src/agent-loop.ts#L659)）。
  - `finalizeExecutedToolCall`：[agent-loop.ts:671](../pi/packages/agent/src/agent-loop.ts#L671)。`afterToolCall` 钩子可**逐字段覆盖** content / details / isError / terminate（无深合并，[agent-loop.ts:695](../pi/packages/agent/src/agent-loop.ts#L695)）。
- **提前终止**：只有当一批工具结果**全部**把 `terminate` 设为 true，循环才会停（`shouldTerminateToolBatch`，[agent-loop.ts:544](../pi/packages/agent/src/agent-loop.ts#L544)）。

### 3.4 大模型调用边界：`streamAssistantResponse`

位置：[agent-loop.ts:275](../pi/packages/agent/src/agent-loop.ts#L275)。这是"AgentMessage 世界"与"大模型世界"的接缝：

1. 先跑 `transformContext`（若配置了）——在 AgentMessage 层做上下文管理（裁剪、注入），[agent-loop.ts:284](../pi/packages/agent/src/agent-loop.ts#L284)。
2. 再跑 `convertToLlm`——把 `AgentMessage[]` 转成厂商能懂的 `Message[]`，过滤掉 UI-only 消息（[agent-loop.ts:289](../pi/packages/agent/src/agent-loop.ts#L289)）。默认实现只保留 user/assistant/toolResult（[agent.ts:31](../pi/packages/agent/src/agent.ts#L31)）。
3. 组装 `Context`（system prompt + messages + tools），[agent-loop.ts:292](../pi/packages/agent/src/agent-loop.ts#L292)。
4. **动态解析 API key**（`getApiKey`，[agent-loop.ts:301](../pi/packages/agent/src/agent-loop.ts#L301)）——为 GitHub Copilot 这类会过期的 OAuth token 而设计：每次请求现拿。
5. 调 `streamSimple`（pi-ai 提供），流式消费事件，逐 token 更新并发 `message_update`（[agent-loop.ts:313](../pi/packages/agent/src/agent-loop.ts#L313)）。

> 契约提醒：`convertToLlm` / `transformContext` / `getApiKey` 等钩子 **绝不能抛异常**（见 [types.ts:147](../pi/packages/agent/src/types.ts#L147) 附近的注释），否则会打断底层循环的正常事件序列。要出错就返回安全的兜底值。

### 3.5 有状态封装：`Agent` 类

位置：[agent.ts:166](../pi/packages/agent/src/agent.ts#L166)。[agent-loop.ts](../pi/packages/agent/src/agent-loop.ts) 是无状态纯函数，真正"持有一次会话"的是 `Agent` 类。

- **状态 `AgentState`**（[types.ts:317](../pi/packages/agent/src/types.ts#L317)）：当前 `systemPrompt` / `model` / `thinkingLevel` / `tools` / `messages` / `isStreaming` / `pendingToolCalls` / `errorMessage`。注意 `tools` 和 `messages` 用 getter/setter，赋值时会拷贝顶层数组（[agent.ts:76](../pi/packages/agent/src/agent.ts#L76)），避免外部引用串改。
- **对外方法**：
  - `prompt(input)`：开一轮新对话（[agent.ts:325](../pi/packages/agent/src/agent.ts#L325)）。同一时间只能跑一个 run，否则抛错。
  - `continue()`：从当前对话续跑（最后一条须是 user 或 toolResult），[agent.ts:338](../pi/packages/agent/src/agent.ts#L338)。
  - `abort()` / `waitForIdle()` / `reset()`：中断 / 等空闲 / 清空。
  - `subscribe(listener)`：订阅所有生命周期事件（[agent.ts:231](../pi/packages/agent/src/agent.ts#L231)）。**监听器是被 `await` 的，且算进本次 run 的"结算"**——也就是说 `agent_end` 发出后，必须等所有监听器跑完，agent 才真正空闲（[agent.ts:505](../pi/packages/agent/src/agent.ts#L505)）。这点对扩展系统很重要。
- **两个消息队列（Pi 的一大特色）**：
  - **Steering（操舵）队列**：`steer(msg)`，[agent.ts:264](../pi/packages/agent/src/agent.ts#L264)。在**当前回合的工具执行完后**注入——用于"agent 干活干到一半，你想插一句调整方向"。
  - **Follow-up（后续）队列**：`followUp(msg)`，[agent.ts:269](../pi/packages/agent/src/agent.ts#L269)。在**agent 本来要停下时**才注入——用于"等它忙完再处理的事"。
  - 两个队列都支持 `all`（一次全注入）或 `one-at-a-time`（一次只放最老的一条）两种排空模式（`PendingMessageQueue`，[agent.ts:118](../pi/packages/agent/src/agent.ts#L118)）。

### 3.6 这一章对你的意义

[agent](../pi/packages/agent) 包已经把"循环 + 工具 + 状态 + 钩子"这套发动机做得很干净。底层 `AgentLoopConfig` 上其实已经预留了一排钩子（`beforeToolCall` / `afterToolCall` / `transformContext` / `prepareNextTurn` / `shouldStopAfterTurn`，全在 [types.ts:135](../pi/packages/agent/src/types.ts#L135)）。

但**你通常不直接碰这些底层钩子**——上层 [coding-agent](../pi/packages/coding-agent) 把它们包装成了更友好、更丰富的"扩展事件系统"（第 4 章）。底层钩子是"机制"，扩展系统是给你用的"接口"。

---

## 4. 可扩展性：扩展系统与全部挂点（你改造的主战场）

Pi 的口号就是 "**self-extensible（自我可扩展）**"——它的定制能力几乎全部通过这套系统暴露。

代码在 [coding-agent/src/core/extensions/](../pi/packages/coding-agent/src/core/extensions)：

| 文件 | 行数 | 职责 |
|------|------|------|
| [types.ts](../pi/packages/coding-agent/src/core/extensions/types.ts) | 1615 | 扩展 API 的全部类型契约（最重要） |
| [loader.ts](../pi/packages/coding-agent/src/core/extensions/loader.ts) | 677 | 扩展如何被发现和加载 |
| [runner.ts](../pi/packages/coding-agent/src/core/extensions/runner.ts) | 1135 | 扩展如何被调度、事件如何派发 |
| [index.ts](../pi/packages/coding-agent/src/core/extensions/index.ts) | 178 | 对外汇总 |

外加 [examples/extensions/](../pi/packages/coding-agent/examples/extensions) 里 **约 70 个真实示例**（从权限门禁到贪吃蛇小游戏都有），是最好的学习材料。

### 4.1 一个扩展长什么样

一个扩展 = **一个 TS/JS 模块，默认导出一个"工厂函数"**。加载时这个函数被调用一次，传入一个 `ExtensionAPI` 对象（惯例命名 `pi`）：

```ts
// 类型签名：types.ts:1424
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// 一个最小扩展长这样：
export default function (pi: ExtensionAPI) {
  // 1) 订阅事件挂点
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && isDangerous(event.input.command)) {
      return { block: true, reason: "危险命令，已拦截" };
    }
  });

  // 2) 或注册新东西（工具/命令/快捷键/provider）
  pi.registerTool({ name: "my_tool", /* ... */ });
}
```
（类型签名见 [types.ts:1424](../pi/packages/coding-agent/src/core/extensions/types.ts#L1424)）

**两种使用方式**：
- **订阅事件**（`pi.on(eventName, handler)`）—— 在 agent 跑的各个时机插入逻辑、拦截、改写。
- **注册能力**（`pi.registerTool/registerCommand/registerShortcut/registerProvider/...`）—— 给 agent 添新工具、给用户添 `/命令`、添键位、添大模型厂商。

### 4.2 扩展从哪里加载（4 个来源，有优先级）

定义在 [loader.ts](../pi/packages/coding-agent/src/core/extensions/loader.ts)，发现逻辑在 [loader.ts:629](../pi/packages/coding-agent/src/core/extensions/loader.ts#L629)：

| 优先级 | 来源 | 路径 | 说明 |
|--------|------|------|------|
| 1（最高） | **项目本地** | `<当前目录>/.pi/extensions/` | 跟着项目走，可提交进 git |
| 2 | **全局用户** | `~/.pi/agent/extensions/` | 你个人所有项目通用 |
| 3 | **显式指定** | CLI `-e <路径>` 或配置文件 | 临时挂载 |
| 4 | **代码内工厂** | 直接传函数 | 运行时 `loadExtensionFromFactory()` 注入（[loader.ts:442](../pi/packages/coding-agent/src/core/extensions/loader.ts#L442)） |

每个来源支持三种形态（[loader.ts:537](../pi/packages/coding-agent/src/core/extensions/loader.ts#L537)）：单文件 `xxx.ts`、子目录 `xxx/index.ts`、或 npm 包（`package.json` 里声明 `"pi.extensions": [...]`）。加载用 `jiti`，所以 TS 不用预编译就能直接跑。

> **对你的意义**：你做的每个改造模块，最自然的形态就是各写成一个扩展，丢进 `.pi/extensions/`（跟项目走）或 `~/.pi/agent/extensions/`（全局生效）。**不用改核心代码**。

### 4.3 完整挂点清单

扩展能订阅的事件全部汇总在 [types.ts:993](../pi/packages/coding-agent/src/core/extensions/types.ts#L993) 的 `ExtensionEvent` 联合类型里。下面按用途分组，**这是本文档最该收藏的表**。

#### A) 生命周期类

| 挂点 | 触发时机 | 能拿到 / 能做什么 | 返回值 | 位置 |
|------|----------|------------------|--------|------|
| `project_trust` | agent 启动前，判断项目是否可信 | cwd；决定是否放行 | `yes`/`no`/`undecided` | [types.ts:503](../pi/packages/coding-agent/src/core/extensions/types.ts#L503) |
| `resources_discover` | 会话启动 / reload | 注入额外的 skill / prompt / theme 路径 | 路径数组 | [types.ts:527](../pi/packages/coding-agent/src/core/extensions/types.ts#L527) |
| `session_start` | 新建/恢复/fork/reload 会话 | **初始化扩展状态、注册动态工具、加载持久数据** | void | [types.ts:545](../pi/packages/coding-agent/src/core/extensions/types.ts#L545) |
| `session_shutdown` | 会话切换/退出前 | 清理、保存状态 | void | [types.ts:592](../pi/packages/coding-agent/src/core/extensions/types.ts#L592) |
| `agent_start` / `agent_end` | 循环开始 / 结束 | `agent_end` 带完整 messages 和 toolResults | void | [types.ts:678](../pi/packages/coding-agent/src/core/extensions/types.ts#L678) |
| `turn_start` / `turn_end` | 每回合开始 / 结束 | **常用于监控上下文用量、触发压缩** | void | [types.ts:689](../pi/packages/coding-agent/src/core/extensions/types.ts#L689) |

#### B) 消息与上下文类（记忆 / RAG 改造的核心区）

| 挂点 | 触发时机 | 能做什么 | 返回值 | 位置 |
|------|----------|----------|--------|------|
| `input` | 收到用户输入、调大模型前 | 改写/拦截用户输入（三级链：continue→transform→handled） | `{action, text?, images?}` | [types.ts:792](../pi/packages/coding-agent/src/core/extensions/types.ts#L792) |
| `before_agent_start` | agent 开始前（system prompt 已组装） | **改 system prompt**、注入首条自定义消息 | `{message?, systemPrompt?}` | [types.ts:665](../pi/packages/coding-agent/src/core/extensions/types.ts#L665) |
| `context` | **每次调大模型前** | **改整段 messages 数组**（注入/删除/改写）；深拷贝传入，多扩展串联，最后一个生效 | `{messages?}` | [types.ts:646](../pi/packages/coding-agent/src/core/extensions/types.ts#L646) |
| `message_start` | 消息开始 | 记录 | void | [types.ts:704](../pi/packages/coding-agent/src/core/extensions/types.ts#L704) |
| `message_update` | assistant 流式更新（逐 token） | 实时追踪、计 token | void | [types.ts:710](../pi/packages/coding-agent/src/core/extensions/types.ts#L710) |
| `message_end` | 一条消息完整收到后 | **改写整条消息**（不能改 role） | `{message?}` | [types.ts:717](../pi/packages/coding-agent/src/core/extensions/types.ts#L717) |

#### C) 工具类（安全 / 权限改造的核心区）

| 挂点 | 触发时机 | 能做什么 | 返回值 | 位置 |
|------|----------|----------|--------|------|
| `tool_call` | 工具执行前 | **【阻止】执行 或【改写入参】**（改参数靠原地 mutate `event.input`） | `{block?, reason?}` | [types.ts:814](../pi/packages/coding-agent/src/core/extensions/types.ts#L814) |
| `tool_result` | 工具执行后、回喂大模型前 | 改写结果 content / details / isError | `{content?, details?, isError?}` | [types.ts:875](../pi/packages/coding-agent/src/core/extensions/types.ts#L875) |
| `tool_execution_start/update/end` | 工具执行的三个时点 | 记录、显示进度、收集流式输出 | void | [types.ts:723](../pi/packages/coding-agent/src/core/extensions/types.ts#L723) |
| `user_bash` | 用户手敲 `!`/`!!` 跑 bash | **完全替换执行逻辑** 或拦截 | `{operations?, result?}` | [types.ts:774](../pi/packages/coding-agent/src/core/extensions/types.ts#L774) |

> `tool_call` 针对内置工具有**强类型版本**：`BashToolCallEvent` / `ReadToolCallEvent` / `EditToolCallEvent` / `WriteToolCallEvent` 等（[types.ts:819](../pi/packages/coding-agent/src/core/extensions/types.ts#L819)），配合类型守卫 `isToolCallEventType()`（[types.ts:934](../pi/packages/coding-agent/src/core/extensions/types.ts#L934)）用起来类型安全。

#### D) 模型与提供方类

| 挂点 | 触发时机 | 能做什么 | 返回值 | 位置 |
|------|----------|----------|--------|------|
| `model_select` | 切换模型 | 记录、应用模型专属配置 | void | [types.ts:752](../pi/packages/coding-agent/src/core/extensions/types.ts#L752) |
| `thinking_level_select` | 改思考强度 | 记录 | void | [types.ts:762](../pi/packages/coding-agent/src/core/extensions/types.ts#L762) |
| `before_provider_request` | 发给厂商 API 前 | **替换整个请求 payload**（改 system / tools / 参数） | 替换后的 payload | [types.ts:651](../pi/packages/coding-agent/src/core/extensions/types.ts#L651) |
| `after_provider_response` | 收到响应后、消费流前 | 看响应头、记指标 | void | [types.ts:658](../pi/packages/coding-agent/src/core/extensions/types.ts#L658) |

#### E) 会话 / 压缩 / 历史树类（记忆沉淀与自进化都用得上）

| 挂点 | 触发时机 | 能做什么 | 返回值 | 位置 |
|------|----------|----------|--------|------|
| `session_before_switch` | 切换会话前 | 确认、阻止 | `{cancel?}` | [types.ts:555](../pi/packages/coding-agent/src/core/extensions/types.ts#L555) |
| `session_before_fork` | fork 前 | 确认、阻止、跳过恢复 | `{cancel?, skipConversationRestore?}` | [types.ts:562](../pi/packages/coding-agent/src/core/extensions/types.ts#L562) |
| `session_before_compact` | **压缩前**（含溢出自动压缩） | **完全替换压缩逻辑** 或改参数 | `{cancel?, compaction?}` | [types.ts:568](../pi/packages/coding-agent/src/core/extensions/types.ts#L568) |
| `session_compact` | 压缩完成后 | 记录摘要、上传统计 | void | [types.ts:582](../pi/packages/coding-agent/src/core/extensions/types.ts#L582) |
| `session_before_tree` / `session_tree` | 在历史分支间导航前/后 | 自定义摘要、阻止导航 | 见 [types.ts:1073](../pi/packages/coding-agent/src/core/extensions/types.ts#L1073) | [types.ts:615](../pi/packages/coding-agent/src/core/extensions/types.ts#L615) |

#### F) 注册类 API（不是事件，是主动调用）

| API | 作用 | 位置 |
|-----|------|------|
| `pi.registerTool(def)` | 注册新工具供大模型调用（任意时刻，常在 `session_start`） | [types.ts:1177](../pi/packages/coding-agent/src/core/extensions/types.ts#L1177) |
| `pi.registerCommand(name, opts)` | 注册 `/命令` 供用户执行 | [types.ts:1186](../pi/packages/coding-agent/src/core/extensions/types.ts#L1186) |
| `pi.registerShortcut(key, opts)` | 注册键位快捷键 | [types.ts:1189](../pi/packages/coding-agent/src/core/extensions/types.ts#L1189) |
| `pi.registerFlag(name, opts)` | 注册 CLI 标志 | [types.ts:1198](../pi/packages/coding-agent/src/core/extensions/types.ts#L1198) |
| `pi.registerProvider(name, config)` | **注册自定义大模型厂商**（含 baseUrl / api / 自定义 streamSimple / OAuth） | [types.ts:1337](../pi/packages/coding-agent/src/core/extensions/types.ts#L1337) |
| `pi.sendMessage(...)` | 往会话发自定义消息（不发给大模型，仅 UI/记录） | [types.ts:1222](../pi/packages/coding-agent/src/core/extensions/types.ts#L1222) |
| `pi.sendUserMessage(...)` | 发一条用户消息（会触发新回合） | [types.ts:1230](../pi/packages/coding-agent/src/core/extensions/types.ts#L1230) |
| `pi.appendEntry(customType, data)` | **往会话追加自定义条目（持久化的关键，可跨分支恢复）** | [types.ts:1237](../pi/packages/coding-agent/src/core/extensions/types.ts#L1237) |
| `pi.setSessionName / getSessionName / setLabel` | 会话命名 / 条目打标 | [types.ts:1244](../pi/packages/coding-agent/src/core/extensions/types.ts#L1244) |

#### G) UI / TUI 能力（通过 `ctx.ui`）

每个事件处理器都会拿到 `ExtensionContext`，其中 `ctx.ui` 提供一整套终端 UI 能力（[types.ts:124](../pi/packages/coding-agent/src/core/extensions/types.ts#L124)）：弹窗确认 `confirm()` / 选择 `select()` / 输入 `input()`、通知 `notify()`、状态行 `setStatus()`、自定义组件 `custom()`、自定义 footer/header、甚至替换整个编辑器组件 `setEditorComponent()`。

### 4.4 `ExtensionContext`：扩展能看到/能动到什么

**能读**：完整 messages（在 `context` 事件里）、当前 model / thinkingLevel、sessionManager 的**只读**接口（getBranch/getEntries/getSessionFile）、cwd、是否 idle、abort signal、**上下文 token 用量**（`ctx.getContextUsage()`）、system prompt、所有已注册工具。

**能动**：通过事件返回值改 messages / 工具入参 / 工具结果 / system prompt / payload；通过 `ctx.compact()` 主动触发压缩；通过 `ctx.navigateTree()/fork()/switchSession()/newSession()`（命令上下文里）操作会话。

**拿不到 / 动不了**（能力边界，由 [runner.ts](../pi/packages/coding-agent/src/core/extensions/runner.ts) 决定）：
- ✗ 不能直接写 sessionManager 的历史条目（只能用 `appendEntry` **追加**，不能改旧的）
- ✗ 拿不到底层 `Agent` 的完整内部状态（只能靠事件拦截）
- ✗ 拿不到厂商 API 的原始响应对象（只有解析后的事件流）
- ✗ 已注册工具不能动态改参数 schema（只能重新注册一个）

### 4.5 派发与执行顺序（调试时必知）

事件派发在 [runner.ts](../pi/packages/coding-agent/src/core/extensions/runner.ts)。同一事件若有多个扩展订阅，**按注册顺序串行 `await` 执行**：
- 改写类事件（如 `context`）会**链式传递**：扩展 A 改了 messages，扩展 B 看到的是 A 改后的版本，最后一个生效。
- 阻止类事件（如 `session_before_*`）**第一个返回 `{cancel:true}` 就短路**，后续不再执行。

这套"串行 + 链式"的设计让扩展行为可预测、可复现，调试友好。

### 4.6 稳定性

代码里**没有 "experimental/alpha" 警告标记**，核心扩展系统是生产级的。事件用联合类型设计，新增事件不会破坏老扩展（向后兼容性好）。相对较新、可能演进的是 `registerProvider` 的 OAuth/streamSimple 部分和依赖 pi-tui 的 UI 接口。

---

## 5. 10 个最火热、最有实际价值的改造方向

下面这 10 个方向，是把 **2025–2026 年 AI Agent 领域最受关注的能力** 与 **Pi 官方留白 + 现成挂点** 对齐后挑出来的。每个方向都给了：**为什么火/有价值、挂在 Pi 的哪里、可直接参照的示例文件、难度与简历价值**。

> 顺序大致按"性价比"排（前面的更推荐先做）。你不必全做，从中挑 2–4 个组合，就是一个非常完整的项目故事。

---

### 方向 1 ⭐ 权限与安全沙箱（Permission & Sandbox）

- **为什么火/有价值**：Agent 能跑任意命令是当前最大的安全焦虑。Pi **官方明确不内置权限系统**（[usage.md:306](../pi/packages/coding-agent/docs/usage.md#L306)、[README.md:490](../pi/packages/coding-agent/README.md#L490)），但底层拦截机制全都预留好了——这是**最容易出成果、面试方一听就懂价值**的方向。
- **挂在哪**：`tool_call` 返回 `{block:true}` 拦截危险操作（[types.ts:814](../pi/packages/coding-agent/src/core/extensions/types.ts#L814)）；底层真正落在 [agent-loop.ts:598](../pi/packages/agent/src/agent-loop.ts#L598)，**拦得住、不是只提示**。配合 `project_trust`（[types.ts:503](../pi/packages/coding-agent/src/core/extensions/types.ts#L503)）做项目信任、`ctx.ui.confirm()` 做交互确认、`user_bash`（[types.ts:774](../pi/packages/coding-agent/src/core/extensions/types.ts#L774)）拦用户手敲命令。
- **参照示例**：[permission-gate.ts](../pi/packages/coding-agent/examples/extensions/permission-gate.ts)（危险 bash 拦截）、[protected-paths.ts](../pi/packages/coding-agent/examples/extensions/protected-paths.ts)（保护 `.env`/`.git`）、[project-trust.ts](../pi/packages/coding-agent/examples/extensions/project-trust.ts)、[confirm-destructive.ts](../pi/packages/coding-agent/examples/extensions/confirm-destructive.ts)、[timed-confirm.ts](../pi/packages/coding-agent/examples/extensions/timed-confirm.ts)，以及真正的容器化方案 [sandbox/](../pi/packages/coding-agent/examples/extensions/sandbox) 和 [gondolin/](../pi/packages/coding-agent/examples/extensions/gondolin)。
- **难度 / 简历价值**：难度低-中 / 价值高。可写"为开源 Agent 设计并实现了一套基于策略的权限与沙箱系统"。

---
v
### 方向 2 ⭐ 持久记忆（Long-term Memory）

- **为什么火/有价值**：当前 Agent 最大痛点是"失忆"——每次对话从零开始。长期记忆（跨会话记住事实、偏好、项目知识）是 2025 年最热的 Agent 能力之一（参考 MemGPT / Letta、ChatGPT Memory）。
- **挂在哪**：启动用 `session_start`（[types.ts:545](../pi/packages/coding-agent/src/core/extensions/types.ts#L545)）加载记忆；**注入用 `context`（[types.ts:646](../pi/packages/coding-agent/src/core/extensions/types.ts#L646)）或 `before_agent_start`（[types.ts:665](../pi/packages/coding-agent/src/core/extensions/types.ts#L665)）**；捕获新知识用 `message_end`（[types.ts:717](../pi/packages/coding-agent/src/core/extensions/types.ts#L717)）；落盘用 `pi.appendEntry`（[types.ts:1237](../pi/packages/coding-agent/src/core/extensions/types.ts#L1237)）。
- **参照示例**：[tools.ts](../pi/packages/coding-agent/examples/extensions/tools.ts)（`appendEntry` 持久化 + 会话恢复读回）、[custom-compaction.ts](../pi/packages/coding-agent/examples/extensions/custom-compaction.ts)（压缩点调模型生成摘要）、[summarize.ts](../pi/packages/coding-agent/examples/extensions/summarize.ts)。
- **难度 / 简历价值**：难度中 / 价值高。可写"实现了基于事件钩子的长期记忆层，支持自动抽取、检索注入与跨会话持久化"。

---

### 方向 3 ⭐ MCP 协议支持（Model Context Protocol）

- **为什么火/有价值**：MCP 是 2024 底 Anthropic 推出、2025 年becoming 事实标准的"Agent 工具/数据源接入协议"，OpenAI、Google 等都已跟进。**Pi 官方刻意没做 MCP**（[README.md:490](../pi/packages/coding-agent/README.md#L490) 明说"build an extension that adds MCP support"）——等于给你点名了一个高价值缺口。
- **挂在哪**：写一个扩展，在 `session_start`（[types.ts:545](../pi/packages/coding-agent/src/core/extensions/types.ts#L545)）里连接 MCP server，把 server 暴露的工具用 `pi.registerTool`（[types.ts:1177](../pi/packages/coding-agent/src/core/extensions/types.ts#L1177)）动态注册成 Pi 工具；工具的 `execute` 内部转发给 MCP server。
- **参照示例**：[dynamic-tools.ts](../pi/packages/coding-agent/examples/extensions/dynamic-tools.ts)（运行时注册工具的标准范式）、[structured-output.ts](../pi/packages/coding-agent/examples/extensions/structured-output.ts)（带自定义渲染的工具）。MCP 官方 TS SDK（`@modelcontextprotocol/sdk`）负责协议层。
- **难度 / 简历价值**：难度中-高 / 价值很高。**简历杀手锏**：可写"为 Pi 实现了 MCP 客户端扩展，使其能接入任意 MCP server 的工具与资源"。招聘方一看 MCP 就知道你跟得上最前沿。

---

### 方向 4 ⭐ 多智能体编排 / 子代理（Multi-Agent & Sub-agents）

- **为什么火/有价值**：从 AutoGPT 到 LangGraph、CrewAI、Claude 的 subagent，"主 agent 派生专精子 agent 并行干活"是 2025 年最主流的 Agent 架构演进。**Pi 官方也没内置子代理**（[usage.md:306](../pi/packages/coding-agent/docs/usage.md#L306)），但给了一个**完整的参考实现**。
- **挂在哪**：做一个"spawn_subagent"工具（`pi.registerTool`），工具 `execute` 内部再起一个 [agent](../pi/packages/agent) 实例跑子任务，通过 `onUpdate` 流式回传进度。
- **参照示例**：**[subagent/](../pi/packages/coding-agent/examples/extensions/subagent)** 目录是最完整的复杂示例（含 [subagent/index.ts](../pi/packages/coding-agent/examples/extensions/subagent/index.ts)、agents/、prompts/、自定义渲染、流式 onUpdate）。[handoff.ts](../pi/packages/coding-agent/examples/extensions/handoff.ts) 展示 agent 间交接。
- **难度 / 简历价值**：难度高 / 价值很高。可写"基于通用 agent 内核实现了多智能体编排，支持任务分解、并行子代理与结果聚合"。

---

### 方向 5 自进化 / 自我改进（Self-Evolving Agent）

- **为什么火/有价值**：让 agent 自己写新工具、自己改 prompt、把成功经验沉淀成可复用能力——这是 2025 年很前沿、很有"未来感"的方向（参考 Voyager、自改进 agent 研究）。Pi 本身就叫 "self-extensible"，对此支撑天然到位。
- **挂在哪**：动态加工具 `pi.registerTool`（[types.ts:1177](../pi/packages/coding-agent/src/core/extensions/types.ts#L1177)）；自改 system prompt 用 `before_agent_start` 返回 `systemPrompt`（[types.ts:665](../pi/packages/coding-agent/src/core/extensions/types.ts#L665)）；经验沉淀进摘要用 `session_before_compact`（[types.ts:568](../pi/packages/coding-agent/src/core/extensions/types.ts#L568)）；落盘 + 下次 `session_start` 重新加载形成闭环。
- **参照示例**：[dynamic-tools.ts](../pi/packages/coding-agent/examples/extensions/dynamic-tools.ts)、[structured-output.ts](../pi/packages/coding-agent/examples/extensions/structured-output.ts)、[system-prompt-header.ts](../pi/packages/coding-agent/examples/extensions/system-prompt-header.ts)、[custom-compaction.ts](../pi/packages/coding-agent/examples/extensions/custom-compaction.ts)。
- **难度 / 简历价值**：难度高 / 价值高（亮点强但要讲清边界，避免被质疑"噱头"）。

---

### 方向 6 RAG / 代码库语义检索（Codebase RAG）

- **为什么火/有价值**：让 agent 在改代码前先"语义检索"相关代码片段（而不是靠 grep），是 Cursor / Cody / Continue 等产品的核心竞争力。对大代码库尤其关键。
- **挂在哪**：注册一个 `semantic_search` 工具（`pi.registerTool`，[types.ts:1177](../pi/packages/coding-agent/src/core/extensions/types.ts#L1177)）让大模型主动检索；或在 `context`（[types.ts:646](../pi/packages/coding-agent/src/core/extensions/types.ts#L646)）里基于当前任务自动注入相关代码。索引构建可在 `session_start` 触发。
- **参照示例**：工具范式见 [dynamic-tools.ts](../pi/packages/coding-agent/examples/extensions/dynamic-tools.ts)；注入范式见记忆方向；现成的全文检索工具可参考内置 [grep.ts](../pi/packages/coding-agent/src/core/tools/grep.ts) / [find.ts](../pi/packages/coding-agent/src/core/tools/find.ts) 的实现风格。向量化用任意 embedding API（Pi 的 [ai](../pi/packages/ai) 包已接好多家厂商）。
- **难度 / 简历价值**：难度中-高 / 价值高。可写"实现了基于向量检索的代码库 RAG，提升大仓库下的定位准确率"。

---

### 方向 7 计划模式 / 任务编排（Plan Mode & TODO）

- **为什么火/有价值**：复杂任务先出计划、再分步执行、用 TODO 跟踪进度，是 Claude Code、Devin 等的标配，显著提升长任务可靠性。**Pi 官方未内置 plan mode 和 to-dos**（[usage.md:306](../pi/packages/coding-agent/docs/usage.md#L306)）。
- **挂在哪**：用 `pi.registerCommand`（[types.ts:1186](../pi/packages/coding-agent/src/core/extensions/types.ts#L1186)）加 `/plan` 命令；用一个只读约束 + `tool_call` 拦截（[types.ts:814](../pi/packages/coding-agent/src/core/extensions/types.ts#L814)）实现"计划阶段禁止写文件"；TODO 状态用 `pi.appendEntry`（[types.ts:1237](../pi/packages/coding-agent/src/core/extensions/types.ts#L1237)）持久化、`ctx.ui.setWidget` 显示。
- **参照示例**：[todo.ts](../pi/packages/coding-agent/examples/extensions/todo.ts)（待办管理）、`plan-mode`（examples/extensions 下的计划模式示例）、[send-user-message.ts](../pi/packages/coding-agent/examples/extensions/send-user-message.ts)。
- **难度 / 简历价值**：难度中 / 价值中-高。

---

### 方向 8 可观测性 / 评估追踪（Observability & Tracing）

- **为什么火/有价值**：LLMOps 是 2025 年企业落地 Agent 的刚需——把每次 token 消耗、工具调用、延迟、成本、失败原因记录下来，可视化、可回放（参考 LangSmith、Langfuse、OpenLLMetry）。
- **挂在哪**：订阅全套生命周期事件做埋点——`agent_start/end`（[types.ts:678](../pi/packages/coding-agent/src/core/extensions/types.ts#L678)）、`turn_start/end`（[types.ts:689](../pi/packages/coding-agent/src/core/extensions/types.ts#L689)）、`message_update`（[types.ts:710](../pi/packages/coding-agent/src/core/extensions/types.ts#L710)）、`tool_execution_*`（[types.ts:723](../pi/packages/coding-agent/src/core/extensions/types.ts#L723)）、`before_provider_request`/`after_provider_response`（[types.ts:651](../pi/packages/coding-agent/src/core/extensions/types.ts#L651)）。Pi 自己也有 [telemetry.ts](../pi/packages/coding-agent/src/core/telemetry.ts) 可参考。
- **参照示例**：[status-line.ts](../pi/packages/coding-agent/examples/extensions/status-line.ts)（实时状态）、[notify.ts](../pi/packages/coding-agent/examples/extensions/notify.ts)、[trigger-compact.ts](../pi/packages/coding-agent/examples/extensions/trigger-compact.ts)（读 `ctx.getContextUsage()`）。
- **难度 / 简历价值**：难度低-中 / 价值中-高。可对接 OpenTelemetry，写"为 Agent 接入了标准可观测性，支持 trace/成本/失败分析"。

---

### 方向 9 Agent 自动评估 / 质量门禁（Eval & Self-Critique）

- **为什么火/有价值**："怎么知道 agent 干得对不对"是落地最难的一环。LLM-as-a-judge、自我批判（self-critique）、改动后自动跑测试并回灌结果，是 2025 年评估方向的主流。
- **挂在哪**：用 `afterToolCall` / `tool_result`（[types.ts:875](../pi/packages/coding-agent/src/core/extensions/types.ts#L875)）在写文件/跑命令后自动触发校验（lint/test），把结果回灌；用 `prepareNextTurn`（[agent-loop.ts:226](../pi/packages/agent/src/agent-loop.ts#L226)）/`shouldStopAfterTurn`（[agent-loop.ts:241](../pi/packages/agent/src/agent-loop.ts#L241)）实现"不通过就让它继续修"；用子代理（方向 4）做独立 judge。
- **参照示例**：[structured-output.ts](../pi/packages/coding-agent/examples/extensions/structured-output.ts)（结构化评分输出）、[subagent/](../pi/packages/coding-agent/examples/extensions/subagent)（独立评审 agent）、[custom-compaction.ts](../pi/packages/coding-agent/examples/extensions/custom-compaction.ts)（调另一个模型）。
- **难度 / 简历价值**：难度中-高 / 价值高。

---

### 方向 10 检查点与时间旅行（Checkpoint & Time-Travel）

- **为什么火/有价值**：Agent 改崩了能一键回滚、能在历史某个分叉点重来，是提升"敢放手让 agent 干"信心的关键体验（参考 Claude Code 的 checkpoint、Cursor 的 restore）。Pi 的会话本身就是**带分支的历史树**，天然适合做这个。
- **挂在哪**：利用已有的会话树挂点 `session_before_tree` / `session_tree`（[types.ts:615](../pi/packages/coding-agent/src/core/extensions/types.ts#L615)）和 `session_before_fork`（[types.ts:562](../pi/packages/coding-agent/src/core/extensions/types.ts#L562)）；文件层面在 `tool_call`（[types.ts:814](../pi/packages/coding-agent/src/core/extensions/types.ts#L814)）拦截写操作前用 git 快照；用 `pi.registerCommand`（[types.ts:1186](../pi/packages/coding-agent/src/core/extensions/types.ts#L1186)）加 `/checkpoint`、`/rollback`。
- **参照示例**：examples/extensions 下的 `git-checkpoint.ts`、`git-merge-and-resolve.ts`、[confirm-destructive.ts](../pi/packages/coding-agent/examples/extensions/confirm-destructive.ts)；会话存取看 [session-manager.ts](../pi/packages/coding-agent/src/core/session-manager.ts)。
- **难度 / 简历价值**：难度中 / 价值中-高。

---

### 5.x 速查：10 个方向一览

| # | 方向 | 主要挂点 | 是否官方留白 | 难度 | 简历价值 |
|---|------|---------|:---:|:---:|:---:|
| 1 | 权限与安全沙箱 | `tool_call`(block) / `project_trust` | ✅ | 低-中 | 高 |
| 2 | 持久记忆 | `context` / `message_end` / `appendEntry` | 部分 | 中 | 高 |
| 3 | MCP 协议支持 | `registerTool` + `session_start` | ✅ | 中-高 | 很高 |
| 4 | 多智能体 / 子代理 | `registerTool` + 嵌套 agent | ✅ | 高 | 很高 |
| 5 | 自进化 | `registerTool` / `before_agent_start` / `session_before_compact` | 部分 | 高 | 高 |
| 6 | 代码库 RAG | `registerTool` / `context` | 否 | 中-高 | 高 |
| 7 | 计划模式 / TODO | `registerCommand` / `tool_call` / `appendEntry` | ✅ | 中 | 中-高 |
| 8 | 可观测性 / 追踪 | 全套生命周期事件 | 否 | 低-中 | 中-高 |
| 9 | 自动评估 / 质量门禁 | `tool_result` / `prepareNextTurn` / 子代理 | 否 | 中-高 | 高 |
| 10 | 检查点 / 时间旅行 | `session_*_tree` / `tool_call` + git | ✅ | 中 | 中-高 |

> **组合建议**：若想要一个主线清晰、深度够、又紧跟前沿的项目，推荐 **方向 1（安全）+ 方向 2（记忆）+ 方向 3（MCP）** 三件套——分别对应"可信、能记、可扩展"，覆盖了 Agent 落地的三大刚需，且每个都是面试方一眼能懂价值的热点。再想加亮点就补 **方向 4（多代理）**。

---

## 6. 其它你迟早会碰到的东西（速查）

- **内置工具**在 [coding-agent/src/core/tools/](../pi/packages/coding-agent/src/core/tools)：[bash.ts](../pi/packages/coding-agent/src/core/tools/bash.ts) [read.ts](../pi/packages/coding-agent/src/core/tools/read.ts) [write.ts](../pi/packages/coding-agent/src/core/tools/write.ts) [edit.ts](../pi/packages/coding-agent/src/core/tools/edit.ts)（含 [edit-diff.ts](../pi/packages/coding-agent/src/core/tools/edit-diff.ts)）[grep.ts](../pi/packages/coding-agent/src/core/tools/grep.ts) [find.ts](../pi/packages/coding-agent/src/core/tools/find.ts) [ls.ts](../pi/packages/coding-agent/src/core/tools/ls.ts)，外加 [file-mutation-queue.ts](../pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts)（文件改动串行化）、[truncate.ts](../pi/packages/coding-agent/src/core/tools/truncate.ts)（输出截断）。
- **会话与压缩**：[session-manager.ts](../pi/packages/coding-agent/src/core/session-manager.ts)（会话存取，带分支的"历史树"）、[core/compaction/](../pi/packages/coding-agent/src/core/compaction)（上下文压缩，溢出时自动触发，也可由扩展接管）。
- **系统提示**：[system-prompt.ts](../pi/packages/coding-agent/src/core/system-prompt.ts)、[prompt-templates.ts](../pi/packages/coding-agent/src/core/prompt-templates.ts)。
- **技能 / 诊断 / 遥测**：[skills.ts](../pi/packages/coding-agent/src/core/skills.ts)、[diagnostics.ts](../pi/packages/coding-agent/src/core/diagnostics.ts)、[telemetry.ts](../pi/packages/coding-agent/src/core/telemetry.ts)。
- **多模型/厂商**：[ai/src/providers/](../pi/packages/ai/src/providers) 下每个厂商一个文件（[anthropic.ts](../pi/packages/ai/src/providers/anthropic.ts) / [openai-responses.ts](../pi/packages/ai/src/providers/openai-responses.ts) / [google.ts](../pi/packages/ai/src/providers/google.ts) / [amazon-bedrock.ts](../pi/packages/ai/src/providers/amazon-bedrock.ts) / [mistral.ts](../pi/packages/ai/src/providers/mistral.ts) 等），[register-builtins.ts](../pi/packages/ai/src/providers/register-builtins.ts) 注册内置厂商，`models.generated.ts` 是**自动生成**的模型清单（**别手改**，改 `scripts/generate-models.ts` 后重新生成——见 [AGENTS.md](../pi/AGENTS.md) 第 24 行）。
- **入口**：[main.ts](../pi/packages/coding-agent/src/main.ts) / [cli.ts](../pi/packages/coding-agent/src/cli.ts)（CLI 启动）、[index.ts](../pi/packages/coding-agent/src/index.ts)（SDK 导出）；交互式 TUI 在 [src/modes/interactive/](../pi/packages/coding-agent/src/modes/interactive)，还有 RPC 模式 [src/modes/rpc/](../pi/packages/coding-agent/src/modes/rpc)。
- **配置/信任**：`.pi/` 目录放项目级配置与扩展；[settings-manager.ts](../pi/packages/coding-agent/src/core/settings-manager.ts)、[project-trust.ts](../pi/packages/coding-agent/src/core/project-trust.ts)、[trust-manager.ts](../pi/packages/coding-agent/src/core/trust-manager.ts)。
- **沙箱/容器化**：原始 Pi 不内置权限，但文档给了三种隔离方案（Gondolin 微 VM / 纯 Docker / OpenShell），见 [containerization.md](../pi/packages/coding-agent/docs/containerization.md) 与 [README.md](../pi/README.md) 第 37-45 行。

---

## 7. 关键文件索引（动手时直接跳）

**Agent 发动机（agent 包）**
- 对话循环：[agent-loop.ts:155](../pi/packages/agent/src/agent-loop.ts#L155)（`runLoop`）
- 工具执行：[agent-loop.ts:373](../pi/packages/agent/src/agent-loop.ts#L373)（`executeToolCalls`）
- 大模型边界：[agent-loop.ts:275](../pi/packages/agent/src/agent-loop.ts#L275)（`streamAssistantResponse`）
- 有状态封装：[agent.ts:166](../pi/packages/agent/src/agent.ts#L166)（`Agent` 类）
- 所有契约/底层钩子：[types.ts](../pi/packages/agent/src/types.ts)

**扩展系统（coding-agent 包）**
- 全部挂点类型：[extensions/types.ts](../pi/packages/coding-agent/src/core/extensions/types.ts)
- 事件联合类型：[types.ts:993](../pi/packages/coding-agent/src/core/extensions/types.ts#L993)
- 加载/发现：[loader.ts:629](../pi/packages/coding-agent/src/core/extensions/loader.ts#L629)
- 派发/调度：[runner.ts](../pi/packages/coding-agent/src/core/extensions/runner.ts)
- 70 个示例：[examples/extensions/](../pi/packages/coding-agent/examples/extensions)

**10 个方向的最佳起手示例**
- 安全：[permission-gate.ts](../pi/packages/coding-agent/examples/extensions/permission-gate.ts)、[protected-paths.ts](../pi/packages/coding-agent/examples/extensions/protected-paths.ts)、[sandbox/](../pi/packages/coding-agent/examples/extensions/sandbox)
- 记忆：[custom-compaction.ts](../pi/packages/coding-agent/examples/extensions/custom-compaction.ts)、[tools.ts](../pi/packages/coding-agent/examples/extensions/tools.ts)
- MCP / 动态工具：[dynamic-tools.ts](../pi/packages/coding-agent/examples/extensions/dynamic-tools.ts)、[structured-output.ts](../pi/packages/coding-agent/examples/extensions/structured-output.ts)
- 多代理：[subagent/](../pi/packages/coding-agent/examples/extensions/subagent)、[handoff.ts](../pi/packages/coding-agent/examples/extensions/handoff.ts)
- 自进化：[system-prompt-header.ts](../pi/packages/coding-agent/examples/extensions/system-prompt-header.ts)、[dynamic-tools.ts](../pi/packages/coding-agent/examples/extensions/dynamic-tools.ts)
- 计划/TODO：[todo.ts](../pi/packages/coding-agent/examples/extensions/todo.ts)
- 可观测性：[status-line.ts](../pi/packages/coding-agent/examples/extensions/status-line.ts)、[telemetry.ts](../pi/packages/coding-agent/src/core/telemetry.ts)

---

## 8. 一页纸总结

- **Pi = 分层的开源编程智能体框架**：tui（界面）← ai（多厂商大模型）← agent（通用对话循环）← coding-agent（编程产品 + 扩展系统）。
- **发动机在 [agent](../pi/packages/agent) 包**：`runLoop` 双层循环驱动"大模型回复 ↔ 工具执行"，直到大模型不再要工具。状态封装在 `Agent` 类，有 steering / follow-up 两个插话队列。
- **改造接口在 [coding-agent](../pi/packages/coding-agent) 的扩展系统**：一个扩展就是一个默认导出工厂函数的模块，通过 `pi.on(事件)` 拦截改写 + `pi.registerXxx()` 注册新能力，丢进 `.pi/extensions/` 即可生效，**几乎不用动核心**。
- **官方留白 = 你的机会**：Pi 刻意不内置 MCP、子代理、权限弹窗、计划模式、待办——这些正是当前最火的 Agent 能力，且挂点全都备好了。
- **10 个最火热方向**：① 权限沙箱 ② 持久记忆 ③ MCP ④ 多代理 ⑤ 自进化 ⑥ 代码 RAG ⑦ 计划模式 ⑧ 可观测性 ⑨ 自动评估 ⑩ 检查点。**推荐组合：安全 + 记忆 + MCP（+ 多代理）**，覆盖"可信、能记、可扩展、能协作"四大刚需。
- **能力边界**：扩展能读 messages/state、能改 messages/工具/prompt/payload、能追加会话条目；但不能改历史条目、拿不到 Agent 完整内部状态、拿不到厂商原始响应。
