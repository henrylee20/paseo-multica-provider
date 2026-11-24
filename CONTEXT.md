# Issue #1 实现上下文

## 规格与决定

实现目标是 [Issue #1](https://github.com/henrylee20/paseo-multica-provider/issues/1) 的完整规格；已发布正文的仓库副本是 [docs/github-spec.md](docs/github-spec.md)。确认用户可见行为时读取该规格；查对象名称时读取 [GLOSSARY.md](GLOSSARY.md)。

改动会话、目录、Run 归属、停止、历史、身份、投递或鉴权时，读取 [docs/adr](docs/adr) 中相应 ADR。接口证据与产品决定见 [docs/design.md](docs/design.md)，职责与验证安排见 [docs/implementation-plan.md](docs/implementation-plan.md)。

## 工单依赖

集成分支为 `feat/issue-1-multica-provider`，基线为 `49d9587`。每项工单通过独立分支及 worktree 实现，合入集成分支；最终通过同一 PR 关闭母规格与完成的子工单。

| 工单 | 交付 | 前置工单 |
| --- | --- | --- |
| [#2](https://github.com/henrylee20/paseo-multica-provider/issues/2) | CLI 登录与连接状态 | 无 |
| [#3](https://github.com/henrylee20/paseo-multica-provider/issues/3) | 原生侧栏及主讨论 | #2 |
| [#4](https://github.com/henrylee20/paseo-multica-provider/issues/4) | 动态组合筛选 | #3 |
| [#5](https://github.com/henrylee20/paseo-multica-provider/issues/5) | Thread 消息及历史更正 | #3 |
| [#6](https://github.com/henrylee20/paseo-multica-provider/issues/6) | 人工隐藏与恢复 | #4、#5 |
| [#7](https://github.com/henrylee20/paseo-multica-provider/issues/7) | Run 唯一归属及聚合活动状态 | #5 |
| [#8](https://github.com/henrylee20/paseo-multica-provider/issues/8) | Run 输出按需加载 | #7 |
| [#9](https://github.com/henrylee20/paseo-multica-provider/issues/9) | 原生停止及关闭 tab | #6、#7 |
| [#10](https://github.com/henrylee20/paseo-multica-provider/issues/10) | 普通评论投递 | #9 |
| [#11](https://github.com/henrylee20/paseo-multica-provider/issues/11) | 幂等投递恢复 | #10 |
| [#12](https://github.com/henrylee20/paseo-multica-provider/issues/12) | 原生中断及排队模式 | #10 |
| [#13](https://github.com/henrylee20/paseo-multica-provider/issues/13) | 登录变化后的历史隔离 | #10 |
| [#14](https://github.com/henrylee20/paseo-multica-provider/issues/14) | 后台同步及断线恢复 | #6、#8 |
| [#15](https://github.com/henrylee20/paseo-multica-provider/issues/15) | 失权后的只读历史 | #10 |
| [#16](https://github.com/henrylee20/paseo-multica-provider/issues/16) | 可安装交付及端到端验收 | #11、#12、#13、#14、#15 |

## 验证与当前状态

测试边界已由母规格的 Testing Decisions 确认：从公开贡献入口驱动 RPC、provider 与生命周期，以临时 CLI 配置、模拟 Multica HTTP/WebSocket 和 Paseo 宿主契约观察行为。按 TDD 逐个行为实现。

2026-11-24 已实现 #2 CLI 连接与 #3 默认规则／原生侧栏／主讨论描述。#3 从公开贡献入口验证分页、自定义状态类别、持久身份、原生创建响应丢失后的核对、规则归档恢复、客户端引导与 daemon 后台工作；Paseo 适配层直接包装实际低层 SDK 方法，并在写入前核对拥有者 daemon 身份。主讨论描述用稳定插件行展示，长描述按需读取缓存全文；重放与缓存读取约束见 [ADR 0005](docs/adr/0005-preserve-native-comment-history.md)。当前长描述行版本过期后明确报错，实时刷新由 #14 继续处理。

真实宿主加载及目标 Multica 服务验收单独记录证据。SDK 静态核查结果见设计文档；模拟宿主测试通过不能替代真实服务验收。完整评论、人工隐藏、执行过程及故障恢复仍按工单依赖实现。

#4 已加入成员／agent／squad 负责人、状态类别／精确状态、标签及 Multica 项目组合规则与管理页目录选择。规则字段取交集，字段内与标签取并集；成员使用 user_id。已启用工作区的 WebSocket 事件触发完整分页核对，认证握手与重连都重新读取快照；失败或不完整快照不产生空权威结果。退出采用 workspace 级自动归档，持久化原因、未完成意图及此前活跃 tab 集合；重返恢复相同身份，且只 refresh 明确已归档的自动恢复对象。正常插件清理等待同步器完成，避免重启时并发写入。人工隐藏的主动管理由 #6 继续交付。

2026-11-24 #5 增加持久 Thread tab、递归回复关联与按需历史。后台使用 `recent=100&summary=true` 和活动时间／根 ID 组合游标发现概要；原生导入只重放已缓存记录。实际时间线渲染 Thread 概要时调用 `thread.open`，以 `thread=<root>&tail=100` 及回复时间／ID 组合游标读取全部可用历史。根以普通评论为准，Issue 级系统／状态记录留在主讨论；缺失父链保持未解析，删除根保留 tombstone。`X-Comments-Truncated`、正文截断、失败分页与缺失游标均不得当作完整快照推断删除。

评论角色由连接用户 ID 与 `author_type` 共同决定；成员名称使用成员的 `user_id`，agent 即使由本人拥有也保留带署名 assistant。首次可获取快照形成不可变原生消息；之后的编辑、删除和系统变化使用独立且稳定的插件行，超长事件通过 `thread.event` 按需读取完整正文。每条原生评论另有稳定的“评论来源”记录，公开显示首次快照的发言和更新时间；来源时间也发送给 provider，但宿主实时追加路径仍可能以本地时间记录原生时钟。已有历史可离线重放；跨断线恢复仍由 #14 验收。

用户已明确要求 ADR 和本文件随实现提交到集成分支。

2026-11-24 #7 加入 Run 的持久首次展示归属、稳定执行摘要与原生活动聚合。后台准确读取 `GET /api/issues/{id}/task-runs?view=timeline`，与成功的评论概要祖先／创建时间缓存组合确定唯一 owner；远端输入关联与生成评论 provenance 分开保存，后补关联、跨 Thread 合并和正常重启不迁移 owner。未知父链、读取失败与跨 Thread 创建时间缺失均不等于零关联。首次确实无关联的 Run 固定留在主讨论。

执行摘要以稳定插件行展示 agent 与真实状态，状态更新替换同一 Run，不生成日志 assistant 消息，也不读取执行消息正文。一个 tab 的所有未结束 Run 共享一个原生 turn；全部终结才结束，每个后续活动周期生成新 UUID。缓存 replay 先输出摘要，原生导入返回后的后台同步及 renderer 挂载后的只读 `run.observe` 负责在宿主注册后发布活动。实际 0.15.3 导入前活动事件会丢失、复用已完成 turn ID 会卡住活动状态，这两项已由母任务独立实测；执行正文与原生取消仍分别由 #8、#9 交付。
