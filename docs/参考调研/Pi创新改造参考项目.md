# Pi-AgentX：Coding Agent Engineering Harness 路线图

> 调研日期：2026-06-27  
> 目标：把 Pi 改造成一个真正强大的 AI Coding Agent 项目，而不是“套 API + 堆功能”的 demo。  
> 重要说明：本文只使用 Claude Code 官方文档、公开仓库信息、公开产品资料和公开研究作为依据，不引用、不分析任何非公开或泄露源码。

## 0. 项目背景：为什么要做 Pi-AgentX

以 Claude Code、Codex、Devin、OpenHands 等为代表的现代 Coding Agent 已经非常成熟，能力边界已经从“代码补全”扩展到代码理解、任务规划、文件编辑、工具调用、测试修复、多轮迭代和工程交付。当前真正有技术含量的问题，已经不是证明 Agent 能不能写代码，也不是重新造一个 Claude Code，而是如何围绕成熟 Agent 的模型执行链路，系统化治理上下文、工具、Skill、权限、缓存、成本、评测和自进化反馈。

头部 Coding Agent 的产品能力很强，但多数以闭源形态存在。它们内部的上下文组织、Prompt cache 命中策略、工具治理、Skill 选择、多 Agent 协作、失败复盘、自我改进和成本控制机制难以被审计、复现和二次扩展。开源 Agent 项目虽然透明，但很多更偏向单点能力、研究原型或局部框架，缺少一套专门围绕模型周边工程的 Harness：既能接入现有 Agent，又能对模型请求、工具调用、上下文注入、Skill 路由和评测反馈做统一治理。

Pi 本身具备清晰的 Agent 分层、工具注册、上下文注入、生命周期 Hook 和扩展机制，适合作为 Coding Agent Harness 的底座。基础版本 Pi 刻意把 MCP、子代理、权限弹窗、计划模式、待办、后台任务等现代 Agent 必备能力留给扩展去实现，这意味着 Pi-AgentX 不需要重写 Agent 主循环，而是可以在 `context`、`before_provider_request`、`tool_call`、`tool_result`、`appendEntry` 等关键挂点上构建模型周边治理层。

本项目基于 Pi 构建 Pi-AgentX，目标不是替代 Claude Code，而是把成熟 Coding Agent 背后的关键工程能力拆解为开源、可审计、可复现、可扩展的 Harness 能力。Pi-AgentX 重点围绕模型执行链路做上下文预算、Prompt cache 命中观测、MCP 工具治理、Skill Top-K 路由、权限沙箱、任务 Trace、多 Agent 评测和自进化 Skill 机制，用可观测、可回放、可评测的方式优化 Agent 在真实代码任务中的稳定性、成本和成功率。

## 1. 项目定位

**Pi-AgentX 是一个面向成熟 Coding Agent 的模型执行与治理 Harness。**

它基于 Pi 的扩展机制，不重新实现 Coding Agent 产品本身，而是在模型调用、上下文组织、工具执行、Skill 路由、权限控制、评测反馈这些关键链路上叠加五个 Harness：

| Harness | 核心职责 | 面试官应该看到的技术能力 |
|---|---|---|
| Execution Harness | 任务规划、执行、审批、回滚、验收与 Trace | 长任务状态机、权限门禁、失败恢复、产物溯源 |
| Tool Runtime Harness | MCP Broker、工具预算、权限沙箱、结构化错误与浏览器验证 | 工具系统治理、运行时安全、外部生态接入 |
| Skill Memory Harness | 大规模 Skill 注册、Top-K 路由、信任分、自进化与项目记忆 | 能力生态治理、检索路由、安全供应链、持续学习 |
| Context Cost Harness | 上下文预算、Prompt cache、代码库 RAG、最新文档检索与模型路由 | 长上下文工程、缓存命中、成本控制、模型调度 |
| Eval Collaboration Harness | Subagent 协作、权限衰减、Worktree 隔离、真实任务 Benchmark | 多代理协作、隔离执行、量化评测、工程闭环 |

