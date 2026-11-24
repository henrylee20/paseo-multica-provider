# Issue #1 实现上下文

## 宿主版本约定

用户明确要求：没有强烈的实际不兼容证据时，不设置 Paseo 最高版本。manifest 仅声明 `>=0.15.3`；当前实测宿主为 `0.15.3`，开发 SDK 固定为 `0.15.4`，这些验证版本不构成安装上限。

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

2026-11-24 已实现 #2 CLI 连接与 #3 默认规则／原生侧栏／主讨论描述。#3 从公开贡献入口验证分页、自定义状态类别、持久身份、原生创建响应丢失后的核对、规则归档恢复、客户端引导与 daemon 后台工作；Paseo 适配层直接包装实际低层 SDK 方法，并在写入前核对拥有者 daemon 身份。主讨论描述用稳定插件行展示，长描述按需读取缓存全文；重放与缓存读取约束见 [ADR 0005](docs/adr/0005-preserve-native-comment-history.md)。长描述按版本读取；#14 已增加打开主讨论时的缓存观测和稳定描述行刷新，读取中版本变化仍明确报错。

真实宿主加载及目标 Multica 服务验收单独记录证据。SDK 静态核查结果见设计文档；模拟宿主测试通过不能替代真实服务验收。完整评论、人工隐藏、执行过程及故障恢复仍按工单依赖实现。

#4 已加入成员／agent／squad 负责人、状态类别／精确状态、标签及 Multica 项目组合规则与管理页目录选择。规则字段取交集，字段内与标签取并集；成员使用 user_id。已启用工作区的 WebSocket 事件触发完整分页核对，认证握手与重连都重新读取快照；失败或不完整快照不产生空权威结果。退出采用 workspace 级自动归档，持久化原因、未完成意图及此前活跃 tab 集合；重返恢复相同身份，且只 refresh 明确已归档的自动恢复对象。正常插件清理等待同步器完成，避免重启时并发写入。人工隐藏的主动管理由 #6 继续交付。

2026-11-24 #5 增加持久 Thread tab、递归回复关联与按需历史。后台使用 `recent=100&summary=true` 和活动时间／根 ID 组合游标发现概要；原生导入只重放已缓存记录。实际时间线渲染 Thread 概要时调用 `thread.open`，以 `thread=<root>&tail=100` 及回复时间／ID 组合游标读取全部可用历史。根以普通评论为准，Issue 级系统／状态记录留在主讨论；缺失父链保持未解析，删除根保留 tombstone。`X-Comments-Truncated`、正文截断、失败分页与缺失游标均不得当作完整快照推断删除。

评论角色由连接用户 ID 与 `author_type` 共同决定；成员名称使用成员的 `user_id`，agent 即使由本人拥有也保留带署名 assistant。首次可获取快照形成不可变原生消息；之后的编辑、删除和系统变化使用独立且稳定的插件行，超长事件通过 `thread.event` 按需读取完整正文。每条原生评论另有稳定的“评论来源”记录，公开显示首次快照的发言和更新时间；来源时间也发送给 provider，但宿主实时追加路径仍可能以本地时间记录原生时钟。已有历史可离线重放；跨断线恢复仍由 #14 验收。

用户已明确要求 ADR 和本文件随实现提交到集成分支。

2026-11-25 #12 核对原生发送层次并增加公开贡献／provider／RPC 回归。公开 prompt 仅有 `auto | steer`；显式 interrupt 由宿主先调用原生停止，成功后才交给 provider 普通输入，失败不得投递。原生 queue 在客户端持有，tab 的全部未结束 Run 终结后释放队首，以 SDK steer 避免释放瞬间新活动被取消；空闲到 provider 时仍是普通 auto。插件不新增队列、不发送远端强制 steering，也不把 Multica queued Run 当作原生待发输入。依赖 #9／#10 已具备该行为，此切片保留其实现并锁定多 Run、固定取消集合、部分失败、重复同 ID 输入、Thread 目标与释放后新周期竞态；没有为获得测试 RED 改造既有正确实现。原生“立即发送”遵循当前 composer 设置，可能先中断。

母任务在宿主更新前已取得实际 0.15.3 SDK 的普通发送与显式 interrupt 证据；原生 queue 控件和视觉体验仍未验证。工作中 `/opt/Paseo` 原地更新到 0.17.4，而母任务拥有的旧 daemon 暂仍是 0.15.3；不得把更新后 reload 失败当作本插件 SDK 不兼容，亦不得把旧版本验收标记为新版本通过。manifest 继续只声明 `>=0.15.3`，无最高版本。实际运行环境重启与最终验收由母任务负责。

