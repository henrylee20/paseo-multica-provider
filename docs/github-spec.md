## Problem Statement

用户希望在 Paseo 中处理 Multica 的业务任务，沿用原生左侧项目树、会话、消息与停止体验，而不必在两个产品间反复切换。需要保留 Multica 的工作区、Issue、Thread、评论和 Run 之间的真实关系，而不是把一条长期讨论误当作一次执行。

用户已经通过本机 Multica CLI 登录云服务或自部署服务，集成应直接复用这一登录环境的 API 地址与现有凭据。例如 CLI 登录自部署主机后，Paseo 应连接同一服务，不要求另建 Token，也不能把请求发往硬编码的云服务地址。

本项目目前只有已确认的设计、术语和 ADR，尚无功能实现。此规格汇总 27 项已确认决定及后续明确补充的 CLI 登录复用要求，用作实现与后续任务拆分的依据。

## Solution

创建不修改 Paseo 核心的 Multica 插件，由远端 agent provider、daemon 侧任务同步器与客户端贡献组成。任务同步器维护原生项目树中的记录及本地占位目录；实际评论、路由与智能体执行仍由 Multica 管理。

| Multica 概念 | Paseo 中的表达 |
| --- | --- |
| Multica 工作区 | Project |
| Issue，即业务任务 | Workspace |
| Issue 中以一条顶层评论为根的 Thread | 一个 agent tab |
| 当前连接用户的普通评论 | 原生 user message |
| 其他成员或 agent 的普通评论 | 带作者名称前缀的原生 assistant message |
| 一个 Run | 所属 tab 中可展开的执行段 |
| 系统状态变化、评论更正和删除提示 | 独立事件 |

每个 Issue 另有一个本地“主讨论”tab，用于任务描述和首次确定归属时没有评论关联的 Run。在主讨论发送消息会创建新的远端 Thread；在真实 Thread tab 中发送则回复该 Thread 的根评论。

按工作区配置规则动态收录任务。保留原生消息与停止体验，明确区分人工隐藏、自动归档、远端取消、离线缓存和真实投递结果。默认只读复用 Paseo daemon 所在主机、运行用户可访问的 Multica CLI 登录上下文。

## User Stories