项目核心价值不是“做一个能聊天写代码的 Agent”，而是把成熟 Coding Agent 背后的模型周边工程能力做成可插拔、可审计、可复现、可量化的 Harness。

## 2. 核心技术难点

| 难点 | 为什么难 | Pi-AgentX 的解决方向 |
|---|---|---|
| 长任务治理 | 真实研发任务会跨多轮规划、编辑、测试、修复，失败后需要定位和恢复 | 把用户请求封装为 Job，用 Plan/Act/Review、Trace、Checkpoint、Acceptance 管理完整生命周期 |
| 权限与运行时安全 | Agent 能读写文件、执行命令、访问网络和调用 MCP，风险边界必须清晰 | 通过 Policy Gate、capability profile、protected paths、network policy、审批记录和 sandbox 做统一治理 |
| 大规模 Skill 治理 | Skill 数量增长后会出现路由错误、上下文污染、能力冲突和供应链风险 | 用 Skill Registry、Top-K routing、trust score、usage stats、security scan 和受控自进化管理能力生态 |
| 上下文与成本控制 | 长代码库、历史会话、工具结果和文档都会挤占上下文，成本与质量难平衡 | 设计 cache-friendly prompt layout、context budget、codebase RAG、latest docs 注入、cache hit/miss 观测和 Agent Router |
| 多 Agent 协作与评测 | 多代理并行容易产生权限过大、写入冲突、结果不可验证和成本失控 | 用 Agent Card、delegation、permission decay、worktree isolation、角色化子代理和 Benchmark 形成闭环 |

## 3. 成功标准与效果指标

简历项目不能只写“实现了某某系统”，必须能证明效果。Pi-AgentX 的效果用以下指标衡量：

| 指标 | 说明 | 关联模块 |
|---|---|---|
| 真实任务完成率 | 在真实仓库修复 bug、补功能、改测试的通过比例 | Execution Harness、Eval Collaboration Harness |
| 测试通过率 | Agent 完成任务后自动测试、回归测试的通过比例 | Execution Harness |
| 平均修复轮数 | 从首次失败到最终通过需要的迭代次数 | Execution Harness、Context Cost Harness |
| 回滚恢复成功率 | checkpoint/rewind 后能否恢复到可继续执行状态 | Execution Harness |
| 工具调用失败恢复率 | timeout、auth、schema、permission、rate limit 等失败后能否分类并修复 | Tool Runtime Harness |
| Prompt cache 命中率 | 稳定前缀、文档上下文、代码库摘要等是否复用成功 | Context Cost Harness |
| Skill 路由准确率 | Top-K Skill 是否命中任务真正需要的能力 | Skill Memory Harness |
| 单任务平均 token 成本 | 完成相同任务时的输入、输出与工具成本变化 | Context Cost Harness |
| 多 Agent 协作收益 | Review/Test/Security 子代理是否降低遗漏、回归和安全风险 | Eval Collaboration Harness |

## 4. 可展示 Demo 场景

| 场景 | 展示内容 | 证明价值 |
|---|---|---|
| 高风险重构任务 | Agent 先规划，识别高风险文件，进入审批，创建 checkpoint，执行修改，跑测试，失败后 rewind 或继续修复 | 证明任务治理、权限控制、Trace、回滚和验收闭环 |
| MCP 工具治理 | 接入 GitHub、文件系统、Playwright MCP，展示 tool budget、MCP lint、structured errors、protected paths 和浏览器验收 | 证明外部工具不是简单接入，而是可治理、可审计、可控风险 |
| 100+ Skill 路由 | 构造大量 Skill，针对不同任务展示 Top-K routing、trust score、使用统计、安全扫描和上下文注入 | 证明 Skill 生态可以规模化，不会变成 prompt 堆砌 |
| 多 Agent Review/Test/Security | 主 Agent 委派 review、test、security 子代理，子代理在隔离 worktree 中输出结构化证据，主 Agent 汇总验收 | 证明复杂任务可以分工协作，并且结果可验证 |

