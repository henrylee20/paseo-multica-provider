# Paseo–Multica 实现上下文

本文件描述 2026-11-25 精简后的当前实现。原 Issue [#1](https://github.com/henrylee20/paseo-multica-provider/issues/1) 的切片已完成；当前行为以 [规格](docs/spec.md) 及各 ADR 末尾修订为准，原始运行证据保存在 [历史验收记录](docs/acceptance.md)。安装见 [README](README.md)，术语见 [GLOSSARY](GLOSSARY.md)，固定接口证据见 [设计依据](docs/design.md)。

## 宿主与验证边界

manifest 仅声明 Paseo `>=0.15.3`，不设最高版本；开发 SDK 固定 `0.15.4`。原生验收先在实际 `0.15.3`，后在独立及用户主 `0.17.4` daemon 执行，证据分别记录。提及选择器使用 0.16 起的 composer item，0.15 不显示选择器；Run 改用 provider subagent，0.15.x 应用的 Subagents 显示未验证，没有执行段后备；manifest 下限保持不变。没有修改 Paseo 核心。

既有真实云服务验收仅使用授权 Issue HENR-2，包括 CLI 复用、筛选导入、主讨论新 Thread、有效提及和原生 Stop。真实自部署、命名 profile 轮换、原生 queue 控件及移动布局仍未完整验证；当前精简回归使用公开入口、临时 CLI、隔离 HTTP/WebSocket 和宿主契约，不能当成新一轮真实宿主验收。

## 保留的核心路径

- Multica 工作区 → Paseo 项目，Issue → Paseo 工作区，Thread → agent tab；主讨论展示描述、系统事件和首次完全无关联的 Run。
- daemon 只读复用 CLI 配置，保留环境覆盖和任务隔离；`profile.list` 按 CLI 0.6.3 目录布局枚举已登录 profile（不返回凭据、不访问 `/api/me`，任务隔离直接返回空列表）。凭据不写入插件状态或 RPC；服务地址和真实用户 ID 组成连接键，同一 profile 下同账号 Token 轮换续用映射，同一 profile 下经 CLI 换身份使用独立空规则且不自动删除。切换 CLI profile 时由持久归属 `state.owner.profile` 驱动可续跑清理（经 `settings.subscribe`、bootstrap、sync 和规则写入入口触发并门禁），依次释放会话与缓存、hold 并 `deleteAgent`（不取消远端 Run）、按用户自建工作区核对执行 `removeProject` 或仅归档插件工作区、校验路径后清理 `placeholders/` 并原子更新 `owner`，见 ADR 0010；旧版本缺少 `owner` 时采用当前 profile，升级不删数据。
- 每次远端请求发送前核对 profile 和有效服务／凭据。旧连接不能借新登录写入。CLI 文件按 mtime／大小缓存；同凭据 `/api/me` 结果最多缓存 60 秒，配置变化或 401／403 失效。
- 原生评论之间追加独立 comment-divider 细线，首尾不加线；正文及 hasNativeOriginal 精确比对保持，history:skip 已存评论不补线，乐观输入与回声共用输入分隔标记。原生评论保留初次读取内容；后续编辑、删除追加事件。成功评论只保存 clientMessageId → commentId／rootId 关联，用于同步回声去重；新 Thread 是独立原生会话。
- `session.prompt` 先校验文本、附件、空正文、outputSchema 与任务／Thread 映射，在 prompt_result 前直接 emit 原生输入。仅网络发送异步；steer 保留接收时捕获的 turnId，失败追加一个原生错误。
- Run 优先触发评论、再按真实来源时间选最早关联评论，缺父链或时间时等待，只有确实零关联才归 main；owner 首次固定后不迁移。五类关联及 RFC3339Nano 比较保留，见 ADR 0003。
- 原生 Stop 固定当前 root 的活跃 Run 集合并逐项取消；成功结束捕获的宿主 turn，新出现 Run 使用新周期，失败返回 request.failed。纯 session.close、整工作区归档与贡献清理不取消远端。

## Project 生命周期与隐藏

`main` 的 `f48de10` 是用户明确要求的行为：停用规则后移除没有活跃子工作区的插件 Project。移除前核对项目 ID、目录、非 Git 类型及完整活跃目录分页；有用户自建活跃工作区则保留。

重新注册 Project 会改变 ID；原工作区无法在父项目删除后直接恢复，旧 workspaceId 也不能用原创建凭据重建。因此保留 `project.removed`、旧父项目记录、新外壳 ID 与原 provider handle 导入迁移，保留 agent ID、cwd、评论及执行历史。隐藏讨论仅在明确恢复时迁移；宿主目录可能省略已删父项目下的 agent，不能据缺席判断历史丢失，需按原 agent ID 核对。

`archiveReason` 区分自动归档 hook 与人工隐藏，`ruleArchivedAgentIds` 保存最初活跃讨论集；两者继续支持丢失回执和原生状态漂移恢复。只删除未用于决策的 `archivePending`，旧字段由 Zod strip 忽略。旧原因值 inaccessible 仅为读取历史 state 保留。

Paseo 0.17.4 恢复工作区可能以 60 秒时间戳回退唤醒其他隐藏讨论。自动／手动恢复都先 `hold()` 关闭这些本地投影、拒绝竞争打开，等待已接收 Stop 完成，再核对空闲并重新归档；不借此取消远端 Run。分别恢复 Paseo 工作区与单个讨论，其他隐藏意愿保持，见 ADR 0002。

## 后台与按需读取

客户端 contribution 会跨宿主重连存活，因此始终每 10 秒 bootstrap；服务端就绪时短路，只核对 serverId 并启动定时器。daemon 每 15 秒及工作区事件后同步；客户端退出不终止同步，进程重启后仍需客户端引导。`sync.bootstrap` 只校验 daemon 并启动后台核对，立即返回。规则与开关通过独立的短队列按到达顺序校验和原子落盘，返回 `saved` 及独立同步状态；本地已知工作区停用不依赖远端工作区列表。规则版本在分页、归档、导入及讨论核对边界淘汰旧快照，已在途的原生写入保留回执后按最新规则重跑。

每轮同步按 Multica 工作区复用 agents／members promise；Thread 显式打开时使用该次请求的目录，不另设 TTL。metadata 存量扫描在进程内成功一次后停止，失败由后续 bootstrap 重试；导入和恢复单独补写。

Thread renderer 挂载仍调用 thread.open，正常不显示说明卡；主讨论也保留不可见的加载条目。仅本进程实际打开的 Thread 继续补读评论正文；描述由 provider 订阅推送。父 provider 协商 session.subsession，讨论打开（含导入、history:skip）立即重新发出全部归属 Run 子会话与缓存；RunDetails 只为本进程实际打开过的讨论补读远端执行消息，每两秒刷新活跃 Run；成功补齐终态后保存 finalized 并停止；补齐前不越过序号缺口。子会话立即按已知 Run 终态结束，不等待明细读取，离线、登出或读取失败不影响终态，后续明细仍可追加。profile 清理复用 reset 排空旧读取并清空打开集合，计时器供新 profile 继续使用。

RunProjection 将执行文本、工具输入／结果、错误及远端目录推送到只读子时间线；原始消息缓存去重并保持序号，活跃期及终态补读完成前，序号缺口后的消息等待补齐；finalized 后按可得源顺序呈现。空字符串与 null 元数据不生成条目。父讨论仅发出一次固定 completed 的 sub_agent 位置标记，子会话 toolCallId 指向它；markerProjected 持久标记已发出的位置标记，history:skip 只补发关闭期间新发现等尚未发出的标记。父关闭只清理本地投影，由宿主取消运行中的子代理，不发送会将其误标 completed 的子会话 session.closed。Run 细分活动状态变化追加说明，completed／failed／cancelled 对应子会话 completed／failed／canceled；聚合父 turn 和原生 Stop 边界保持。旧 multica:run:<runId> 行、renderer 及 run.open／run.read／run.observe RPC 均移除。描述保留 revision／offset 切片，评论事件仍单次读取。缓存重放不依赖 CLI 登录，远端补读仍核对原连接与 Run 归属。

恢复 history:skip 会话仍完整分页读回原生时间线，再按来源 messageId／自身 clientMessageId、角色及全文确认缺失原文。Paseo 0.17.4 的普通消息 item ID 去重仅在 provider 会话内存中，不能跨重启信任；失败、gap 或 epoch 改变时不盲目重放，见 ADR 0005。

StateStore 首次读取校验后缓存，只返回只读约定的共享快照；所有修改走 update，成功原子落盘后替换缓存，失败保留原状态。加载失败清空 promise，允许下次重试；不新增旧 state 迁移。

## 精简界面与取消的保证

只有设置页：连接（含 `SettingsSelect` profile 下拉框、切换确认 `Modal`、清理阶段提示与含用户自建工作区的保留 Project 区块）、Multica 工作区与筛选规则、数据重建、有隐藏项时的人工恢复。工作区按已启用优先分组，编辑与启用走带固定底栏的弹窗；默认选择未开始／进行中整类，编辑器保留整类与部分具体状态的选择，目录按连接缓存并由只读 `workspace.preview` 预览匹配与移出项（不写状态、不进同步队列），`workspace.list` 的 `importedCount` 与预览均按未归档映射计数。保存成功即关闭弹窗并显示非错误回执；后台错误独立显示在同步行，停用行显示待归档任务。设置页同步期间每 2 秒读取进度，空闲恢复 10 秒；只有仍有未归档的已停用任务时才显示归档阶段，归档数量不计 Project 移除。提及只走 composer 选择器。主讨论发送成功仅提示可在侧栏打开新 Thread；Thread 内成功不显示额外内容。

- **取消保证 A**：删除持久投递原文、核实／显式重发与 7 天保证。网络或 5xx 用相同 Idempotency-Key 最多三次，失败只追加错误；不由插件跨重启恢复失败输入。
- **取消保证 B**：删除停止记录、清理四态、跨 tab 单 Run 重试及 Stop epoch 栅栏；Stop 只处理当前活跃 Run。
- **取消保证 C**：删除独立只读快照和失权二次取证，完整列表缺失统一按 filter_exit 归档，写入 403／404 直接透传。原生历史与已读缓存保留。

## 设置页数据重建（ADR 0012）

DataRebuild 在 daemon 内保存当前连接的预检、作业进度和结果，不落盘进度或做断点恢复。仅 ready 且 purgePending 为 false 时可启动；保留 state.owner，profile 清理与重建共用串行宿主队列和清理门禁。本地缓存的五类活跃 Run 会阻塞，返回具体讨论和 Run。预检完整分页核对宿主插件讨论（含归档）、工作区和项目，不计含用户自建活跃工作区的保留项目。设置页以原生 Modal 二次确认，明确规则／启用状态保留、人工隐藏清除；进行中无取消，可离开页面后重新查看。

SidebarSynchronizer.exclusive 使在途同步在规则版本边界让出，串行暂停后台同步与规则写入。重建先暂停执行明细补读、关闭当前连接的本地讨论投影，依次 deleteAgent → archiveWorkspace → removeProject，最后保留该连接 rules、递增 rebuildGeneration 并按规则重导；不调用 archiveAgent 或 session.interrupt，不修改其他连接。项目删除前再次完整核对活跃工作区。从活跃目录按已知 ID 或当前连接占位目录发现工作区，无讨论的插件工作区也会清理；已归档工作区不计数、不再归档。重建代数缺省为 0；重建后每项新任务的 workspaceId 和创建键持续包含该代数，涵盖稍后启用、重新命中、普通同步和失败重试，避开宿主空归档工作区占用的旧凭据；provider handle 重用但 agent 记录和时间线全新。导入预取匹配总数，逐任务更新 x/N；0 启用规则只清理并以 0/0 完成。成功或失败后恢复同步，再次启动从发现原生对象开始。重建后 Run owner 会按新的完整远端快照重新固定。

本次仅使用隔离 HTTP、宿主 SDK 契约及编译后设置页交互测试，没有安装或 reload 真实 daemon；0.15.x Subagents UI 和真实数据重建仍需宿主验收。

## AskUser（#20–#27）

保留 main 的 askuser.json version "1" 安全下载与持久卡片缓存、完整 timeline 终态校验、原生问题映射、精确中文回答、本地收起／重展、两步跳过和受保护的主动加载。父评论与 askuser_answer_to 均指向卡片评论，rootId 仍为原 Thread／Run／Stop 归属；指定 answer_user_id、require_answer、卡片终态、隐藏、归档和 hold 检查保留。新卡片仍可出现在独立 Thread，不迁移已固定的 Run owner。

原生权限 ID 仍为 multica:askuser:<cardCommentId>:<attachmentId>，按 provider session、连接与 Issue 隔离。权限、订阅随 SessionContext 释放；DiscussionLifecycle.loaded 与 NativeHost.listCommands 继续用于无中断加载。StateStore 的成功更新在缓存替换后通知订阅，失败更新不通知；CLI 撤销与身份刷新继续清理原连接权限，同账号轮换不丢收起状态。

全选填文本表单继续增加非空「提交确认」，Dismiss、模糊 allow 或全空原题仅本地收起；条件必填和精确答案格式保持 main 行为。首次新权限在 listCommands 完成原生注册后才 live 公布，已加载会话新卡片直接 live，重启历史在 ready 前静默回放；首次发现标记仅在实际发出权限后清除，不持久化。宿主注意力和系统通知仍需真实验收。

回答改用 CommentDelivery.send 并等待成功／失败，parent_id 与 askuser_answer_to 回执均校验；发送中／保存／失败状态仅留本进程，成功答案保存在卡片，失败正文不另行持久化。核实／显式重发、receivedEpoch／Stop 栅栏及只读快照集成随 A／B／C 取消；纯 AskUser 可用性规则仍在 askuser-policy。原生卡片与缓存读取保留，远端 403／404 直接返回错误。

用户要求仅 Mock 测试，真实 daemon、原生表单、通知和目标自部署验收仍由用户执行；本次 rebase 也没有安装、reload 或访问真实服务。真实 skip HTTP 响应、timeline 的 askuser_skipped_at／askuser_skipped_by 及专用 WebSocket 事件尚未采样，不补造远端时间或操作者，202 仍需 timeline 终态证据。证据与手动步骤见 [AskUser 验收](docs/askuser-acceptance.md) 和 [唤醒契约](docs/askuser-wakeup.md)，历史 #1 实机记录不代表 AskUser 已验收。

## 开发与交付

每个 OPT 单独提交，提交前 npm run check，阶段结束 npm run build。构建输出源码插件目录、压缩包及校验文件；不打包依赖、Git 或运行状态，dist 不参加检查。历史验收数字仅属于其记录版本，不替代当前检查结果。