1. As a self-hosted Multica user, I want Paseo to reuse my CLI's API address and existing login, so that I do not need a separate integration token.
2. As a Multica cloud user, I want the same integration to use my existing CLI context, so that cloud and self-hosted deployments follow one workflow.
3. As a user with named CLI profiles, I want to select the matching profile, so that Paseo connects to the intended service and account.
4. As a user of the default CLI profile, I want automatic login discovery, so that initial setup does not require copying credentials.
5. As a user who logs in again through the CLI, I want Paseo to reread the updated credentials, so that token rotation preserves my existing mappings.
6. As a user who logs out, I want Paseo to stop using removed credentials, so that cached authentication does not outlive the effective CLI login.
7. As a user whose login expires, I want a clear CLI login requirement, so that I can restore access without an invented refresh-token flow.
8. As a user switching services or accounts, I want independent local mappings, so that old history retains its original author and message-role meanings.
9. As a user with a renewed token for the same account, I want existing projects and tabs to remain, so that credential renewal does not duplicate my workspace.
10. As a user configuring the integration, I want an empty configuration to import no tasks, so that connecting an account does not unexpectedly populate the sidebar.
11. As a task owner, I want explicit workspace filters for assignees, states, labels and Multica projects, so that only relevant Issues appear in Paseo.
12. As a user configuring filters, I want AND between fields and OR between values, so that task membership has predictable semantics.
13. As a user selecting assignees, I want members, agents and squads distinguished, so that direct assignments are not confused with delegated work.
14. As a user creating a rule, I want unfinished tasks as the default scope, so that completed work is not imported unintentionally.
15. As a user monitoring task changes, I want newly matching Issues to appear automatically, so that I do not maintain a fixed manual task list.
16. As a user organizing work, I want Multica workspaces grouped as Paseo projects, so that each Issue appears under its correct collaboration context.
17. As a user discussing an Issue, I want each Thread in its own agent tab, so that unrelated discussions retain distinct conversations.
18. As a user opening an Issue without comments, I want a main discussion showing its description, so that I can understand and begin the work.
19. As a conversation participant, I want my comments shown as native user messages, so that my own contributions remain recognizable.
20. As a conversation participant, I want other authors named on native assistant messages, so that human and agent contributions remain attributable.
21. As a reader, I want system changes shown as separate events, so that status updates are not mistaken for participant replies.
22. As a reader, I want text, Markdown and existing attachment links, so that the discussion retains its useful content.
23. As a participant replying in a Thread, I want my message posted under its root comment, so that the conversation stays in the same Thread.
24. As a user sending from the main discussion, I want a new top-level comment and Thread, so that I can start a separate conversation within the Issue.
25. As a user addressing agents, I want valid explicit mentions and Multica's routing rules, so that the correct recipients determine execution.
26. As a participant posting a comment, I want comment delivery distinguished from Run creation, so that a saved comment is not falsely reported as started execution.
27. As a participant sending while work is running, I want ordinary comments handled by Multica's queue or coalescing rules, so that the integration does not force remote steering.
28. As a Paseo user selecting interrupt or queue mode, I want that explicit native choice respected, so that the existing input controls remain meaningful.
29. As a sender, I want my optimistic message and remote echo reconciled, so that the same comment is not displayed twice.
30. As a sender encountering a transient failure, I want retries only with verified deduplication guarantees, so that comments and execution side effects are not duplicated.
31. As a sender with an uncertain delivery result, I want a truthful pending-verification state, so that I can decide whether to resend when safe confirmation is unavailable.
32. As a sender retrying a message, I want its request identity and payload preserved, so that a retry cannot silently become a different comment.
33. As a user observing execution, I want a collapsible segment for each Run, so that agent identity, state, tools, results and errors are inspectable together.
34. As a reader of completed work, I want final comments separated from execution logs, so that generated text is not duplicated as conversation replies.
35. As a user following a cross-Thread Run, I want one stable display location, so that I do not mistake multiple views for multiple executions.
36. As a user revisiting a Run, I want its first display ownership preserved, so that later associations or reconnects do not move its history between tabs.
37. As a user viewing an unanchored Run, I want it in the main discussion, so that execution without a trigger comment is still visible.
38. As a user with several agents in one Thread, I want all associated Runs represented, so that parallel and queued work is not reduced to one remote execution.
39. As a user expanding execution details, I want output loaded when needed, so that large transcripts do not delay basic navigation.
40. As a user reading history, I want available comments without an arbitrary recent-item cutoff, so that older context remains accessible.
41. As an offline user, I want cached content and a visible synchronization state, so that unavailable live data is not mistaken for an empty task.
42. As a user pressing native Stop, I want all unfinished Runs currently owned by that tab cancelled, so that already queued work does not immediately continue.
43. As a user stopping one tab, I want other tabs and completed Runs unaffected, so that cancellation stays within the chosen scope.
44. As a user stopping a cross-Thread Run, I want it cancelled as one execution, so that the interface does not promise unsupported partial cancellation.
45. As a user closing a running tab, I want remote cancellation requested before local archive, so that native Stop and tab closure can share the existing Paseo semantics.
46. As a user archiving a workspace or disconnecting the client, I want remote work preserved, so that local visibility and resource cleanup do not cancel execution.
47. As a user hiding a tab or workspace, I want that intent retained, so that dynamic synchronization does not reopen it without my action.
48. As a user whose task leaves and reenters a filter, I want stable identities and history restored, so that scope changes do not create duplicate workspaces.
49. As a user facing partial cancellation failure, I want per-Run results and a retry entry, so that failed stops remain visible even after the tab closes.
50. As a user checking cancellation, I want server state distinguished from confirmed process cleanup, so that HTTP success is not overstated as physical termination.
51. As a user connecting a client, I want background synchronization bootstrapped automatically, so that I do not need to open the plugin page first.
52. As a user closing the client after startup, I want the daemon to keep synchronizing, so that background updates do not depend on an open interface.
53. As a user reconnecting after daemon restart, I want idempotent synchronization startup, so that multiple clients do not create duplicate workers or records.
54. As a user recovering from a connection gap, I want snapshots and execution messages reconciled, so that missed events are recovered without duplicated history.
55. As a reader of edited or deleted comments, I want appended correction or deletion events, so that native original messages remain intact and subsequent changes are visible.
56. As a user losing access to an Issue, I want it removed from active work while retaining read-only history, so that unavailable objects are not offered for writing.
57. As a user with a connection-wide authentication failure, I want a connection error rather than mass task deletion, so that cached work is not misclassified.
58. As a user managing the integration, I want profiles, filters, hidden objects and failures in one management surface, so that recovery does not require rebuilding mappings.
59. As a user inspecting incomplete remote output, I want truncation or missing fields reported honestly, so that the integration does not invent logs or tool relationships.