## 5. 核心定位

我们不是要在简历上列 20 个零散功能，也不是重新造一个完整 Coding Agent 产品，而是要把这些能力压缩成 **5 个 Harness 模块**。功能不减少，只改变组织方式。

**Pi-AgentX：一个基于 Pi 扩展系统、围绕成熟 Coding Agent 模型执行链路构建的 Engineering Harness。**

硬标准：

- 不做低配版。每个能力都必须有治理、指标、审计、回滚或验收闭环。
- 不做纯 prompt demo。所有关键能力必须落到工具、事件、状态、配置或数据结构。
- 不做无法证明效果的“玄学增强”。必须能用 trace、test、eval、成本或成功率说明价值。

## 6. 简历上的 5 个模块

| 模块 | 合并的能力 | 一句话价值 |
|---|---|---|
| Execution Harness | Plan/Act/Review、Policy Gate、Human Decision、Trace、Provenance、Checkpoint、Task Job、Acceptance | 把代码任务变成可规划、可审批、可恢复、可验收的工程 Job |
| Tool Runtime Harness | MCP Broker、MCP lint、tool budget、structured errors、Runtime Sandbox、Browser Use、Agentic UI | 让外部工具接入可治理、可审计、可控风险 |
| Skill Memory Harness | Skill Registry、Top-K routing、trust、stats、skill security、self-evolution、PI.md、workflow learning | 解决多 Skill 场景的能力冲突、上下文污染和长期成长 |
| Context Cost Harness | prompt cache、context budget、codebase RAG、latest docs、cost stats、Agent Router | 让 agent 更准、更便宜，并能量化成本收益 |
| Eval Collaboration Harness | Agent Card、delegation、permission decay、subagents、worktree、review/test/security agents、benchmark | 让复杂任务多代理协作，并用真实任务证明效果 |

## 7. Execution Harness

**包含能力**

- Plan / Act / Review 模式
- Policy Gate
- Human Decision Layer
- Agent Provenance
- Checkpoint / Rewind
- Task Harness / Background Jobs
- Acceptance checklist

**低配版不要做**

- 只有一个 `/plan` 命令。
- 只是弹窗问“是否允许”。
- 只记录日志，不可回放、不可恢复。
- 只在最后跑一次测试。

**高级版要做**

- 模式驱动权限：计划只读，执行需审批，审查默认只读。
- 所有工具调用进入 Policy Gate，统一判定风险、路径、网络、MCP 范围。
- 低风险自动，高风险审批，审批记录进入 trace。
- 每个任务生成 trace id，串联计划、工具、diff、测试、成本、checkpoint。
- 每个任务生成 acceptance checklist，完成后输出 `accepted / needsFix / blocked`。
- 用户请求封装为 Job，支持 `queued / running / waitingApproval / failed / passed / merged`。
- `write/edit` 前后记录 patch，危险 bash 前自动 checkpoint，支持 `/rewind`。

**Pi 挂点**

- `tool_call`：权限拦截、风险审批、protected paths。
- `tool_result`：记录结果、触发测试、生成 acceptance 状态。
- `appendEntry`：持久化 trace、approval、checkpoint、job 状态。
- `registerCommand`：注册 `/plan`、`/act`、`/review`、`/checkpoint`、`/rewind`、`/trace`、`/job`。

**简历表达**

设计并实现 Execution Harness，将复杂代码任务抽象为可规划、可审批、可挂起、可恢复、可验收的 Job，支持 Plan/Act/Review 模式、风险感知权限门禁、checkpoint/rewind、产物溯源和任务级审计 trace。

## 8. Tool Runtime Harness

**包含能力**