2026-11-24 #6 增加按连接持久化的 workspace／本地主讨论／Thread 人工隐藏。公开 `agent.archive.after` 与 `workspace.archive.after` 捕获原生关闭和归档；自动归档原因先于宿主事件保存，因此不误记成人工选择。新 Thread 发现、评论 WebSocket 失效、规则退出重返、多个客户端引导及正常重启都保留隐藏；普通 session.close 和贡献清理只释放资源。

管理页独立读取所有连接的本地隐藏对象，CLI 离线时仍可列出与恢复缓存历史。恢复操作绑定原 workspace、agent 与 cwd，不 resume 新身份、不重复 import，也不 refresh 活跃 agent。因宿主归档事件没有 bulk cause，workspace 归档关闭的讨论同样分别列出：仅恢复工作区不恢复 tab；恢复某个讨论先恢复原 workspace，再恢复选定且已归档的 agent。失败或回执丢失保留隐藏，重试不会 refresh 已恢复的活跃 tab。具体取舍与原生证据见 ADR 0002。真实宿主/真实 Multica 验收继续由母工单负责。

真实 0.15.3 验收发现人工隐藏的 Thread 经筛选退出重返后，所属 workspace 已活跃，重复调用 `restoreWorkspace` 会被宿主拒绝。#6／#4 的恢复现先逐页读取原生活跃 workspace 目录并比对完整 ID；SDK 接受但忽略 `idPrefix`，目录没有可判断归档的 `archivedAt` 字段。人工恢复、自动恢复与创建回执丢失核对共用该适配边界，回执丢失和重启后可继续恢复原身份，且仍只 refresh 确认已归档的 agent。公开 RPC 测试按真实宿主行为拒绝活跃 workspace 的重复恢复，并覆盖后续页与 workspace 恢复回执丢失。

2026-11-24 #7 加入 Run 的持久首次展示归属、稳定执行摘要与原生活动聚合。后台准确读取 `GET /api/issues/{id}/task-runs?view=timeline`，与成功的评论概要祖先／创建时间缓存组合确定唯一 owner；远端输入关联与生成评论 provenance 分开保存，后补关联、跨 Thread 合并和正常重启不迁移 owner。未知父链、读取失败与跨 Thread 创建时间缺失均不等于零关联。首次确实无关联的 Run 固定留在主讨论。

执行摘要以稳定插件行展示 agent 与真实状态，状态更新替换同一 Run，不生成日志 assistant 消息，也不读取执行消息正文。一个 tab 的所有未结束 Run 共享一个原生 turn；全部终结才结束，每个后续活动周期生成新 UUID。缓存 replay 先输出摘要，原生导入返回后的后台同步及 renderer 挂载后的只读 `run.observe` 负责在宿主注册后发布活动。实际 0.15.3 导入前活动事件会丢失、复用已完成 turn ID 会卡住活动状态，这两项已由母任务独立实测；执行正文与原生取消仍分别由 #8、#9 交付。

2026-11-24 #8 为 Run 摘要加入执行段展开。未展开时不读取消息正文；展开后通过 `run.open` 读取真实 `GET /api/tasks/{id}/messages`，按 Run 与序号持久去重并排序。后续使用连续序号的 `since` 增量补读，遇缺口不跳到最大已见序号；renderer 每两秒刷新已展开段，收起或卸载即停止。完整历史无最近条数上限，大结果通过带版本的 `run.read` 每次最多 8192 个 UTF-16 字符读取，原生摘要仍只含有界身份与状态。

执行文本、思考、工具输入／输出和错误保持源序号顺序；只有 Run 内唯一且非空的同一 `call_id` 才显示可靠输入／结果关联。缺输入、输出或调用 ID、来源截断与来源完整性未知均单独显示，不补造缺失内容。最终 agent 评论仍由普通 Thread 评论通道导入。已读全文与首次固定的归属独立保存，重启、CLI 离线、退出或切换身份后可继续读取旧缓存；每次新远端明细读取先重新验证当前 CLI 身份必须匹配原连接。模拟 HTTP／WS 与编译 renderer 验证已通过；真实宿主展开与目标服务验收仍由母任务记录。