## Implementation Decisions

1. **接入形态与边界。** 采用外部 provider、daemon 侧同步器及客户端贡献，不修改 Paseo 核心。仅注册 provider 不足以生成原生项目树，需要同步原生 project、workspace 和 agent 记录。首版不运行本地 LLM，也不把 Multica 执行迁移到 Paseo 主机。

2. **目录与宿主记录。** 使用本地非 Git 占位目录满足交互 workspace/agent 的目录约束。目录不是远端代码工作区，原生终端和文件功能可能指向占位目录；远端执行路径按远端信息呈现。不同任务保留独立的目录关联，归档不删除恢复所需的目录。记录依靠远端稳定 ID 关联，名称不充当身份。

3. **对象及作者语义。** Multica 工作区对应 Paseo project，Issue 对应 workspace，根评论及其后代回复组成的 Thread 对应 agent tab。普通评论保留原生 user/assistant 消息：本人按连接用户 ID 与作者类型判定，其他成员和 agent 带名称前缀显示。用户拥有的 agent 不能因此被当作本人的 user message；assistant 是呈现角色，不保证作者是 AI。

4. **连接身份隔离。** 每个连接绑定一个服务与一个用户。更换服务或账号使用独立映射，保留旧历史的身份、角色和隐藏意愿；同服务同账号轮换凭据续用映射。连接状态、CLI profile、筛选和恢复在插件管理页集中管理。

5. **默认复用 CLI 登录。** 在 Paseo daemon 侧只读解析 Multica CLI 的有效登录上下文，成对读取服务地址与现有凭据，不要求另一枚 Token，不生成新 PAT，不把凭据复制到插件配置或客户端。默认 profile 与普通 CLI 调用一致，命名 profile 显式选择；不能根据目录修改时间猜测“当前 profile”。已核查的 CLI 没有全局 active-profile 选择器。

6. **自部署与 CLI 环境规则。** 保留 CLI 的有效环境覆盖和任务隔离规则，包括 `MULTICA_SERVER_URL`、`MULTICA_TOKEN` 与 `MULTICA_TASK_CONFIG_ROOT`。不得绕过任务上下文隔离借用拥有者的全局凭据。API `server_url` 与前端 `app_url` 分别使用，不假定相同，也不硬编码云服务域名。凭据作为不透明值处理，不根据前缀推断身份。

7. **登录变化与可访问范围。** CLI 原子替换配置、重新登录或登出后重新读取上下文；有效凭据移除后不继续使用旧缓存。身份变化先隔离映射，旧投递不能被转发到新服务或账号。已核查的浏览器登录生成现有 PAT，但没有刷新令牌机制；失效时引导 CLI 登录，不自行打开登录流程或改写 CLI 配置。只能复用 daemon 所在主机及运行用户可访问的登录态，不能自动借用另一机器客户端或其他用户的凭据。