- MCP client
- MCP Broker
- MCP Tool Quality Optimizer
- Tool budget
- Structured errors
- Runtime Capability Sandbox
- Protected paths / network policy
- Browser Use / Agentic UI

**低配版不要做**

- 只支持 `.pi/mcp.json`。
- 只把 MCP tools 注册成 Pi tools。
- 只做安全提示，不做能力边界。
- 只返回文本 tool result，没有结构化渲染。

**高级版要做**

- 所有 MCP 调用先经过 MCP Broker。
- 每个 MCP server/tool 记录 trust、latency、failureRate、riskLevel、authStatus、lastUsed。
- MCP tool budget：每轮最大调用次数、超时、成本。
- 统一结构化错误：timeout、auth、schema、permission、rate_limit、tool_bug。
- `/mcp lint` 检查 tool description 是否包含 purpose、input constraints、side effects、examples、failure modes、auth requirements。
- 每个 mode、skill、subagent、MCP server 都绑定 capability profile：readOnly、editWorkspace、runTests、networkOff、mcpLimited、dangerousDenied。
- 通过 Playwright MCP 做浏览器验收，采集截图、console errors、DOM summary。
- 复杂 tool result 支持交互式展示：diff、trace tree、test report、approval form。

**Pi 挂点**

- `session_start`：连接 MCP server。
- `registerTool`：动态注册 MCP tools。
- `tool_call`：MCP 调用进入 broker/policy/sandbox。
- `tool_result`：记录 structured errors、latency、failure rate。
- `ctx.ui`：展示审批、trace、测试和浏览器验收结果。

**简历表达**

构建 Tool Runtime Harness，支持 MCP Broker、工具质量 lint、调用预算、结构化错误、runtime capability sandbox、protected paths 与 Playwright MCP 浏览器验收，使外部工具接入可治理、可审计、可控风险。

## 9. Skill Memory Harness

**包含能力**

- Skill Registry
- Top-K Skill Routing
- Skill stats
- Skill trust / supply-chain security
- Self-evolving Skill Factory
- Project Memory / `PI.md`
- Hermes-style Workflow Learning

**低配版不要做**

- 扫描 `SKILL.md` 后全部塞进 prompt。
- 只有 skill 列表，没有统计和治理。
- 让 agent 直接修改已启用 skill。
- 只有记忆文件，没有审查、遗忘和来源。

**高级版要做**

- 建立 Skill Registry：name、description、scope、tags、version、trust、lastUsed、successRate、tokenCost、enabled。
- 每轮任务做 Top-K skill routing，只注入少量相关 skill 摘要。
- 完整 skill 内容按需加载，不常驻上下文。
- 记录 skill 命中、成本、成功率、失败原因。
- 第三方 skill 默认 untrusted，加载前扫描 prompt injection、读取密钥、上传文件、远程下载等风险。
- 自进化遵循：经验提取 -> 候选 skill -> 安全扫描 -> 验证任务 -> 人类批准 -> 启用 -> 统计效果。
- `PI.md` 存项目规则、常用命令、架构约定；记忆必须可编辑、可审查、可忘记。
- `/workflow learn` 从成功任务抽取 workflow template，`/workflow replay` 复用时仍经过 Policy Gate。

**Pi 挂点**

- `resources_discover`：发现 skill 路径。
- `context`：注入 Top-K skill 摘要和相关记忆。
- `tool_result` / `message_end`：捕获失败、成功和重复模式。
- `session_before_compact`：沉淀长期经验。
- `appendEntry`：记录 skill 使用、候选 skill、workflow、memory。
- `registerCommand`：注册 `/skill`、`/memory`、`/workflow`。

**简历表达**

实现 Skill Memory Harness，支持大规模 Skill registry、Top-K 自动路由、信任分级、使用统计、供应链安全扫描、受控自进化 Skill Factory，以及项目级记忆和 workflow learning，解决多 Skill 场景下的上下文污染、能力冲突和长期成长问题。

