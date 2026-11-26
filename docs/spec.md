# Paseo–Multica 当前规格

本文件定义插件当前的完整产品与协议行为。上游宿主与 CLI 的固定源码证据见 [设计依据](./design.md)，领域术语见 [GLOSSARY](../GLOSSARY.md)，模块架构与开发红线见 [AGENTS.md](../AGENTS.md)，安装操作见 [README](../README.md)，实机与模拟验证范围见 [交付验收记录](./acceptance.md) 及 [AskUser 验收清单](./askuser-acceptance.md)。

## 接入形态与对象映射

插件由服务端 provider、daemon 侧后台同步器与客户端界面贡献组成，不修改 Paseo 核心，不在本机执行 Multica 任务。每项任务使用独立的本地非 Git 占位目录满足 Paseo 交互式工作区契约；占位目录不代表远端代码仓库，原生文件与终端功能会指向该目录。

| Multica 对象 | Paseo 表达 |
| --- | --- |
| Multica 工作区 | Paseo 项目（project） |
| Issue | Paseo 工作区（workspace） |
| 以顶层评论为根及其后代组成的 Thread | 独立 agent tab |
| 连接用户本人的普通评论 | 原生 `user` 消息 |
| 其他成员或 agent 的普通评论 | 带作者名称的原生 `assistant` 消息 |
| 一次 Run | 唯一归属讨论下的只读 provider subagent |
| 系统变化、评论更正与删除 | 独立时间线事件 |

映射生成的 Paseo 项目名称统一为 `Multica · <Multica 工作区名称>`。已有项目在下次成功同步时补齐前缀；远端工作区改名时同步更新，名称未变时不重复改名。

每个 Issue 另有本地主讨论，展示任务描述、Issue 级系统事件与首次展示时完全无评论关联的 Run。主讨论本身不是远端 Thread：在此发送消息会创建新的顶层评论及远端 Thread；在真实 Thread 内发送则回复其根评论。

## CLI 登录与身份隔离

默认复用 daemon 主机同一运行用户的 Multica CLI 登录，支持云服务与自部署地址。插件只读读取配置，不生成独立 PAT、不改写 CLI 配置文件、不共享其他设备客户端或其他系统用户的登录态。API `server_url` 与前端 `app_url` 分别解析使用，不硬编码云服务兜底地址。

设置页提供 **CLI profile** 下拉框，只读枚举 `<配置根>/config.json`（默认配置，空字符串）与 `<配置根>/profiles/*/config.json`（跳过不符合设置 schema 的目录名；`token` 非空且 `server_url` 有效视为已登录，当前已选 profile 即使未登录仍保留显示）。插件不猜测全局 active profile，不向 RPC 返回凭据，也不使用未选中 profile 的凭据请求 `/api/me`。遵循 `MULTICA_SERVER_URL`、`MULTICA_TOKEN`、`MULTICA_APP_URL` / `FRONTEND_ORIGIN` 及 `MULTICA_TASK_CONFIG_ROOT` 覆盖规则：环境变量覆盖凭据时提示切换 profile 不改变账号；检测到任务隔离上下文时禁用下拉框，且不读取拥有者配置目录。

规范化 API 服务地址与 `/api/me` 返回的真实用户 ID 共同组成 `connectionKey`：

- **同一 profile 内**：同服务同账号轮换 Token 续用原映射；经 CLI 更换服务或账号则从独立空规则开始，不自动删除旧连接，历史消息角色、`ownerRootId` 与人工隐藏保留在原连接下，且旧连接不能借用新登录发表评论、取消 Run 或补读远端明细。
- **切换 CLI profile 时**：客户端先弹窗展示本机 Project、任务、讨论数量并说明不影响远端，确认后再保存设置。服务端以持久归属 `state.owner.profile` 驱动可重复执行的清理（[ADR 0010](./adr/0010-clear-local-data-on-profile-switch.md)）：在允许新 profile 同步、导入或写规则前，彻底清空前一 profile 留下的本地映射、规则、缓存、人工隐藏、原生讨论（`deleteAgent`，不取消远端 Run）、不含用户自建活跃工作区的插件 Project 与占位目录；即使新旧 profile 指向同一账号也执行清理，同一 profile 下曾累积的多个连接一并清空。含用户自建活跃工作区的 Project 保留 Project 与占位目录，仅删插件讨论、归档插件工作区并在设置页提示。旧状态缺少 `owner` 时采用当前 profile，升级不删数据；清理失败保留原归属并在下次引导重试。