8. **动态筛选。** 空配置不导入任务；显式启用工作区与规则后收录。负责人支持成员、agent、squad，另支持状态、标签及 Multica project；字段间 AND，同字段多值 OR，多标签表示任一命中。新规则默认未开始和进行中，其他字段不限。直接分配给本人和分配给其 agent/squad 是不同语义。使用正常分页列表与状态筛选，避免旧的 open-only 快捷查询忽略其他条件。

9. **可见性与恢复。** 任务进入规则时创建或恢复；退出规则时自动归档，保留身份和历史且不停止远端；重新匹配时恢复，人工隐藏的对象除外。人工关闭 tab 或归档 workspace 的隐藏意愿持续到主动恢复。同步器区分自己的自动生命周期操作与人工操作。状态在同一 Paseo daemon 的客户端间共享。

10. **Run 的首次唯一归属。** 优先触发评论所属 Thread；没有触发评论时选择最早关联评论所属 Thread；无评论关联时放入本地主讨论。首次确定后持久保持，后续关联、补历史或重连不迁移、不复制。网络读取失败不能被当作无关联，过早固定主讨论归属。远端关联关系与显示归属分开保存。

11. **主讨论与发言。** 每个 Issue 有本地主讨论展示描述及无评论关联的 Run，它自身不是远端 Thread。主讨论每次发送创建顶层评论和新 Thread；真实 Thread 中发送回复根评论。普通发送遵循 Multica 路由，可显式提及 agent，保存评论可以不产生 Run。运行中默认仍是普通评论，由 Multica 排队或合并，不额外发送远端 steering 指令；用户明确选择原生中断或排队时尊重该选择。

12. **消息内容与更正。** 首版发送文本，读取文本、Markdown 和已有附件链接。普通消息保留初次导入内容，远端编辑与删除追加更正或删除事件；系统状态变化也独立呈现。首次导入以可获取快照为准，不能恢复远端已不再提供的旧内容。上传、编辑和删除评论以及新建 Issue、修改任务状态仍在 Multica 完成。

13. **投递身份与回显。** 同一次发送保存稳定请求身份、不变正文、目标、时间及回执关联；Paseo 输入回显与远端评论回显必须协调成同一条评论。插件接收输入、评论已保存、agent 已开始执行是不同状态，不能相互替代。收到成功评论回执也不强制推断 Run 已触发。会话未绑定已映射 Issue 时提供配置引导，不从任意本地目录意外创建远端 Issue。

14. **幂等重试。** 在实际服务已验证支持的范围内使用稳定 `Idempotency-Key`，优先查询评论回执再重试，不重复创建评论或触发副作用。已核查服务回执保留期为 7 天，key 最长 255；其目标指纹不包含正文，因此插件必须自行保持本次请求内容不变。超期、服务不支持、删除冲突或结果无法确认时停止自动重试并标记待核实，由用户决定重发。过期后查不到回执不能证明从未发表。

15. **执行段与原生活动 turn。** 每个 Run 用一个稳定的可展开插件执行段显示 agent、状态、工具调用、结果、运行文本及错误；主对话消息仅来自评论，最终评论不与日志重复。一个 Paseo tab 只有一个活动 turn 槽位，provider 聚合该 tab 多个远端 Run，而不把它们当作多个并行原生 turn。执行段只放必要摘要，详细输出按需读取，遵守宿主插件行大小限制。

16. **工具流保真。** 有可靠调用 ID 时关联工具输入与结果；远端截断输出或旧记录缺字段时明确展示缺失，不补造日志、完整输出或工具配对。新的关联信息可以更新，但不改变 Run 已固定的显示归属。

17. **原生停止范围。** 原生停止针对该次操作时归属当前 tab 的全部未结束 Run，包括排队、已派发、运行中、等待本地目录和延期执行的 Run。按单 Run 接口处理，不调用 agent 级全量取消来扩大范围；其他 tab、操作集合之外的 Run 及已经终结的历史记录不受影响。跨 Thread Run 只能整体取消。