## 10. Context Cost Harness

**包含能力**

- Prompt Cache / Context 成本工程
- Codebase RAG
- Latest docs
- Context inspect
- Cost dashboard
- Cache hit/miss
- Agent Router 的模型/工具路由部分

**低配版不要做**

- 只统计 token。
- 只做简单压缩。
- 为了 RAG 而 RAG，没有命中评估。
- 所有任务都用同一模型和同一流程。

**高级版要做**

- 设计 cache-friendly prompt layout：system prompt、stable tool schemas、MCP summaries、project rules、selected skill summaries、dynamic task context、recent messages。
- 记录 input/output tokens、cache read/write tokens、estimated cost、cache hit rate、cache bust reason。
- `/cache stats`、`/context inspect`、`/cost` 展示成本和上下文状态。
- Codebase RAG 返回文件路径、片段、符号名、置信度和 citation。
- Latest docs 注入必须可追踪来源，避免模型使用过期 API。
- Agent Router 按任务类型选择 model、tools、skills、subagents、test strategy。
- 根据历史 eval 调整 routing policy。

**Pi 挂点**

- `before_provider_request`：观测最终 payload 和 prompt layout。
- `after_provider_response`：记录响应、headers、cache/cost 指标。
- `getContextUsage()`：记录上下文使用率。
- compaction events：记录压缩对缓存和成本的影响。
- `context`：注入 RAG、latest docs、selected skills、project memory。

**简历表达**

构建 Context Cost Harness，设计 cache-friendly prompt layout、上下文预算、代码库语义检索、latest docs 注入、cache hit/miss 观测和任务类型感知模型路由，在保证准确率的同时量化并优化 token 成本。

## 11. Eval Collaboration Harness

**包含能力**

- Agent Identity / Verifiable Delegation
- Agent Teams
- Worktree isolation
- Reviewer / Tester / Security agents
- Benchmark / Reproducibility Eval
- Success/cost dashboard
- Agent Router 的子代理路由部分

**低配版不要做**

- 只是 spawn subagent。
- 多代理共享同一权限，无法追踪委托链。
- 并行写同一工作区。
- 只做 demo，不做真实任务评测。

**高级版要做**

- 每个 subagent 有 Agent Card：role、capabilities、allowedTools、trustLevel。
- 父 agent 委托子 agent 时生成 delegation record。
- 子 agent 权限不能超过父 agent 授权范围。
- 内置 planner、explorer、coder、reviewer、tester、security 角色。
- 写文件子代理必须使用独立 git worktree 或串行执行。
- 子代理输出结构化：结论、证据、风险、建议、引用文件。
- `eval_cases/` 保存 task prompt、repo fixture、expected behavior、test command、scoring rubric。
- `/eval run` 输出 pass rate、avg turns、avg cost、avg tool calls、repair loops、failure categories。
- 对比 no skill routing / skill routing、no memory / memory、no RAG / RAG、no test loop / test loop、no agent teams / agent teams。

**Pi 挂点**

- `registerTool`：注册 `spawn_subagent`。
- `appendEntry`：记录 Agent Card、delegation、subagent result、eval result。
- `tool_call`：限制子代理权限和 worktree 写入。
- `registerCommand`：注册 `/agent`、`/eval`、`/team`。

**简历表达**

设计 Eval Collaboration Harness，支持 Agent Card、可验证委托、权限衰减、多角色子代理、worktree 隔离、review/test/security agents，并通过可复现实验评测成功率、成本、修复轮数和失败原因。

## 12. 标杆对齐与取舍

Pi-AgentX 的标杆不是低配 Agent demo，也不是和 Claude Code 正面竞争产品体验，而是成熟 Coding Agent 背后的模型周边工程能力。取舍原则是：**Claude Code 作为成熟产品体验和工程能力标杆，Pi-AgentX 作为开源可审计、可复现、可扩展的 Agent Engineering Harness。**

