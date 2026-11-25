# Paseo–Multica 当前规格

本规格以已发布 [Issue #1](https://github.com/henrylee20/paseo-multica-provider/issues/1) 为起点，纳入 2026-11-25 精简决定；取消条款见文末。固定接口证据见 [设计依据](./design.md)，术语见 [GLOSSARY](../GLOSSARY.md)，安装见 [README](../README.md)，历史运行证据见 [验收记录](./acceptance.md)。

## 接入与对象映射

插件由远端 provider、daemon 侧同步器和客户端贡献组成，不修改 Paseo 核心，不在本机运行 Multica 任务。占位目录满足原生交互约束，不代表远端代码仓库；原生文件和终端功能可能指向它们。

| Multica 对象 | Paseo 表达 |
| --- | --- |
| Multica 工作区 | Paseo 项目 |
| Issue | Paseo 工作区 |
| 以顶层评论为根及其后代组成的 Thread | agent tab |
| 连接用户本人的普通评论 | 原生 user message |
| 其他成员或 agent 的普通评论 | 带作者名称的原生 assistant message |
| 一次 Run | 唯一归属讨论下的只读 provider subagent |
| 系统变化、评论更正与删除 | 独立事件 |

每个 Issue 另有本地主讨论，展示描述、Issue 级系统事件与首次完全无评论关联的 Run。主讨论本身不是远端 Thread，在这里发送会创建新的顶层评论及 Thread；真实 Thread 内发送回复其根评论。

## CLI 登录与身份隔离

默认复用 daemon 主机、运行用户的 Multica CLI 登录，支持云服务及自部署地址。插件只读配置，不生成 PAT、不改写 CLI、不借用客户端或其他用户的登录。API server_url 与前端 app_url 分开使用，不硬编码云地址。

Profile 通过设置页下拉框在 daemon 主机已登录的 CLI profile 间选择（留空表示默认配置，枚举 `<配置根>/config.json` 与 `profiles/*/config.json`，跳过不符合设置 schema 的目录名；当前已选项即使已登出仍保留在选项中）；不猜测全局 active profile，也不向 RPC 返回凭据或使用未选中 profile 的凭据访问 `/api/me`。遵循 MULTICA_SERVER_URL、MULTICA_TOKEN、MULTICA_APP_URL／FRONTEND_ORIGIN 及任务私有配置根的有效覆盖，环境变量覆盖时提示切换 profile 不改变账号；任务隔离上下文禁用下拉框且不读取拥有者配置目录。

服务地址和真实用户 ID 组成连接身份；同一 profile 下同账号 Token 轮换续用映射，同一 profile 下经 CLI 换服务／用户从独立空规则开始且不自动删除旧连接，历史角色、Run owner 和人工隐藏保留原身份，旧连接不能借新登录发表评论、取消 Run 或刷新远端明细。凭据不进入插件持久状态、客户端或 RPC。

切换 CLI profile 时，客户端先弹窗展示本机 Project、任务、讨论数量并提示不影响远端，确认后再保存设置。服务端以持久归属 `state.owner.profile` 驱动可重复执行的清理（见 ADR 0010）：清空前一 profile 留下的全部本地映射、规则、缓存、人工隐藏、原生讨论（`deleteAgent`，不取消远端 Run）、不含用户自建活跃工作区的插件 Project 与占位目录，再允许新 profile 的同步、导入或规则写入；两个 profile 指向同一账号时同样清理，同一 profile 下累积的多个连接一并清空；含用户自建活跃工作区的 Project 保留 Project 与占位目录，只删插件讨论、归档插件工作区并提示用户。旧版本缺少归属时采用当前 profile，升级不删数据；清理失败保留原归属并在下次引导重试。

CLI 文件原子替换、重新登录和登出会触发有效配置重读；凭据被移除后不继续使用。每次远端请求发送前核对原上下文，401／403 使身份验证缓存失效；已经发出的请求不能撤回。同一 profile 离线或登出时已读缓存仍可读；切换 profile 后前一 profile 的本地缓存已清空。

## 筛选、归档与人工隐藏

初始空规则不导入任务。按 Multica 工作区启用规则，筛选负责人（成员／agent／squad）、状态类别或具体状态、Multica 项目和标签；字段间 AND，同字段多值 OR，多标签命中任一即可，空选表示不限。直接分配成员与分配其 agent／squad 不等价。

`workspace.rule` 与 `workspace.enable` 按到达顺序完成连接／工作区校验及原子落盘后立即返回 `saved` 和独立的 `sync` 状态，后台同步或归档不占用保存 RPC；后台失败不回滚规则与开关。已知工作区停用可跳过远端工作区列表，启用及编辑规则仍校验远端工作区，落盘前再次核对登录上下文。

规则编辑器按类别分组，默认勾选未开始和进行中整类。整类保存类别并自动纳入新增状态；存在部分选择时，所有选择展开为具体状态保存。旧混合规则按类别与具体状态的交集载入。

| 变化 | 本地行为 |
| --- | --- |
| 首次匹配 | 创建稳定映射及原生层级 |
| 完整成功筛选列表中消失 | 按 filter_exit 归档，保留身份、目录与历史 |
| 重新匹配 | 恢复原先活跃的讨论，人工隐藏除外 |
| 停用规则 | 归档任务，完整核对后移除没有活跃子工作区的插件 Project |
| 重新启用被删 Project | 重建 Project／工作区外壳，以原 handle 迁回原讨论，保留 agent ID、cwd 和历史 |
| 用户关闭 tab 或归档 Paseo 工作区 | 记录人工隐藏，直到主动恢复 |
| 网络、列表不完整或连接鉴权失败 | 报告同步异常，不能推导批量筛选退出 |

Project 内有用户自建活跃工作区时不删除。自动归档保存原因和最初活跃讨论集，避免 hook 误记人工隐藏，丢失回执后继续依据原生状态重试。

人工隐藏在同一 daemon 的客户端间共享。设置页分别提供“恢复 Paseo 工作区”与“恢复讨论”：前者不解除子讨论隐藏，后者只解除选定讨论。宿主恢复可能唤醒隐藏子项，核对期间关闭这些本地投影、拒绝竞争打开并安全重新归档，不因此取消远端 Run。

## 评论、发送与回声

发送仅支持非空文本；附件、非文本内容、outputSchema 与缺少任务／Thread 映射在 prompt_result 之前拒绝。校验通过后立即 emit 带 clientMessageId 和正文的原生用户消息，网络发送异步执行；失败保留该原生输入，追加一个错误。

一次发送的连接、目标、正文和 Idempotency-Key 固定，网络错误或 5xx 最多尝试三次。插件不核实历史回执或持久保存失败输入，用户可确认远端结果后重新发送；不能据失败断言评论未保存。

成功只保存 clientMessageId → commentId／rootId 的回声关联，避免原生输入与同一远端评论重复。主讨论成功仅提示“新 Thread 已建立，可在侧边栏打开。”，不显示 ID 或跳转按钮；Thread 内成功不显示内容。评论已保存与 Run 已启动分别判断。

Paseo 0.16+ 的 composer 提供“提及 Agent”选择器，插入带 ID 的 canonical 引用；0.15 不显示选择器。裸 @名称不保证指定身份，宿主内置 @ 文件候选不由插件替换。普通发送遵循 Multica 路由与合并／排队规则，不强制远端 steering；steer 返回接收时捕获的宿主 turnId。显式 interrupt／queue 继续遵循宿主协议，插件不另建队列。

本人评论依连接用户 ID 与作者类型判断，自己拥有的 agent 仍是 assistant。原生消息保留首次可获取内容，编辑、删除追加事件，不原位改写，也不虚构未读取的旧版本；已有附件链接和 Markdown 保留，上传、编辑删除、新建 Issue 及修改状态仍在 Multica 完成。

## AskUser 结构化提问

所属 Thread 的 askuser.json version "1" 附件显示稳定卡片与可读的完整警示、问题和选项；下载仅允许当前 API 同源、禁止重定向、流式上限 64 KiB，并严格校验 schema。后台和显式打开共用缓存，完整 timeline 核对直接回答与远端跳过，不用摘要截断推断终态。

保留文本、单选、多选、other、条件必填、answer_user_id 与 require_answer 规则。可答未决卡片映射为原生问题；权限 ID 保持 multica:askuser:<cardCommentId>:<attachmentId>，按会话与原连接隔离。回答生成精确 **确认结果** 正文，parent_id 与 askuser_answer_to 均为卡片评论，展示和停止归属仍为原 Thread。

原生权限响应等待 send 的成功或失败，网络／5xx 使用相同 key 最多三次，回执同时校验两项目标；失败告知用户重新回答，不另存失败原文，不提供核实或显式重发。卡片 delivery 仅保留本进程的发送中、已保存、失败；成功答案及已答／已跳过状态继续缓存。保证 A／B／C 的取消同样适用于 AskUser，回答与跳过不再受 Stop epoch 栅栏限制，原生历史及完整卡片缓存继续可读。

Dismiss 只本地收起，显式重展恢复；全选填文本增加提交确认，模糊 allow 或全空原题仍只收起。远端跳过须独立二次确认；成功状态不依赖 JSON 正文，时间与操作者仅取远端元数据，202 无 timeline 证据不标终态。普通聊天不作为卡片回答，clearPendingPermissions 只本地收起。

后台保留每讨论去重与 60 秒限流，通过 listCommands 无中断加载合格讨论；人工隐藏、归档、hold、非指定用户、已解决卡片不被主动加载。首次新权限等待原生注册完成再 live 公布，已加载会话直接 live，旧缓存 ready 前回放；StateStore 成功更新订阅继续对齐本地权限，CLI 身份变化清理旧权限。真实原生通知、表单和自部署跳过协议仍由用户按 [AskUser 手动清单](./askuser-acceptance.md) 验收。

## Run、活动与原生停止

Run 首次展示归属依次采用明确触发评论、最早关联评论、确实零关联时的 main。触发、合并、已交付、补充与生成评论 provenance 均参与判断；缺父链或跨 Thread 缺可靠时间时等待，来源时间按 RFC3339Nano 比较。owner 首次确定后持久固定，后补关联或重连不迁移、不复制。

每个 Run ID 以 provider 子会话呈现，父讨论协商 `session.subsession`，子会话使用 `session.opened{parentSessionId, toolCallId, restoration: "parent"}`，不接受输入或独立 Stop／权限。标题为执行 agent 名称，描述为评论触发来源及创建时间，无评论关联时为“任务级执行”；重跑的新 ID 是新子代理。父时间线首次展示时保留一个静态 `sub_agent` 位置标记，状态始终 completed，子会话 toolCallId 指向它。恢复父会话重新发出子会话，history:skip 不重复已持久化的父标记。

一个 tab 的 queued、dispatched、running、waiting_local_directory、deferred Run 共同维持一个原生活动 turn，每次新周期生成新 UUID；子会话将这五类状态映射为 running，细分状态变化追加简短说明。completed／failed／cancelled 对应 completed／failed／canceled。子时间线仅承载该 Run 的运行文本、思考、工具调用与结果（保持来源顺序）、任务 error／failure_reason 及远端目录；触发评论、Run 生成评论和 AskUser 卡片仍在所属讨论。缺字段不补造，源端明确截断才提示。

讨论在宿主打开（含导入）时立即发出全部归属子会话和缓存，仅本进程实际打开过的讨论补读远端执行明细；活跃 Run 每两秒刷新，终态成功补齐一次后停止。父讨论 Stop 成功后相应子会话按实际终态结束，取消对应 canceled。纯关闭父资源只释放本地子会话，下次打开按缓存及真实状态重建。旧执行段行、renderer 与 `run.open`／`run.read`／`run.observe` 等 RPC 完全移除，不保留历史渲染兼容。

原生 Stop 和关闭运行中 tab 固定操作开始时归属该 root 的活跃 Run，逐项取消；不扩大到后来 Run、其他 tab 或已终结记录。跨 Thread Run 只能整体取消，完成竞态保留实际终态。全部成功后结束捕获的宿主 turn，仍活动的新 Run 使用新周期；部分失败返回 request.failed，用户再次点击 Stop。

整个 Paseo 工作区归档、筛选退出、客户端断开和单纯 session.close 只处理本地展示或资源，不取消远端。贡献清理等待已经接收的 Stop 完成。HTTP 成功不证明进程物理退出，插件不跟踪清理四态或保存停止重试记录。

## 同步、缓存与恢复

客户端加载后立即并始终每十秒 bootstrap，确保 contribution 跨 daemon 重连仍能重新引导。服务端就绪且最近同步未失败时只校验 serverId 并确保定时器存在；bootstrap 不等待整轮同步；规则变更落盘后立即显示同步中并触发后台核对。旧快照在分页、筛选退出归档、停用归档、项目移除及任务处理边界检查规则版本，保留在途原生写入回执后以最新规则重跑。daemon 每十五秒及工作区事件后读取快照，多客户端不重复创建同步器，客户端关闭后继续同步，进程重启仍需至少一次客户端连接。

完整成功分页快照才可决定筛选退出或评论删除；WebSocket 仅使快照失效，握手成功不代表缺口补齐。后台读取 Thread／Run 概要，Thread renderer 打开时读取评论正文，provider 讨论打开（含导入）时补读其 Run 明细；重启不自动下载尚未重新打开的讨论执行历史。每轮同步按工作区复用 agent／member 目录；metadata 首次成功补齐后只在导入和恢复时补写，初次失败在后续 bootstrap 重试。

描述更新由 provider 推送同一条目，Thread 挂载仍 thread.open，正常不显示说明，仅失败提供重新读取。设置页以 connection.status 聚合同步与人工隐藏，保存成功即更新列表、关闭弹窗并显示回执；后台失败仅在同步行报告。同步期间显示阶段与进度，每两秒轮询，空闲恢复十秒。归档阶段提供已完成／剩余数量，仅统计未归档的已停用任务，不计 Project 移除，仅在有待归档任务时显示；停用行仍有导入任务时提示后台归档或等待重试。讨论内没有同步状态轮询。

history:skip 恢复仍完整分页核对原生原文的来源 ID、角色和全文，再补缺失内容；宿主的普通消息 item ID 去重不跨 provider 会话保留，不能以缓存行代替宿主落盘回执。gap、epoch 变化、分页失败或冲突时保留缓存并报告失败。

描述采用有界 revision／offset 切片，版本变化拒绝拼接；Run 内容直接推送为有界原生子时间线条目，消息按任务与序号去重，增量游标不越过缺口。活跃时等待序号缺口补齐后再发后续消息；终态按可得源顺序呈现。评论事件仍由 thread.event 单次读取。缓存重放使用宿主鉴权，不借此授权远端写入。

## 设置页数据重建

仅当前连接 ready 时允许重建，非 ready 禁用按钮并解释原因；无启用规则仍可只清理并以 0 个任务完成导入。预检使用本地缓存检查 queued、dispatched、running、waiting_local_directory、deferred Run，返回阻塞的任务／讨论和 Run 列表，提示等待或先手动 Stop。无阻塞时用 `@getpaseo/plugin/client/ui` 的 Modal 二次确认，列出待删除项目数（排除含用户自建活跃工作区的项目）、插件工作区数与插件讨论数，明示保留筛选规则与启用状态、清除人工隐藏。

确认后 daemon 串行运行，等待在途同步让出并暂停后台同步与规则修改，按公开 SDK 严格执行：发现并 deleteAgent 当前连接全部插件讨论（含归档）→ archiveWorkspace 全部插件工作区 → removeProject 不含用户自建活跃工作区的插件项目（删除前重新完整分页核对）→ 清空该连接除 rules 外的全部状态 → 按保留规则重导。绝不调用 archiveAgent 或主动发送 session.interrupt，不取消远端 Run；其他连接不变。每项重导任务分配全新 workspaceId 和包含新 ID 的 idempotencyKey，讨论重新分配 agentId，防止旧归档工作区及创建凭据冲突。

进度只保存在 daemon 内存，通过独立 RPC 查询，包括删除／导入阶段、当前步骤、x/N 与成功或错误信息；逐任务更新导入进度。页面提供进度框，运行中无取消按钮，离开后继续，返回可查看进度或结果，完成后刷新设置状态并恢复后台同步。失败或进程重启后再次发起从头开始。旧空工作区留作宿主归档记录；Run 展示归属重新按远端快照判定。详见 ADR 0011。

## 设置与工程验证

唯一设置页包括连接（含 CLI profile 下拉框、切换确认弹窗与保留 Project 提示）、规则、数据重建和有隐藏项时的人工恢复。名称来自对应业务对象，但身份不依赖名称；后台导入新 Thread 不抢夺浏览位置。manifest 要求 Paseo >=0.15.3，不设最高版本，提及选择器需要 0.16+。Run provider subagent 的 0.15.x 应用显示未验证，无执行段后备，缺少 Subagents 显示的宿主将看不到 Run 内容。

测试通过临时 CLI、可控时钟、HTTP／WebSocket 与宿主契约，从公开贡献、provider、RPC 和 renderer 边界验证身份隔离、回声、Run 归属、按 root 停止、人工隐藏及恢复。静态源码核查与隔离测试不等同真实服务验收；真实自部署、原生 queue 等未验证范围以历史验收记录为准。

## 明确取消的首版保证

- **取消保证 A**：删除投递原文持久化、七天回执核实／安全恢复、待核实状态和风险确认重发入口；只保留有限次同 key 重试，失败输入不由插件跨重启恢复，用户重发可能重复评论或执行。
- **取消保证 B**：删除停止记录持久化、跨 tab 单 Run 重试、进程清理四态及 Stop epoch 投递栅栏；不保证 Stop 后旧在途输入不再触发执行。
- **取消保证 C**：删除独立只读历史快照与对象失权二次取证；筛选列表缺失统一归档，403／404 写入错误直接透传，已读内容留在原生归档历史和缓存。

独立管理页、历史连接展示及复制提及引用均已删除；状态类别与具体状态在同一编辑器中选择。原 ADR 的历史段落与验收记录中涉及这些机制的内容不作为当前功能承诺。