18. **关闭与清理。** 保留原生停止体验，并接受关闭运行中的普通 tab 先请求远端停止再归档，因为宿主使用同一种无原因字段的中断请求。整个 workspace 归档、筛选退出归档、客户端断开、空闲释放及单纯会话关闭只处理本地状态或资源，不取消远端。自动归档不得误走会先中断的逐 tab 归档路径。

19. **取消结果。** 根据每个 Run 的真实返回状态处理，终态竞态中的 HTTP 200 不一定表示此次取消。部分失败如实保留，原生停止报告失败；即使关闭继续归档，管理页仍保留失败告警和重试入口，不自动重新打开 tab。任务取消状态与进程清理确认分别展示，不能凭 HTTP 成功声称进程已退出。

20. **不可访问与连接故障。** Issue 被删除或失去权限时移出活跃列表、停止写入，保留只读历史。网络异常或连接级鉴权失效不能被当作所有任务删除或退出规则。恢复访问后重新核对，继续尊重该连接身份的人工隐藏。

21. **后台引导。** 客户端连接后自动通过幂等 RPC 引导 daemon 侧同步，无需打开插件页；启动成功后客户端退出仍可同步。daemon 或插件进程重启后需要至少一次客户端连接，首版接受这一条件。多个客户端不能创建多个同步循环；不能只依赖不会每次重连都执行的客户端初始化。

22. **同步与历史读取。** 后台同步匹配任务、Thread 和 Run 概要，打开 tab 读取可用评论历史，展开执行段加载输出，不人为截断为最近若干条。监听已启用工作区范围的变化，以发现此前未匹配的任务。重连重新核对快照及筛选，按执行消息序号补读；WebSocket 连上不等于数据已经完整。离线保留缓存并标注同步状态。

23. **恢复接口约束。** 分别恢复 workspace 和所需 agent，保留原身份与目录。活动 handle 的导入不是通用 upsert；不能以重新 resume 分配新身份，也不能使用会中断运行的 refresh 作为普通同步轮询。低层宿主能力应封装在 Paseo 适配层，不能将其全部假定为高层 API。

24. **模块职责。** 需要 CLI 登录适配、Multica 通信、本地持久状态、任务同步、Paseo 宿主适配、provider 会话、客户端管理及执行段呈现。这些是职责边界而非固定文件划分；存储依赖与具体组织方式未被锁定，须以兼容验证为准。

25. **管理界面。** 集中展示 CLI 来源、实际服务地址、连接状态、profile、规则、人工隐藏、不可访问历史、投递问题和取消失败。项目与 tab 名称来自对应业务名称或评论摘要，但身份不依赖名称。提供真实 Thread 的继续讨论入口，后台同步不抢夺当前浏览位置。mention 必须形成服务可识别的身份引用，不能把歧义姓名当作已确定接收者。

## Testing Decisions

主测试边界沿用用户确认的实现计划：**从插件公开贡献入口驱动 provider 协议、RPC 和生命周期行为，观察用户可见状态及宿主、Multica 边界上的实际效果。** 尽量以同一个组合测试入口覆盖职责协作，不为每个私有辅助函数另设测试边界。

- 好的测试验证行为和不变量：出现哪些任务与 tab、消息角色与内容、Run 显示位置、是否真实发表评论或取消运行、错误与恢复如何呈现。不要用私有方法调用次数、内部对象布局或提示词文本快照代替这些结果。
- 通过临时 CLI 配置、可控时钟、模拟 Multica HTTP/WebSocket 与 Paseo 宿主契约驱动服务端贡献；正常重启使用新的贡献实例和已有持久状态验证恢复，不依赖用户真实凭据。
- 主要被测职责包括登录上下文、筛选与映射、会话投影、投递和回显、Run 聚合与取消、后台同步和恢复。它们以公开入口组合测试为主，必要的协议适配测试仍以真实边界消息为输入输出。
- 当前仓库尚无现成实现或测试。相邻的既有 Paseo 插件已采用贡献入口驱动 RPC、provider、hook，并使用模拟宿主和可控时钟；可以沿用此类先例，但不能声称本仓库已有通过的测试。
- 真实宿主与测试用 Multica Issue 的端到端验收是同一边界的最终验证，覆盖 CLI 自部署登录、原生侧栏、消息、执行段和停止。静态类型检查、模拟服务或源码阅读不能代替真实加载与使用验收。