| 能力维度 | Claude Code / 成熟产品强在哪里 | Pi-AgentX 要怎么做 | 取舍倾向 |
|---|---|---|---|
| 任务执行 | 产品化 Plan/Act、工具调用、上下文组织和交互体验成熟 | 在 Pi Hook 上实现 Job 状态机、Trace、Checkpoint、Acceptance，把执行链路完全开放 | 产品体验参考 Claude Code，执行治理选择 Pi-AgentX Harness |
| 权限治理 | 权限模式、工具确认、危险操作拦截更成熟 | Policy Gate 统一治理 file/shell/network/MCP，审批记录进入 trace，可回放、可度量 | 核心策略对齐 Claude Code，但实现要开放、可配置、可评测 |
| MCP 工具体系 | MCP 接入生态完整，产品使用路径成熟 | 做 MCP Broker、tool budget、MCP lint、structured errors、trust/failure stats | 不只接入 MCP，而是把 MCP 当作可治理工具市场 |
| Skill / Memory | 成熟产品有稳定记忆和指令机制 | 扩展成 Skill Registry、Top-K routing、trust score、usage stats、security scan、自进化 Skill Factory | 基础记忆参考成熟产品，高级 Skill 治理做成 Pi-AgentX 差异点 |
| 上下文与成本 | 头部产品在 prompt caching、上下文裁剪、模型适配上更稳定 | 显式设计 cache-friendly layout、cache hit/miss、context budget、RAG、Agent Router | 短期效果参考成熟产品，长期用指标证明成本收益 |
| 多 Agent 协作 | 云端任务、子代理、PR 工作流体验更完整 | Agent Card、delegation、permission decay、worktree isolation、review/test/security agents | 闭源产品负责体验标杆，Pi-AgentX 负责开放协作协议和可验证委托 |
| 评测闭环 | 产品内部评测不可见 | 自建真实任务 Benchmark，记录 pass rate、avg turns、avg cost、repair loops、failure categories | Pi-AgentX 必须用公开评测证明效果，这是简历说服力来源 |

## 13. 实施顺序

虽然简历压缩成 5 个模块，实际实现仍然按依赖顺序推进：

| 顺序 | 模块 | 先做什么 | 后做什么 |
|---:|---|---|---|
| 1 | Execution Harness | Plan/Act/Review、Policy Gate、Trace | Checkpoint、Acceptance、Job lifecycle |
| 2 | Tool Runtime Harness | MCP client、MCP Broker、protected paths | MCP lint、capability sandbox、Browser Use |
| 3 | Skill Memory Harness | Skill Registry、routing、trust、stats | Self-evolving Skill Factory、workflow learning |
| 4 | Context Cost Harness | cache layout、context inspect、cost stats | RAG、latest docs、Agent Router |
| 5 | Eval Collaboration Harness | Agent Card、delegation、review/test/security agents | worktree isolation、benchmark dashboard |

## 14. 简历版本

**项目总述**

基于 Pi 开源 Coding Agent 框架设计并实现 Pi-AgentX，一个面向 Coding Agent 的模型执行与治理 Harness。项目围绕模型调用链路构建上下文预算、Prompt cache 命中观测、MCP 工具治理、Skill Top-K 路由、权限沙箱、任务 Trace、多 Agent 评测和自进化 Skill 机制，用可观测、可回放、可评测的方式优化 Agent 在真实代码任务中的稳定性、成本和成功率。

最终简历只写这 5 点：