CLI 配置文件原子替换、重新登录和登出会触发重读；每次远端请求发送前重新核对 profile 与有效凭据，`401`/`403` 使内存中的 `/api/me` 验证缓存（最长 60 秒）失效；已发出的网络请求无法撤回。同一 profile 离线或登出时本地已读缓存仍可读。

## 筛选、归档与人工隐藏

初始无启用规则，不导入任何任务。按 Multica 工作区启用并配置筛选条件：负责人（`member` / `agent` / `squad`，“我”置顶，直接分配成员与分配其 agent/squad 独立匹配）、状态类别或具体状态、Multica 项目和标签。字段间为 AND，同字段多值为 OR，空选表示不限。

同步后的状态内容不变时，不写 `state.json`、不通知订阅者。Paseo 工作区与讨论仅在远端标题变化或刚创建、刚恢复时改名，成功应用的标题会持久记录以便失败重试与重启；用户在 Paseo 手动改的名字保留到远端标题变化（本地主讨论固定为「主讨论」），避免空轮询刷新宿主活动时间。

规则编辑器默认勾选「未开始」和「进行中」整类：完整勾选某类别时按类别保存并自动纳入未来新增状态；存在部分勾选时将全部已选状态展开为具体状态键保存（旧混合规则按交集载入）。编辑已有规则时通过只读 `workspace.preview` 预览匹配总数、当前已导入数及预计新增/移出任务（不写状态、不阻塞同步队列）。每个连接首次预览用空 `ids=` 探测并在内存记住支持情况：支持时以 `limit=1` 读取服务端匹配总数，将已导入且未自动归档的 ID 按 100 个一批附带相同规则并行求交集，新增数为总数减交集数、移出为已导入减交集；不支持时退回完整分页。人工隐藏仍计入已导入，工作区归属与连接身份始终核对。每个 Multica 工作区仅保留最新一次预览，新预览通过 `AbortController` 中止旧预览的在途请求，不缓存预览结果。`workspace.rule` 与 `workspace.enable` 按到达顺序校验并原子落盘后立即返回 `saved` 与当前 `sync` 状态，后台同步或归档异步执行且失败不回滚已保存规则；停用本地已知工作区不依赖远端工作区列表。

| 范围变化 | 本地生命周期行为 |
| --- | --- |
| 首次匹配筛选 | 创建稳定映射、占位目录及原生 Project / Workspace / 主讨论 |
| 从完整成功的筛选列表中消失 | 按 `filter_exit` 归档 Paseo 工作区，保留原身份、占位目录与历史 |
| 重新匹配筛选 | 恢复 Paseo 工作区及归档前活跃的讨论（人工隐藏项除外） |
| 显式停用工作区规则 | 按 `rule_disabled` 归档任务；完整分页核对无活跃子工作区后移除插件 Project |
| 重新启用曾移除的 Project | 重建 Project 与新工作区外壳，以原 cwd 和 provider handle 导入迁回原讨论（保留 `agentId` 与历史） |
| 用户关闭 tab 或手动归档 Paseo 工作区 | 持久记录人工隐藏，优先于自动同步导入，直到用户显式恢复 |
| 网络错误、分页不完整或连接鉴权失败 | 报告同步异常并保留已有缓存，绝不推导为任务退出筛选 |

插件 Project 内存在用户自建活跃工作区时不移除 Project。自动归档事先持久化 `archiveReason` 与最初活跃讨论集合 `ruleArchivedAgentIds`，避免归档 hook 误记为人工隐藏，并在回执丢失或原生状态漂移后继续重试。

人工隐藏在同一 daemon 的所有客户端间共享。设置页分别提供 **恢复 Paseo 工作区**（不解除其中讨论的隐藏）与 **恢复讨论**（仅解除所选讨论隐藏）。由于宿主恢复工作区可能按时间戳回退唤醒同工作区隐藏讨论，自动与手动恢复均先对未选中解除隐藏的讨论持有 `DiscussionLifecycle.hold()`，关闭本地活动投影、等待已接收的 Stop 完成并拒绝竞争打开，恢复后再安全重新归档这些隐藏记录，全程不取消远端 Run（[ADR 0002](./adr/0002-use-existing-paseo-with-placeholder-directories.md)）。