必须覆盖以下行为组合：

| 测试场景 | 可观察的验收结果 |
| --- | --- |
| 默认或命名 CLI profile 指向自部署服务 | 使用正确 API 地址与现有凭据；前端地址单独处理，无新 Token 或云地址兜底 |
| 环境覆盖、任务配置隔离、缺失或不可读配置 | 遵守 CLI 范围，不借用拥有者或其他用户凭据；明确显示未就绪原因 |
| CLI 原子替换、登出、同账号轮换及账号切换 | 及时重读；移除后不继续用缓存凭据；同身份续用，不同身份隔离，旧投递不误发 |
| 空规则及多值组合筛选 | 空配置无导入；字段间交集、字段内并集；本人和 agent/squad 条件不混淆 |
| 任务进入、退出、重返范围及人工隐藏 | 稳定创建或恢复；自动退出不取消；人工隐藏优先 |
| 多成员、多 agent 和系统事件 | 正确原生角色与名称前缀，系统变化不伪装普通发言 |
| 主讨论发送与 Thread 回复 | 分别形成新根评论与正确 parent 的回复；同一回显不重复 |
| 评论编辑、删除和首次读取已变更快照 | 保留可用原消息并追加已观察到的更正，不虚构从未读取的版本 |
| 多 Thread 关联同一 Run；无关联后补关联 | 执行段只出现一次，首次归属固定，网络失败不误触发主讨论兜底 |
| 同一 tab 多个并行及排队 Run | 每个执行可见，原生 turn 聚合准确，不把一个 Run 当作整条 Thread |
| 日志、最终评论、缺失调用 ID 和截断输出 | 日志不重复成主回复，最终评论正常显示，缺失信息明确而不伪造 |
| 普通运行中发送及显式中断/排队 | 遵循已选发送模式；普通评论不额外要求远端 steering |
| 响应丢失、重复请求、幂等回执与过期 | 有保证时不重复评论或副作用；无保证时待核实；请求正文与目标保持不变 |
| 活动 turn 结束与发送失败的竞态 | 不把未发表消息显示成功；验证宿主 steer fallback，不将普通失败错误表示为另一种已确认操作 |
| 停止与旧投递重试的竞态 | 不因旧待投递输入自动重试而意外重新触发执行；也不静默丢弃输入或虚报发表成功 |
| 原生停止时多个未结束 Run | 只取消此次集合中的该 tab Run，历史和其他 tab 不受影响，跨 Thread Run 整体处理 |
| 取消与完成竞态、部分失败、关闭后归档 | 状态真实，失败仍可见可重试，人工隐藏不被自动撤销 |
| workspace 归档、自动归档、客户端断开和空闲清理 | 不因本地清理错误取消远端执行 |
| 连接引导、多客户端、daemon 重启及重连 | 单个幂等同步循环；重启后由客户端连接恢复；不要求打开管理页 |
| 延迟读取、事件重复、断线补读与历史恢复 | 无任意最近条数限制；缓存可用，记录不重复，按源能力补齐历史 |
| Issue 不可访问与连接级鉴权/网络故障 | 前者只读历史，后者连接异常，不批量误判删除 |
| 宿主 0.15.3 实际加载及所用 SDK 契约 | 验证注册、RPC、renderer、目录与身份恢复、消息及停止，不仅检查导出符号存在 |

## Out of Scope