- **Execution Harness**：围绕 Agent 任务执行链路实现 Plan/Act/Review、风险感知 Policy Gate、checkpoint/rewind、任务 trace、产物溯源和 acceptance checklist，使长任务可追踪、可恢复、可验收。
- **Tool Runtime Harness**：构建 MCP Broker 与 runtime capability sandbox，支持 MCP 工具预算、tool quality lint、结构化错误、protected paths、网络策略和 Playwright MCP 浏览器验收，把工具调用从“可用”提升为“可治理”。
- **Skill Memory Harness**：实现大规模 Skill registry、Top-K skill routing、信任分级、使用统计、供应链安全扫描、受控自进化 Skill Factory、项目记忆和 workflow learning，解决大规模 Skill 的选择、冲突和安全问题。
- **Context Cost Harness**：设计 cache-friendly prompt layout、上下文预算、codebase RAG、latest docs 注入、cache hit/miss 观测和任务类型感知模型路由，量化优化准确率与 token 成本。
- **Eval Collaboration Harness**：实现 Agent Card、可验证委托、权限衰减、多角色子代理、worktree 隔离和真实任务 benchmark，用成功率、成本、修复轮数和失败分类证明系统效果。

## 15. 完整能力映射

| 原能力 | 合并到哪个模块 |
|---|---|
| Plan Mode + 权限模式 | Execution Harness |
| Policy Gate + Human Decision Layer | Execution Harness |
| 审计 Trace + Agent Provenance | Execution Harness |
| 自动测试质量门禁 + Acceptance | Execution Harness |
| Checkpoint / Rewind | Execution Harness |
| Background Jobs / Cloud-style Tasks | Execution Harness |
| MCP client + MCP Broker | Tool Runtime Harness |
| MCP Tool Quality Optimizer | Tool Runtime Harness |
| Runtime Capability Sandbox | Tool Runtime Harness |
| Browser Use / Agentic UI | Tool Runtime Harness |
| Skill 治理与自动路由 | Skill Memory Harness |
| Skill 安全与供应链治理 | Skill Memory Harness |
| 自进化 Skill Factory | Skill Memory Harness |
| Project Memory / `PI.md` | Skill Memory Harness |
| Hermes-style Workflow Learning | Skill Memory Harness |
| Prompt Cache / Context 成本工程 | Context Cost Harness |
| Codebase RAG + latest docs | Context Cost Harness |
| Agent Router：模型/工具/skill 路由 | Context Cost Harness |
| Agent Identity / Verifiable Delegation | Eval Collaboration Harness |
| Agent Teams + worktree | Eval Collaboration Harness |
| Agent Router：子代理路由 | Eval Collaboration Harness |
| Benchmark / Reproducibility Eval | Eval Collaboration Harness |

## 16. 公开参考项目与研究

| 类型 | 参考 | 用途 |
|---|---|---|
| 产品标杆 | Claude Code 官方文档 | Plan Mode、permission、hooks、MCP、memory、subagents、checkpoint、prompt caching |
| 云端任务 | Codex / GitHub Agent HQ 公开资料 | background jobs、多 agent 管理、PR 工作流 |
| A2A/Identity | Google A2A、AIP、Agent Card 公开资料 | agent identity、delegation、权限衰减 |
| MCP | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MCP 协议实现 |
| MCP servers | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | MCP 生态参考池 |
| Browser | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 浏览器自动化 MCP server |
| Sandbox | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 隔离运行环境 |
| Git-aware editing | [Aider-AI/aider](https://github.com/Aider-AI/aider) | diff / undo / commit 工作流 |
| Codebase context | [continuedev/continue](https://github.com/continuedev/continue) | 代码库索引 |
| Latest docs | [upstash/context7](https://github.com/upstash/context7) | 最新文档上下文 |
| Observability | [langfuse/langfuse](https://github.com/langfuse/langfuse) | trace / eval / prompt 管理 |
| Model routing | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 多模型网关和成本治理 |
| Eval | [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent)、[SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench) | 真实任务修复和评测 |
| Skill evolution | EvoSkills | 自进化 skill 的 generator/verifier 思路 |
| Skill security | SKILL.md supply-chain attack / Dynamic Malicious Skills | skill 安全治理风险模型 |
| Workflow learning | Hermes-style self-learning agents | workflow memory、task refinement、repeated task learning |