## 评论、发送与回声

发送仅接受非空纯文本；附件、非文本内容、`outputSchema` 或缺失任务/Thread 映射均在 `prompt_result` 前直接拒绝。校验通过后立即在 `prompt_result` 前发出携带 `clientMessageId` 与原正文的原生 `user_message`，网络请求异步执行；发送失败保留该条原生用户消息并追加一条错误。

单次发送固定连接、目标、正文与随机 `Idempotency-Key`，遇到网络错误或 `5xx` 最多尝试 3 次。成功发送仅持久化 `clientMessageId → commentId / rootId` 回声映射，确保后台同步或重启核对不会将同一远端评论重复投影。主讨论发送成功后追加一条 `comment-delivery` 提示（「新 Thread 已建立，可在侧边栏打开。」），真实 Thread 内发送成功不追加额外条目。评论保存成功与 Run 是否触发分别表达。

Paseo `0.16.0+` 的讨论输入框注册 `multica-mention` 选择器（「提及 Agent」），搜索当前任务所属工作区的智能体并插入 `[@名称](mention://agent/<id>)` 规范引用（显示 ID 以区分同名 agent）；`0.15.x` 宿主不显示该选择器，宿主内置 `@` 文件候选保持不变。运行中普通发送通过 `prompt.steer` 接收输入并发表普通评论，交由 Multica 路由合并或排队，不强制远端中断；显式 `interrupt` 与客户端 `queue` 遵循宿主协议，插件不自建发送队列。

本人评论按连接用户 ID 与作者类型判定（本人名下的 agent 发言仍为 `assistant`）。相邻原生评论之间插入独立的 `comment-divider` 细线（首尾不加线，恢复与回声不重复加线）。原生消息保留首次读取正文，远端编辑、删除与系统变化追加独立的 `comment-event` 条目（超长事件经 `thread.event` 按需读取全文）；已有 Markdown 与附件链接原样保留，上传附件、编辑/删除评论、新建 Issue 与修改任务状态仍在 Multica 完成。

## AskUser 结构化提问与后台唤醒

所属 Thread 评论（含子回复）携带的 `askuser.json`（`version: "1"`，`application/json`）渲染为稳定的 `askuser` 时间线卡片，首次输出紧跟携带该附件的来源评论（后续状态更新原位合并；Thread 刷新先发现卡片再投递评论行，卡片发现失败仍投递已读评论），展示标题、完整警示说明、问题与选项（超长内容通过 `askuser.read` 分页展开）。附件按连接、Issue 与附件 ID 持久缓存，后台同步与打开 Thread 共用下载；严格限制当前 API 同源地址、禁止重定向、流式上限 64 KiB 并校验 schema，下载或校验失败仅在卡片报错，不阻塞普通评论同步。仅当 Issue 存在未确认终态的卡片时才额外拉取一次完整 `timeline`，核对直接回复（含超过摘要 200 runes 截断的长回答、`answer_user_id`、`delegated_by` 与条件必填）及远端跳过元数据，确认终态后停止额外轮询。

当卡片未决且当前连接用户可作答时，插件映射原生 `QuestionFormCard` 权限（稳定 ID 为 `multica:askuser:<cardCommentId>:<attachmentId>`，按 provider 会话、连接与 Issue 隔离）：