2026-11-24 #9 接入 provider 原生 `session.interrupt`，在网络等待前持久固定本次 tab 归属的所有未结束 Run，并按精确 Issue／Run 取消接口逐项请求。其他 tab、终态历史和停止后新发现的 Run 不扩大进集合；跨 Thread Run 整体处理。实际返回 completed／failed／cancelled 按原样保存；HTTP 200 不自动记为取消，进程清理证据与任务状态分列。停止回执和缓存 Run 状态原子保存，旧活动快照不得重新打开已终结 Run 的原生活动周期。

管理页独立列出所有连接的本地停止记录；部分失败使原生停止返回失败，并持续提供单 Run 重试，tab 随后关闭、CLI 离线和正常重启仍可看到。重试不恢复 workspace 或讨论，不改变人工隐藏。整 workspace 归档、规则退出、单纯 session.archive／unarchive／close、连接关闭和贡献清理均不发起远端取消；清理等待已接受的停止请求。`StopCoordinator.epoch`／`guardDelivery` 为 #10／#11 提供持久停止栅栏，旧待投递必须在发送或重试领取前检查同一讨论的 epoch。真实宿主及真实服务验证仍由母工单负责。

真实 0.15.3 验收发现：Stop 固定集合终结时，若同 tab 后来又有新 Run，继续保留原聚合 turn 会触发宿主两秒后的强制取消，导致后来 Run 仍在远端运行而原生永久空闲。provider 现捕获操作开始时的 turn；停止成功后先完成仍匹配的原 turn，再以全新 UUID 展示剩余活动 Run，最后确认请求。若原 turn 已自然结束则不动后续 turn；部分失败保留失败及活动。公开贡献／provider／RPC 回归覆盖延迟取消中发现新 Run、固定集合不扩张、后续 observe／bootstrap 及终态、部分失败持续活动和原 turn 提前自然结束竞态。真实宿主重复验收由母工单独立执行，宿主版本约定不变。

2026-11-24 #10 加入文本普通评论投递。原生输入先持久保存 clientMessageId、随机稳定 Idempotency-Key、不变正文、连接／Issue／讨论目标、时间、宿主原 delivery 选择及停止 epoch，再报告插件已接收。主讨论每次 POST 顶层评论；真实 Thread 的 parent_id 始终是根评论。管理页提供按当前目录真实 agent ID 生成的 canonical mention 引用，同名身份逐项列出，不按裸 @名字推断路由。普通发送始终只有 content/type/parent_id，不向 Multica 添加 steering 指令，也不创建 Issue。

运行中在等待持久化前捕获当前唯一聚合 turn UUID，以该缓存 ID 回答宿主 steer admission；远端 POST 在 admission 后独立进行。接收、保存、失败、待核实使用稳定 comment-delivery 插件行，保存评论不生成虚构 Run。网络／回执丢失及 5xx 保留待核实，确定拒绝与发送前错误保留失败；没有自动重发。存储写入失败时运行中仍使用匹配的缓存 turn 防止宿主 failed fallback 意外取消，同时追加明确“未能持久接收、未发送远端评论”的原生错误；全局磁盘故障下不承诺任何一侧记录一定可持久化。此特殊路径不伪造保存回执。

首次 POST 前通过 StopCoordinator.guardDelivery 原子领取原 epoch 的记录，中途 Stop 会阻止旧未发送输入。收到回执后以 commentId 映射同一讨论的 clientMessageId，协调原生乐观输入及远端 echo；新 Thread 是另一个会话，不借主讨论 client ID 跳过其根评论。HTTP 回执未定时先等待在途请求再投影；仍未知的同正文自身评论不能靠正文猜为本次回执，暂缓该候选原生 echo。完整输入留在本地，可分块读取。重启恢复通过 #14 原生 canonical 历史逐页检查 client ID、角色及全文，仅补缺失输入，不发送评论。管理页的继续 Thread 入口绑定回执根及对应 native agent，只在用户点击时导航。真实 Paseo 0.15.3 的生产 provider 回显／steer 竞态及目标服务验收由母工单单独记录，公共边界模拟通过不替代真实验收。


真实 0.15.3 重启验收发现已保存回复从评论缓存和投递记录各 replay 一次。provider 现为两条投影路径共用每个原生会话的原文身份集合，按来源 commentId 与自身 clientMessageId 去重；`history:skip` 已存在及本轮补回的评论也共享该集合，不依赖新追加事件立即进入原生可读历史。公开重启回归覆盖 replay、延迟原生写入的 skip 恢复、缺失的已保存／失败／待核实输入、未知同正文回执，以及主讨论与新 Thread 独立身份。正常实时回执 echo、来源插件行、Stop 聚合 turn 与宿主版本约定保持原行为。真实宿主重复验收由母工单执行。