- 修改 Paseo 核心以新增远程 workspace 类型、改变原生停止协议，或支持任意原生历史消息原位改写。
- 把一个 Run 复制到多个 Thread tab，或在后续发现关联时迁移其首次展示位置。
- 在没有新客户端连接时保证 daemon/plugin 重启后完全无人值守恢复。
- 在 Paseo 上传图片或附件、编辑删除远端评论、新建 Issue 或修改任务状态；这些仍在 Multica 完成。
- 原位删除或覆盖已经导入的原生评论历史；采用追加更正与删除提示。
- 为插件创建独立账号、新 PAT、浏览器 Cookie 登录或未经支持的自动刷新令牌流程。
- 跨主机或跨用户自动提取 CLI 登录态、绕过 CLI 任务隔离，或向客户端暴露凭据。
- 在没有可验证去重保证时盲目自动重发评论，或者假定保存评论必然启动 Run。
- 部分取消一个跨 Thread Run、扩大到 agent 的全部任务，或者凭 HTTP 成功保证远端进程已退出。
- 用本地占位目录代替真实远端代码仓库，或在 Paseo 主机执行 Multica 任务本身。

## Further Notes

### 决策状态与证据边界

27 项产品决定和自部署/CLI 登录复用补充已经确认。长期术语与八项 ADR 已在本地对齐：Thread 会话边界、占位目录接入、Run 唯一归属、原生停止、原生评论历史、连接身份隔离、安全重试和 CLI 鉴权复用。本 issue 包含实现所需的决策，不以聊天记录或尚未发布的本地文档链接作为执行前提。

本机安装包的 desktop、server、client、plugin、protocol 清单为 0.15.3；开发参考 SDK 为 0.15.4。静态核查已确认所需能力存在，其中 plugin、protocol、client 的已比较 JavaScript 文件逐字节一致，尚无必须升级的证据；未逐文件证明整个 server 相同，也未独立证明正在运行 daemon 的版本。真实加载和运行验收仍待实现阶段完成。

CLI 鉴权依据安装的 0.6.3，对应提交 `18fa9f728a9e25f2465df2789631edb2a75442ad`。Multica 服务端功能证据采用提交 `33215cec572fd2a9859c702311dfb23b80bc8be5`；用户真实自部署服务的版本、权限及能力仍需验证，不能据公开源码宣称已经联通。

### 需要在实现中验证的宿主行为

外部 provider 可声明 `prompt.steer`。宿主只接受匹配活动 turn 的 steer 结果；failed 或不匹配结果可能被转为 unavailable，进而中断并替换。普通投递失败不能被简单处理成该 fallback 而忽略副作用。可靠接收投递意图、独立呈现远端结果是已讨论的工程候选，尚未证明有效，也不是额外锁定的实现方式；必须验证实际契约、失败和并发情况，不能伪称消息已发表。

同样，恢复运行中的 agent 可能先中断，原生关闭取消失败后仍可能归档，单个原生活动 turn 需要聚合多个远端 Run。这些都是实现验收必须覆盖的已知约束。若现有边界无法满足已确认行为，应带具体证据回报，而不是悄悄修改范围或转为 Paseo 核心改造。

### 固定版本的参考依据

- [Paseo provider 协议与能力](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/plugin/src/server/provider.ts)，[原生停止与归档路径](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/agent/lifecycle-command.ts)，[外部 provider 的 steer 适配](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/agent/plugin-provider.ts#L1293)。
- [Paseo 客户端扩展与 renderer](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/plugin/src/client/contracts.ts)，[插件连接与时间线约束](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/docs/plugins.md)。
- [Multica 评论类型](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/packages/core/types/comment.ts)，[运行与关联字段](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/packages/core/types/agent.ts)，[评论幂等回执](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/handler/comment_idempotency.go)。
- [Multica CLI 配置发现与存储](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/internal/cli/config.go)，[profile、地址与隔离规则](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/cmd/multica/cmd_agent.go)，[CLI 登录与凭据读取](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/cmd/multica/cmd_auth.go)。

当前没有功能代码或已通过的运行验收。此 issue 是完整母规格，后续可以按可验证的交付片段拆分任务；不能将规格发布、静态核查或模拟测试称为集成已经可用。
