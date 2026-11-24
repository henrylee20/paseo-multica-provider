# Paseo–Multica 设计访谈

27 项产品决定及用户补充的 S1（自部署与 CLI 登录复用）已获整体确认，并通过 `/to-spec` 发布 [规格 issue #1](https://github.com/henrylee20/paseo-multica-provider/issues/1)，尚未开始功能实现。
实施规格见 [spec.md](./spec.md)，工程步骤与验证门槛见 [implementation-plan.md](./implementation-plan.md)；本文件保留逐项决定及源码证据。

## 已确认

- Q1：首版支持查看与发送消息。Paseo 中发送的消息写入对应 Multica Thread，执行仍由 Multica 调度。
- Q2：按筛选规则动态收录任务；不采用显式选择并持久保存的固定任务集合。
- Q3：一个连接绑定一个 Multica 账号，以当前连接用户身份判断“自己的评论”。
- Q4：业务任务指 Issue；Thread 指 Issue 内以顶层评论为起点的讨论串。工作区、任务、讨论串的展示边界见 [ADR 0001](./adr/0001-thread-as-paseo-session.md)。
- Q5：保持 Paseo 核心不变，采用 provider、任务同步器和本地占位目录。占位目录不代表 Multica 的代码工作区，见 [ADR 0002](./adr/0002-use-existing-paseo-with-placeholder-directories.md)。
- Q6：每个 Run 只能保留一个展示位置，不在多个相关 Thread 重复展示。具体规则由 Q10、Q11 确认。
- Q7（由 Q13 修订）：关闭运行中的 tab 允许停止对应 Multica Run；归档 Paseo workspace 仍只改变本地展示。关闭与归档不删除 Multica Thread，也不直接改变 Issue 状态。
- Q8：每个 Multica 工作区配置筛选规则，不同字段取交集，同字段多值取并集；首版字段包括负责人（成员、agent、squad）、状态、标签和 Multica project。直接分配给用户和分配给其 agent/squad 的语义不同，初始规则由 Q12 确认。
- Q9：普通发送回复当前 Thread 的根评论，遵循 Multica 原有路由并支持显式 agent mention。允许成功保存评论但不启动 Run。
- Q10：有评论关联的 Run 优先归属触发评论所在 Thread，没有触发评论时归属最早关联评论所在 Thread；后续合并或追加评论不改变已确定的归属。
- Q11：每个 Issue 使用一个本地主讨论 tab 展示 Issue 描述和完全无评论关联的 Run，不为此自动创建远端评论或 Thread，见 [ADR 0003](./adr/0003-unique-run-display-ownership.md)。
- Q12：必须显式启用工作区和规则；空配置不导入任务。新建规则默认仅包含未开始和进行中的任务，负责人、标签、Multica project 不限。
- Q13：保留 Paseo 原生停止体验，允许关闭运行中 tab 导致远端 Run 停止；继续保持 Q5 的不改核心方案。原生中断调用 Multica 的运行取消操作，见 [ADR 0004](./adr/0004-native-interrupt-stops-remote-run.md)。
- Q14：人工隐藏优先于动态筛选。不再匹配时自动归档，重新匹配时自动恢复；手动关闭或归档的对象保持隐藏，直到主动恢复，保留本地身份与历史。自动筛选归档不停止远端；手动关闭运行中 tab 的取消行为遵循 Q13。
- Q15：首次确定的 Run 展示归属保持不变，包括先落入本地主讨论的 Run；后续出现真实 Thread 关联只更新关联信息，不迁移执行段。
- Q16：本地主讨论中每次发送消息均在该 Issue 下创建一条顶层评论及新的 Thread，后续在该 Thread tab 回复。首版不提供新建 Issue 或修改任务状态入口，这些操作仍在 Multica 完成。
- Q17：每个 Run 是可展开的执行段，展示 agent、状态、逐条工具调用及结果、运行文本和错误。主对话消息仅来自评论；agent 最终评论作为正常 assistant message 出现，不将运行文本另外复制为主对话回复。
- Q18：原生停止取消操作时归属当前 tab 的全部未结束 Run，包括等待执行的 Run；不取消其他 tab 的 Run，不影响历史上已结束的 Run。跨 Thread 的 Run 作为整体取消。
- Q19：运行中默认发送仍是普通 comment，由 Multica 排队或合并，不额外请求注入当前 Run；用户主动选择 Paseo 的中断或排队发送模式时，遵循其原生行为。
- Q20：保留原生 user/assistant 消息。远端评论编辑、删除通过追加更正内容或删除提示体现，原消息仍保留，见 [ADR 0005](./adr/0005-preserve-native-comment-history.md)。
- Q21：客户端连接时自动启动或恢复后台同步，无需专门打开插件页面；启动成功后关闭客户端仍可继续同步。daemon 或插件重启后需要至少一次客户端连接，不承诺无人连接时自行恢复。
- Q22：首版支持文本、Markdown 和已有附件链接，发送仅支持文本；上传附件、编辑和删除评论仍在 Multica 完成。任务状态变化等系统记录独立呈现为事件，不作为参与者的 assistant 回复。
- Q23：后台同步任务、Thread、Run 概要；打开 tab 时读取评论历史，展开执行段时读取工具输出，不人为截断为最近若干条。断网保留缓存并显示同步状态，投递失败或结果不明不能显示为已成功发表。
- Q24：更换 Multica 服务或账号时隔离本地映射，保留旧历史原身份和消息角色；同账号只更新 Token 时续用映射。连接状态与筛选在插件管理页集中管理；凭据来源由补充 S1 确定为 daemon 侧复用 CLI 登录，见 [ADR 0006](./adr/0006-isolate-connection-identities.md)。
- Q25：同一次发送使用固定请求编号，先查询是否已发表；仅在已确认具备去重保证且仍在有效期时自动重试。超过有效期、服务不支持或结果仍无法确认时保持待核实，由用户核实后决定重发，见 [ADR 0007](./adr/0007-retry-comments-only-with-deduplication.md)。
- Q26：多个 Run 部分取消失败时如实显示每项结果，原生停止报告失败；即使关闭继续归档，管理页仍保留未停止 Run 的告警与重试入口，不自动重开 tab，不宣称全部停止。
- Q27：Issue 远端删除或失去权限时移出活跃列表、停止写入，保留已同步历史为只读；网络故障或连接级 Token 失效只标记连接异常，不批量判定任务删除。恢复访问后重新核对并尊重人工隐藏。
- S1（用户补充）：必须支持自部署 Multica，默认直接复用本地已有 Multica CLI 的登录态，包括该登录上下文的服务地址与现有凭据。例如 CLI 已登录 selfhost.xxx.com 时使用该自部署服务，不要求额外配置另一枚 Token。此补充取代插件独立保管登录凭据的默认方案，见 [ADR 0008](./adr/0008-reuse-multica-cli-authentication.md)。

## 已核查的约束

- 版本必须区分：本机已安装的桌面程序及其附带 server/client/plugin/protocol 清单均为 **0.15.3**；相邻插件项目安装的 SDK 为 **0.15.4**，下文的固定源码链接也以 0.15.4 为接口核查基线。静态核查确认所需 provider、steer、timeline renderer、RPC 引导和 workspace 恢复能力在安装的 0.15.3 中存在；其中 plugin/dist 的 31、protocol/dist 的 77、client/dist 的 23 个 JS 文件与相邻项目的 0.15.4 SDK 逐字节相同，尚未发现必须升级的阻碍。这不等于整个 server 完全相同，也不证明当前运行 daemon 的版本或运行兼容性；仍需实际加载验证。安装的 0.15.3 中断 schema 同样没有原因字段。
- Paseo v0.15.4（`1c00b365c9e0b74c1580eba33d905d693125ae21`）：provider 契约不提供原生 project/workspace 的枚举与创建；需要额外同步这些记录。现有交互 workspace/agent 要求 daemon 上存在实际目录，非 Git 目录也可使用。[Provider 契约](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/plugin/src/server/provider.ts#L29)、[Workspace source](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/protocol/src/messages.ts#L2715)。
- Multica（`33215cec572fd2a9859c702311dfb23b80bc8be5`）：API 的 AgentTask/task_id 表示一次运行；一次运行能合并不同 Thread 的评论，也可能没有触发评论。[运行字段](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/packages/core/types/agent.ts#L316)、[跨 Thread 合并](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/handler/agent.go#L807)。
- Multica 评论包括成员、agent 和 system 作者；执行消息包括 text、thinking、tool_use、tool_result、error。系统记录与运行文本的呈现不能仅凭“其他人评论”规则推断。[评论字段](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/packages/core/types/comment.ts#L1)、[执行消息](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/packages/core/types/events.ts#L364)。
- Multica 正常 Issue 列表支持所选筛选字段并分页返回；`open_only=true` 走旧查询路径，会忽略标签等部分筛选。应在后续实现中使用正常列表的状态类别筛选，而不能把 `open_only` 当作同等替代。[列表分支](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/handler/issue.go#L1459)。
- Multica agent mention 使用带身份的 Markdown 链接，而非裸 `@名称`；回复根评论保留 Thread，但不保证产生执行，成功保存评论与 agent 触发结果需要分别表达。[mention 解析](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/util/mention.go#L19)、[评论路由](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/handler/comment.go#L2723)。
- Paseo 原生停止与运行中关闭 root-agent tab 都发送无原因字段的 `session.interrupt`，provider 无法区分；运行中刷新/替换/回退也可能要求先中断。接受中断却不停止远端，会让 Paseo 强制结算为 canceled，不能用假成功应答实现。Q13 选择真实取消远端执行，范围和失败处理分别由 Q18、Q26 确定。[调用路径](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/agent/lifecycle-command.ts#L96)、[拒绝与结算](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/agent/agent-manager.ts#L3351)。
- workspace 归档直接关闭各 agent 的会话，不先发上述中断；空闲清理及 daemon 关闭也有 `session.close` 路径。单纯 close 必须仅释放本地资源，自动筛选归档不能逐个调用会先中断的 root-tab 归档入口。[workspace 归档](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/workspace-archive-service.ts#L517)。
- 按规则归档/恢复能保留 workspace 与 agent 身份，前提是保留占位目录、分别恢复 workspace 和 agent。不能用会分配新身份的 `resumeAgent(handle)` 替代稳定身份恢复。Paseo 的归档是 daemon 级状态，同一 daemon 的各客户端共享；它不是每个客户端独立的隐藏偏好。[Workspace 恢复](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/session/workspace-recovery/workspace-recovery-service.ts#L103)、[Agent 恢复](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/session.ts#L4760)。
- `refreshAgent` 对已存活且运行中的 agent 会先中断再 reload，采用 Q13 后可能取消远端 Run；它只可用于明确的已归档恢复场景，不能充当普通同步轮询。低层 create/restore/import/refresh 位于导出的 `@getpaseo/client/internal/daemon-client`，不能将其全部写成高层 PaseoApi 能力；活动 handle 的 import 也不是 upsert。[运行中 refresh](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/session.ts#L4760)。
- Multica 的 `POST /api/tasks/{taskId}/cancel` 针对单个 Run，返回更新后的任务记录；HTTP 200 也可能返回竞态中已完成的记录，不能直接当作“取消成功”。状态变更与广播不等待执行进程清理，进程清理确认是另外的 daemon 回执；界面必须区分远端任务状态与已确认的物理停止。[取消接口](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/handler/chat.go#L1918)、[取消服务](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/service/task.go#L3108)。
- 单个 Thread 可以有多个未结束 Run：不同 agent 可并行执行；同一 agent 在同一 Issue 内串行处理，运行开始后的新评论可以生成后续待执行 Run。可取消状态为 `queued`、`dispatched`、`running`、`waiting_local_directory`、`deferred`，不应在实现中使用不存在的 pending/assigned 状态名。[执行串行范围](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/pkg/db/queries/agent.sql#L822)、[Thread 排队回归测试](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/handler/comment_thread_queue_test.go#L16)、[取消状态](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/pkg/db/queries/agent.sql#L1525)。
- Paseo 每个 tab 的活动 turn 是单个槽位；多个远端 Run 需要由 provider 聚合管理，以 `timeline.plugin` 自定义执行段呈现各 Run，不能把多个 Run 当作多个同时活动的原生 turn。[执行段 renderer](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/plugin/src/client/contracts.ts#L199)、[单一 turn 映射](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/agent/plugin-provider.ts#L1524)。
- 外部 provider 可声明 `prompt.steer`，接收 `session.prompt` 的 `delivery: steer` 并返回匹配活动 turn 的 steer 结果；内部 SDK 的 `tryHandleOutOfBand` 不向外部插件开放。原生用户设置仍可选择 interrupt 或 queue；steer 返回 failed 等非匹配结果也会被适配器当作 unavailable，继而中断并替换，不能承诺发送失败时绝不会取消原运行。[公开 prompt 契约](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/plugin/src/server/provider.ts#L132)、[外部适配器](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/agent/plugin-provider.ts#L1293)。
- 公共插件契约没有 daemon 启动 hook，也不在 server contribute 中提供 Paseo API。客户端 contribution 可以通过 RPC 自动引导后台同步，成功启动后即使客户端断开仍能继续；daemon/plugin 重启后则需要至少一个客户端连接并再次执行幂等引导，且客户端 setup 本身不会在每次重连时重跑。完全无人连接的重启自恢复不能视为现有公共插件契约保证。[服务端上下文](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/plugin/src/server/contracts.ts#L30)、[客户端 RPC](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/plugin/src/client/contracts.ts#L294)、[连接生命周期](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/docs/plugins.md#L624)。
- 原生 user/assistant timeline 消息不能凭稳定 messageId 任意替换或删除；同 ID assistant 快照用于流式追加，user 更新可能形成另一条消息。工具和 plugin 行才支持稳定身份替换；插件行无物理删除 API，且单行数据上限为 64 KiB。Q20 选择保留原生消息并追加更正事件。[消息映射](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/agent/plugin-provider.ts#L1895)、[身份规则](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/protocol/src/timeline-identity.ts#L3)、[插件 timeline 契约](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/docs/plugins.md#L639)。
- Timeline transformer 仅收到 item 与 phase，不直接得到 agent 或行级 providerMessageId。普通 composer 消息回显保留 clientMessageId，远端 comment 身份放在 transformer 无法直接读取的行级字段，因此不能把“用 transformer 原位修正所有原生评论”当作已验证的通用方案；原生持久化内容也不会被渲染变换更新。[Transformer 契约](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/plugin/src/client/contracts.ts#L261)、[消息回显协调](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/agent/agent-manager.ts#L5079)。
- 所核查的 Multica 提交支持评论 `Idempotency-Key` 与 `GET /api/issues/{id}/comments/idempotent`。同一 workspace/作者/key 的重放返回已有评论，不重复创建或触发副作用；回执保留 7 天，key 最长 255，原评论已删除时返回 409。指纹包括 Issue、parent 和 type，但不包含正文，因此本地必须固定一次投递的正文和目标。过期后查不到回执不等于从未发表；实际连接是否支持该接口仍需验证。[幂等实现](https://github.com/multica-ai/multica/blob/33215cec572fd2a9859c702311dfb23b80bc8be5/server/internal/handler/comment_idempotency.go#L21)。
- 已安装 CLI 为 `/usr/bin/multica` 0.6.3，提交 `18fa9f728a9e25f2465df2789631edb2a75442ad`。默认与命名 profile 分别读取用户 home 下的 `.multica/config.json` 和 `.multica/profiles/<name>/config.json`；`MULTICA_TASK_CONFIG_ROOT` 改变配置根，没有 XDG 或已保存全局 active-profile 机制。[配置发现](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/internal/cli/config.go#L228)、[profile 解析](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/cmd/multica/cmd_agent.go#L252)。
- CLI 的 API 地址采用命令行覆盖、`MULTICA_SERVER_URL`、profile `server_url` 的顺序；token 采用 `MULTICA_TOKEN` 或 profile token，并对 daemon 任务上下文禁止不适当的全局凭据兜底。`app_url` 与 API 地址不同，不能混用。[地址解析](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/cmd/multica/cmd_agent.go#L296)、[凭据解析](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/cmd/multica/cmd_auth.go#L73)、[任务隔离](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/cmd/multica/cmd_agent.go#L377)。
- CLI 浏览器登录把回调 JWT 换成请求有效期 90 天的 PAT，验证 `/api/me` 后把 token、server_url、app_url 写入配置；没有保存刷新令牌或有效期字段，也没有公开 token 导出命令。配置按 0600 权限原子替换，重新登录后插件可以重读；不能声称可自动续期或与浏览器 Cookie 共用。[登录流程](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/cmd/multica/cmd_auth.go#L308)、[配置读写](https://github.com/multica-ai/multica/blob/18fa9f728a9e25f2465df2789631edb2a75442ad/server/internal/cli/config.go#L310)。
- 本地只读检查确认默认 CLI 配置存在、权限为 0600、已有凭据及工作区选择，未发现命名 profile；只记录非敏感状态，没有输出凭据、运行 auth status 或调用用户远端服务。自部署示例是所需支持场景，不代表本次观察到的默认配置已经连接该示例主机。

这些约束来自公开源码核查，并非用户实例的运行验证。

## 整体确认与实施验证

Q1–Q27 与补充 S1 均为明确的用户要求；Q13 修订了 Q7 的关闭运行中 tab 行为，S1 将默认鉴权改为复用 CLI，最终内容以修订后的汇总规格为准。
用户已确认修订规格，并要求执行 `/to-spec`、使用 `gh` 跟踪；完整规格已发布为 [issue #1](https://github.com/henrylee20/paseo-multica-provider/issues/1)，标签为 `ready-for-agent`，本地副本见 [github-spec.md](./github-spec.md)。界面文案、模块组织和验证步骤属于 [实现计划](./implementation-plan.md) 中可调整的工程约定，不冒充额外的已确认产品决定。
源码核查不能替代插件实际加载、用户 Multica 实例能力探测与端到端验收；这些仍需在实现阶段完成。

## 已确认决策的验收场景（尚未执行）

| 场景 | 预期结果 |
| --- | --- |
| 空配置；随后启用工作区与规则 | 空配置不导入；启用后按字段交集、字段内值并集纳入任务。 |
| 任务进入、退出、重返筛选范围 | 创建或恢复同一任务映射；自动归档不取消远端；人工隐藏的对象不自动恢复。 |
| 两个 Thread 关联同一个 Run | 执行段只出现在首次确定的归属位置；后续补充关联或重连不复制、不迁移。 |
| Run 最初无关联评论，之后关联 Thread | 固定留在本地主讨论，关联信息可更新。 |
| 主讨论发送；真实 Thread 内回复 | 前者创建顶层评论及新 Thread，后者回复原根评论；成功保存评论不强制要求产生 Run。 |
| 本人、其他成员与 agent 发言 | 本人按连接身份显示 user message；其他参与者显示带作者名前缀的 assistant message。 |
| 评论编辑、删除与系统状态变化 | 原评论保留，追加更正/删除事件；系统事件不伪装参与者回复。 |
| Run 输出工具日志并最终发表评论 | 工具、运行文本及错误仅在执行段内；最终评论作为对话消息，不重复复制日志到主对话。 |
| 同一 tab 多个运行中及排队 Run，点击原生停止 | 取消操作时属于该 tab 的全部未结束 Run；其他 tab 及历史结束 Run 不受影响。 |
| 关闭运行中 tab；归档整个 workspace；关闭客户端 | 前者请求远端取消；后两者不因本地资源关闭而取消远端。 |
| 客户端连接、断开、重连，daemon 重启后再次连接 | 幂等引导单个后台同步器；客户端断开后仍可同步；daemon 重启后由连接重新引导。 |
| 打开历史 Thread 并展开 Run | 获取可用评论历史；工具输出按需读取，不因界面限制静默截断。 |
| 断网、恢复、重复事件 | 显示缓存与同步状态；重新核对远端，不重复创建 tab、原始评论或执行段。 |
| 原生消息发送后收到服务端评论回显 | 用发送关联信息识别同一条评论，避免乐观消息与远端回显重复。 |
| 已归档任务恢复 | 保留 workspace/agent 身份与占位目录；不通过刷新运行中 agent 来进行普通同步。 |
| 更换账号或服务；同账号更换 Token | 前者隔离映射并保留历史身份；后者续用映射，不重复生成项目、workspace 和 tab。 |
| 评论保存成功后响应丢失 | 查询同一次投递的幂等回执，在有效保证范围内重试不重复评论或触发副作用。 |
| 回执过期、接口不支持或结果不明 | 保持待核实，不把没有回执当作从未发表，也不盲目自动重试。 |
| 多 Run 取消部分成功，随后 tab 关闭 | 每个 Run 显示真实状态；管理页保留失败与重试入口；tab 保持人工隐藏。 |
| Issue 删除、权限撤销、Token 失效和断网 | 区分对象不可访问与连接级故障；保留缓存，按 Q27 控制活跃列表与写入。 |
| 默认 CLI 已登录自部署服务 | 使用该上下文对应的 API 地址和现有凭据，不要求另生成 Token，不把请求发往硬编码云地址。 |
| 使用命名 profile；API 与前端地址不同 | 显式选择同一 profile；API 请求与界面链接各用正确地址，不猜测全局 active profile。 |
| CLI 重新登录、登出或原子替换配置 | 重新读取上下文；同账号轮换续用映射，凭据移除后不继续用缓存 Token。 |
| CLI 换服务或换账号，仍有待投递记录 | 隔离身份与映射，不把旧投递或旧凭据转发给新服务或用户。 |
| daemon 用户不同或存在任务隔离上下文 | 使用其可访问的合法上下文；不给隔离任务回退借用拥有者登录，不能自动借用另一机器的客户端凭据。 |
| 0.15.3 宿主实际加载插件 | 验证 provider 注册、RPC 引导、原生消息、执行段和停止行为；不能以静态比较代替运行验收。 |