- **提交回答**：校验文本、单选、多选、`other` 与 `required_when` 条件必填；校验不通过保留原生表单并提示具体条件。提交生成精确的中文 `**确认结果**` 评论，`parent_id` 与 `askuser_answer_to` 均指向卡片评论，展示与停止归属仍留在原 Thread。原生权限响应等待有限次同 key 发送结果：成功则缓存答案并消除待答，失败则报错由用户重新提交。普通输入框聊天不充当卡片回答。
- **本地收起与重展**：原生 **Dismiss**（及 `clearPendingPermissions`）仅在本地收起表单，跨同步与重启保留收起状态，点击时间线卡片 **重新展开作答** 可恢复（若宿主已释放空闲会话则立即重新加载）。全选填文本表单额外追加一题「提交确认」，确保即使已输入文字甚至勾选确认，点击 Dismiss 仍走 `deny` 本地收起而不误发评论；缺少已知确认的模糊 `allow` 或原题全空同样仅本地收起，确认题本身不写入远端回答正文。含必填题或选项题的表单不追加确认题。
- **远端跳过**：通过卡片独立的 **跳过此卡 → 确认远端跳过** 二步操作调用 `askuser-skip`；成功不依赖响应 JSON 正文，尽力从完整 `timeline` 读取 `askuser_skipped_at` / `askuser_skipped_by`（无远端元数据时不伪造本地时间或操作者，`202 Accepted` 须经 `timeline` 确认才标终态）。原生 Stop 仅收起本地待决表单，不触发远端跳过。
- **后台无中断唤醒与通知时序**：后台完成卡片与 Run 概要同步后，仅对仍处启用规则内、无 `archiveReason`、未人工隐藏、未处于 `hold`、原生工作区与 agent 活跃且存在可答未决未收起卡片的 Thread，调用无中断的 `listCommands(agentId)`（不传 `purpose: "history"`，不调用会中断运行的 `refreshAgent`）。后台尝试按讨论去重并限流 60 秒，单个失败不阻塞其他讨论；显式点击「重新展开作答」不受限流限制。由于 Paseo `0.17.4` 在初次打开期间会将早于原生注册完成的权限视为静默历史回放，插件对本进程首次发现的新卡片延迟至 `await listCommands(agentId)` 返回后再 live 公布（已加载会话的新卡片直接 live，重启后的旧缓存仍在 `ready` 前静默回放；首次发现标记仅在实际发出后于内存清除，不持久化）。

## Run 子代理、活动聚合与原生停止

每个 Run 的展示归属 `ownerRootId` 按以下优先级首次确定并持久固定：明确触发评论所属 Thread → 五类关联评论（触发、合并、已交付、补充、生成评论 provenance）中按 RFC3339Nano `created_at` 最早者所属 Thread → 完整读取确认零关联时归属本地主讨论 `main`（缺父链或跨 Thread 缺可靠时间时等待，不猜测也不提前回退 `main`；后续新增关联或重连永不迁移，见 [ADR 0003](./adr/0003-unique-run-display-ownership.md)）。

每个 Run ID 通过父会话协商的 `session.subsession` 呈现为只读子会话 `session.opened{parentSessionId, toolCallId, restoration: "parent"}`（[ADR 0011](./adr/0011-run-as-provider-subagent.md)）：

- 标题为执行 agent 名称，描述为输入触发来源与创建时间（Run 自身生成的评论不当作触发输入，无输入关联时显示「任务级执行」）；重跑的新 Run ID 生成新子代理。
- 父讨论时间线按输入来源评论与创建时间排定一次静态 `sub_agent` 位置标记（状态固定 `completed`，子会话 `toolCallId` 指向该标记）：标记等待其输入锚点行（优先本讨论触发评论，否则最早输入关联评论，生成评论不作输入锚点）发出后，排在首条来源时间严格较晚的后续评论及其分隔线之前（同时间按 Run ID 排序）；无输入锚点的 Run 等完整评论快照可用后按纳秒时间参与排序；若存在输入来源却无对应行，须等开始等待后才发起的一次讨论刷新投递完成才认定锚点缺失。`markerProjected` 仅在标记实际发出后持久化，`history:skip` 只补发未发出的新标记，已有标记的 Run 立即恢复子会话。宿主按首次到达顺序固定条目位置，已错位的旧时间线需通过「重建数据」重排。
- 父讨论内所有处于 `queued`、`dispatched`、`running`、`waiting_local_directory`、`deferred` 的归属 Run 共同维持一个原生活动 turn（每次新活动周期分配全新 UUID）；子会话将这五类状态映射为 `running` 并在细分状态变化时追加简短说明，`completed` / `failed` / `cancelled` 映射为 `completed` / `failed` / `canceled`。
- 讨论在宿主打开（含导入）时，先按上述顺序发出 Run 标记，再同步打开对应子会话、推送已缓存内容并立即按已知终态结算，离线或明细拉取失败不阻塞终态展示；执行明细按连接分目录、每个 Run 单独原子落盘，仅消息或终态标记变化时写入，不进入 `state.json`；打开讨论时仅加载所属 Run 明细到内存，离线可重放这些文件。旧版 `state.json` 内嵌的 `runDetails` 直接丢弃，打开讨论后从远端重新补读，不迁移。归档与人工隐藏保留明细，切换 profile 清理与数据重建删除对应连接明细目录。仅本进程实际打开过的讨论补读远端执行明细（活跃期每 2 秒刷新，终态成功拉取后标记 `finalized` 停止；`finalized` 前不越过消息序号缺口，完成后按可得源顺序展示运行文本、思考、工具调用及结果、任务 `error` / `failure_reason` 与标明远端的 `work_dir` / `relative_work_dir`）。父会话纯关闭时仅清理本地子会话映射，不发子会话 `session.closed`。