2026-11-24 #14 补齐 daemon 恢复循环与缓存投影核对。客户端仍立即并每十秒调用 `sync.bootstrap`；第一次客户端连接验证所属 daemon 后即建立唯一后台定时器，首次 Multica 读取失败也继续重试，多个客户端与定时机会共享同一次进行中的核对。客户端退出不停止后台同步；daemon/plugin 重启后仍需至少一次客户端连接，不声称无人连接时自启。`sync.status` 为管理页和原生讨论提供同一同步阶段、工作区进度、上次完成时间和保留缓存提示；WebSocket 握手只触发分页快照核对，不代表缺口已补齐。

#14 在远端鉴权前先核对已挂载会话的缓存投影。新贡献实例恢复 `history:skip` 时读取所属 agent 的完整原生时间线，依据真正的 user/assistant `messageId`（来源评论 ID）、角色和文本确认已有原始消息；相邻的“评论来源”插件行不能证明原文已保存。请求 canonical，兼容实际 0.15.3 返回的 projected 分页，检查 epoch、gap、游标与所有旧页后才发布缺失原文；已有更正、删除及来源行使用稳定插件 ID。确认状态只在本次会话内保存，不把原生读回当成可永久跳过后续重启核对的持久回执。失败、半页或来源文本冲突不做盲目 replay。

打开主讨论的 `description.observe` 仅观察既有连接缓存，更新稳定描述行和当前 renderer，不生成 assistant 消息；离线分页全文仍可读，版本不符仍拒绝拼接。daemon 重启仅恢复摘要与已有缓存，不因 `historyLoaded` 将所有历史正文重读；只有本次进程内实际 `thread.open` 的讨论才继续补读正文，Run 明细仍仅由展开操作按连续序号补缺口。恢复不 refresh 活动 agent，不取消远端、不重算 Run owner、不改变人工隐藏、原始作者或来源时间。失权分类与投递重试仍由各自切片负责。


2026-11-25 #11 增加回执优先的幂等恢复。后台在发现评论投影前先查询原 key；真实 GET 成功回执及 Idempotent-Replayed:true、原作者／目标／正文／已知评论 ID 才构成当前服务能力的正面证据，首个 keyed POST 或 404 都不足够。每轮重新检查同连接／工作区内已保存的 anchor，只有查无原回执、能力仍可核实、原始时间未满 7 天且原 Stop epoch 未变化时，才沿用不变输入做一次安全自动 POST；之后只再核实，不无限重发。255 字节 key 上限与不包含正文的服务指纹由插件额外约束。

不支持、读取失败、过期、删除／目标冲突和仍无法确认的结果原子保存为待核实并停止自动恢复。管理页能只读核实；用户看到可能重复触发执行的提示并明确确认后，才能另建带 retryOf 的独立新请求，旧记录不被覆盖。相同重发决定在 RPC 响应丢失后仍保持新请求唯一。CLI 最后使用检查和撤销 signal 覆盖每次回执读取与 POST；重试仍使用原 Stop 栅栏，不改投新连接或工作区。公共入口与可控 HTTP 服务测试已覆盖恢复、边界和竞态；真实 daemon／真实服务能力验收仍由母任务独立执行。

2026-11-25 #13 补齐 CLI 登录变化后的请求栅栏与管理页连接历史。相同服务和 `/api/me` 用户 ID 继续原映射，凭据原子轮换及同账号 profile 切换不会重复建立原生项目；新服务或用户从各自空规则开始。规则管理操作携带所展示的连接键，旧页面点击不能修改新账号规则。原始评论角色、Run 首次 owner、隐藏意愿、待核实输入和停止告警继续绑定原连接，切回旧身份续用原 ID。

每次远端读取与分页在发出和读取响应后核对有效 CLI 服务／凭据对及当前 profile；解析上下文仅在 daemon 内保存撤销 signal。检测移除或变更后旧认证 socket 关闭，重连和发送 auth 前也重新读 CLI。停止请求逐项使用同一栅栏；已经发出的请求不能撤回，未知结果保留原告警。评论最终检查必须在 Stop 持久领取前完成，随后立即发送；#11 将在其投递恢复路径采用该共享接口。`connection.history` 只读缓存中的已验证服务／用户、曾用 profile 和历史对象数量，登出或重启后仍可读，早期无摘要映射不猜测身份。真实 daemon 与目标服务演示由母工单单独记录，公共测试通过不替代真实验收。
