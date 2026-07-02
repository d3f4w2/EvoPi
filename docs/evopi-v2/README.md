# EvoPi V2 · 演化数据

> V1 解决了「方案已定 → 有序实现」（[impl-harness](../evopi-v1/impl/README.md) skill）。
> 演化阶段解决下一个问题：**项目跑起来后，新输入不断进来（文章 / 开源项目 / 灵感 / "这里不优雅"），怎么让它们有序改造项目而不把计划搅乱。**
>
> **方法（怎么演化）已抽成通用 skill**：[`.claude/skills/evolution-harness/`](../../.claude/skills/evolution-harness/SKILL.md)（五步漏斗 + 三条要害规则 + ADR 制度，不绑 EvoPi，任何项目可用）。
> **本目录只放 EvoPi 自己的演化数据**：具体记了哪些灵感、路线图排成什么样、拍过哪些架构决策。

## 本目录三份文件（EvoPi 的数据）

| 文件 | 是什么 | 什么时候看 |
| --- | --- | --- |
| [灵感池.md](灵感池.md) | EvoPi 收集的新输入（捕获层） | 有想法时记一行 |
| [V2路线图.md](V2路线图.md) | EvoPi 够格的候选功能 + 优先级 | 想知道"接下来做什么" |
| [架构决策记录/](架构决策记录/) | EvoPi 拍过的架构决策（ADR） | 要改架构 / 推翻旧决定时 |

## 新想法进来，走这条路（一句话）

> 记进[灵感池](灵感池.md)（别停下手头的事）→ 有空提炼定性（A新功能 / B架构 / C推翻 / D不用）→ 够格的进[路线图](V2路线图.md)或写[ADR](架构决策记录/)→ 动手走 V1 老流程 → 改架构先估爆炸半径。

完整方法论见 [evolution-harness skill](../../.claude/skills/evolution-harness/SKILL.md)。

## 现在的状态

- 演化方法：✅ 已固化为通用 skill（[evolution-harness](../../.claude/skills/evolution-harness/SKILL.md)）。
- EvoPi 演化数据：📋 首批候选已进[路线图](V2路线图.md)（P1：主动缓存 / Codebase RAG；P2：自进化 / 自动 rewind / MCP+沙箱 / 工具超时）。
- 待拍板：[ADR-0001](架构决策记录/ADR-0001-v2是否解冻自动决策约定.md)（V2 要不要分级解冻"自动决策"）——gate 住 P2 两条；结论：不急，到真做 P2 时再拍。