原生 **Stop** 与关闭运行中 tab 触发 `session.interrupt`：固定操作开始时归属该讨论的活跃 Run 集合并逐项调用取消接口，不扩大到其他 tab 或随后新发现的 Run；跨 Thread 的同一 Run 只能整体取消，取消与完成竞态保留服务端实际终态。集合全部确认终结后完成捕获的原生 turn，若期间已有后来 Run 仍在活动则立即以新 UUID 开启下一周期；任一项取消失败直接返回 `request.failed`，由用户再次点击 Stop（[ADR 0004](./adr/0004-native-interrupt-stops-remote-run.md)）。整工作区归档、筛选退出、客户端断开与单纯 `session.close` 不取消远端 Run；插件卸载清理等待已接收的 Stop 请求完成。

## 同步、缓存与恢复

客户端贡献加载后立即并每 10 秒调用幂等 `sync.bootstrap`（跨 daemon 重连自愈；服务端已就绪且最近同步未失败时直接校验 `serverId` 并返回，不阻塞等待整轮同步）。daemon 每 15 秒及收到工作区 WebSocket 事件后执行快照核对；多个客户端共享同一同步器，客户端关闭不停止后台循环，daemon 重启后需至少一次客户端连接重新引导。在途同步在分页、归档、移除 Project 与任务核对边界检查规则版本，遇到新规则让出并按最新规则重跑。

只有完整成功的分页快照才用于判定筛选退出或评论删除；WebSocket 事件仅用于使快照失效。每轮同步按工作区复用 `agents` / `members` 目录请求；讨论标签到 `metadata` 的存量扫描在进程内成功一次后停止（失败则在后续 bootstrap 重试，新导入与恢复单独写入）。任务描述通过有界 `revision` / `offset` 切片读取并由 provider 订阅原位更新同一条目，版本变化拒绝跨快照拼接。

`history:skip` 恢复时通过 `fetchAgentTimeline` 完整分页读回原生时间线，逐条核对来源 `messageId` / 本人 `clientMessageId`、角色及全文后再补发缺失原文；遇到分页缺口、epoch 变化或冲突时保留缓存并报告失败，不盲目重放造成重复消息（[ADR 0005](./adr/0005-preserve-native-comment-history.md)）。设置页在同步进行中每 2 秒轮询进度（空闲恢复 10 秒），归档进度仅统计仍有待归档任务的已停用工作区。

## 设置页数据重建

仅当当前连接 `ready` 且无未完成的 profile 清理（`purgePending === false`）时允许发起重建；无已启用规则时仍可执行清理并以 `0/0` 完成。预检仅针对当前连接本地缓存中的五类活跃 Run（含人工隐藏、筛选退出或规则停用归档任务），按 Issue 分组串行读取一次 `/api/issues/:id/task-runs?view=timeline` 复核。优先使用本地 Paseo 项目记录中的 Multica 工作区 slug；缺失时本轮惰性读取一次 `/api/workspaces` 查找。所有请求沿用当前连接与身份校验，不全量扫描远端 Run。

每个候选 Run 按远端结果处理：

- **已终态**：仅将仍活跃的本地候选 Run 写为终态，只更新 `status`、`completedAt` 与合并后的 `metadata`（缺省字段保留，显式 null/空值覆盖），通知已打开的讨论并移出阻塞；不改变展示归属、不发现新 Run，也不拉取 agents/members。
- **仍活跃**：继续阻止重建并展示远端最新状态，不允许强行继续。
- **确定无法确认**：Issue 返回 404、Run 快照接口因无权访问 Multica 工作区返回 403、Multica 工作区不在 `/api/workspaces` 列表中或远端快照没有该 Run 时，附原因继续阻止；仅当全部剩余阻塞项均属此类时，用户才可确认「仍然重建」。
- **暂时失败**：工作区列表读取失败（含 403）、超时、网络错误、5xx 或快照 schema 校验失败时，附原因继续阻止，只能「重新复核」，不可强行继续。复核中连接身份变化则整个预检或重建失败。

确认弹窗列出各 Run 的复核结果与原因，并可「重新复核」。无阻塞或全部阻塞均确定无法确认时，显示待删除的 Paseo 项目数（排除含用户自建活跃工作区的项目）、待归档活跃 Paseo 工作区数与待彻底删除的插件讨论数（含已归档），明示保留筛选规则与启用状态、清除人工隐藏与其余缓存。强行继续还须说明无法确认远端状态，重建不会取消远端 Run；确认后提交这些 Run 的 `acknowledgedRunIds`（默认空数组）。

预检、`start()` 首次检查以及进入 `SidebarSynchronizer.exclusive` 后均执行相同的针对性复核。两次启动检查都要求剩余阻塞项全部为确定无法确认且其 Run ID 全部已确认，才允许继续。首次检查未通过时返回 `started: false` 与最新阻塞项；通过后立即返回 `started: true`，进度显示「等待后台同步」。等待期间新出现的阻塞项不会被既有确认放行：`exclusive` 内复核未通过则在执行任何删除前使进度变为 `failed`，错误信息列出剩余任务标题、讨论、Run ID 与复核结果，并提示重新打开重建以重新复核。

确认后通过 `SidebarSynchronizer.exclusive` 串行暂停后台同步与规则写入，暂停执行明细补读并关闭当前连接本地投影，严格按公开 SDK 顺序执行：

1. `deleteAgent` 彻底删除当前连接全部插件讨论（含已归档）；
2. `archiveWorkspace` 归档活跃目录中属于当前连接的插件工作区（按已知 ID 或当前连接占位目录识别，含已无讨论的工作区；已归档工作区不重复归档）；
3. 再次完整分页核对后，`removeProject` 移除不含用户自建活跃工作区的插件项目；
4. 保留顶层 `state.owner` 与该连接 `rules`，递增持久化 `rebuildGeneration`（缺省 `0`），清空该连接其余状态并按保留规则重导（新任务的 `workspaceId` 与创建幂等键持续混入 `rebuildGeneration`，避免与宿主残留的旧空归档工作区冲突；讨论分配全新 `agentId` 与干净时间线，Run 展示归属按远端快照重新判定）。

全程不调用 `archiveAgent` 或 `session.interrupt`，不取消远端 Run，不改动其他连接。进度仅保存在当前 daemon 进程内存（分「删除」与「导入 x/N」两阶段，中途无取消按钮，离开页面后台继续，失败或重启后再次发起从头执行），详见 [ADR 0012](./adr/0012-data-rebuild.md)。

## 客户端入口与工程验证

客户端仅注册四类公开扩展点：设置页 `multica`、侧边栏顶部快捷入口 `multica`（点击直接打开设置页）、`0.16.0+` 输入框 `multica-mention` 选择器，以及 6 个时间线 renderer（`task-description`、`thread`、`comment-divider`、`comment-event`、`askuser`、`comment-delivery`）。manifest 声明 `requirements.paseo = ">=0.15.3"`。

自动化测试通过临时 CLI 配置、可控时钟、隔离 HTTP/WebSocket 与编译后 bundle，在公开贡献、provider、RPC 与 renderer 边界验证行为；静态源码核查与隔离测试不替代真实 Paseo 宿主和真实 Multica 服务的端到端验收。

## 明确不提供的保证（边界约定）

- **评论投递与草稿恢复**：不持久化待发送评论原文、不查询 7 天幂等回执、不提供「待核实」状态或显式风险重发入口。单次发送仅在当次进程内以相同 `Idempotency-Key` 最多尝试 3 次；失败后不跨重启恢复草稿，不能由请求失败推断远端一定未保存，用户手动重发可能产生重复评论或执行。
- **停止与物理进程清理**：不持久化停止失败记录、不追踪远端进程清理四态、不提供跨 tab 单 Run 重试面板，也不设置拦截在途评论/回答的 Stop epoch 栅栏；HTTP 取消成功不证明远端进程已物理退出，点击 Stop 前已发出的输入不会自动撤回。
- **历史快照与失权区分**：不提供独立管理页、历史连接列表、复制提及引用兜底或独立只读快照浏览器；任务从完整筛选列表消失时不额外发起失权二次取证，统一按 `filter_exit` 本地归档并依赖宿主原生归档历史与已有缓存阅读，写入遇到 `403`/`404` 直接透传远端错误。
