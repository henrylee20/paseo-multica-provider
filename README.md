# paseo-multica-provider

在 Paseo 中处理 Multica 任务：Multica 工作区对应 Paseo 项目（project），Issue 对应 Paseo 工作区（workspace），Thread 对应 agent tab。每项任务另有本地主讨论，展示任务描述及首次无评论关联的 Run；在主讨论发送会建立新的远端 Thread。

插件已实现规格 [#1](https://github.com/henrylee20/paseo-multica-provider/issues/1) 的 CLI 登录复用、动态筛选、评论历史、Run 展开、发送与停止、隐藏及故障恢复，并加入 [#20](https://github.com/henrylee20/paseo-multica-provider/issues/20) 的结构化提问表单与时间线卡片。它直接使用 daemon 主机现有的 Multica CLI 登录，支持云服务和自部署地址，无需新建插件 Token。真实验收的覆盖范围与尚未验证的项目见 [交付验收记录](docs/acceptance.md)；askuser 本轮仅完成模拟验证，真实自部署与原生界面验收由用户按 [手动清单](docs/askuser-acceptance.md) 执行，原生 queue 控件仍待验证。

## 构建与安装

宿主要求为 **Paseo >=0.15.3**，不设最高版本。输入框的提及选择器需要 **Paseo 0.16.0 及以上**；更早宿主不显示选择器，仍在管理页复制引用。开发 SDK 固定为 **0.15.4**；已取得实际 daemon 0.15.3、0.17.4 的运行证据。构建需要 Node.js、npm 和 `tar`，安装时 daemon 主机需能下载锁定的 npm 依赖。

从仓库构建：

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

生成 `dist/paseo-multica-provider-0.1.0/`、同名 `.tar.gz` 和 `.tar.gz.sha256`。这是 Paseo 所需的**源码插件产物**，包含两个入口、manifest、锁文件及文档；Paseo 在加载时编译客户端和服务端贡献，不需要修改 Paseo 核心。`node_modules`、Git 数据和本地状态不进入产物。不要用 `npm pack` 代替此步骤：它默认排除 manifest 的 `npm ci` 所需的 `package-lock.json`。

将压缩包与校验文件放到 **Paseo daemon 所在主机、其运行用户可读的固定目录**，例如 `/srv/paseo-plugins`，然后执行（路径按实际部署修改）：

```sh
cd /srv/paseo-plugins
sha256sum -c paseo-multica-provider-0.1.0.tar.gz.sha256
tar -xzf paseo-multica-provider-0.1.0.tar.gz
cd paseo-multica-provider-0.1.0
npm ci --omit=dev --ignore-scripts
paseo plugin install /srv/paseo-plugins/paseo-multica-provider-0.1.0
```

本地目录安装会引用该目录，**保留目录及其依赖**。本地安装不会自动执行 manifest 的依赖安装命令；上面的 `npm ci` 必须先完成。Paseo 的托管 Git 来源安装才执行 manifest `build`。若 daemon 使用自定义 home，在 Paseo 命令末尾加 `--home /absolute/daemon/home`，确保操作正确实例。插件 ID 为 `multica`；可用 `paseo plugin list --json` 查看加载状态。更新既有安装时，在已配置的固定目录更新源码、重新运行生产依赖安装，再执行 `paseo plugin reload multica`，不要重复安装相同 ID。目录若是开发工作区，先保留其本地改动与未跟踪文件。reload 会替换 provider 并释放已加载的讨论资源；请在没有相关运行、投递或待核实操作时更新，并保留原 daemon home 的插件状态和占位目录。

## 复用 CLI 登录

在 daemon 主机用同一运行用户完成 CLI 登录。CLI 0.6.3 的自部署示例：

```sh
multica setup self-host --server-url https://api.example.com --app-url https://app.example.com
```

已有配置只需 `multica login`。命名 profile 使用 `multica --profile work setup self-host --server-url https://api.example.com --app-url https://app.example.com` 或 `multica --profile work login`。示例地址需要替换为自己的服务；插件不修改 CLI 配置，也不自动开始登录。

打开 Paseo 侧栏 **Multica** 进入管理页，或打开设置中的 **Multica**。设置页只含 **Multica 连接** 与 **Multica 工作区与筛选规则**，其余记录点 **打开管理页** 处理；管理页中的评论投递、停止结果、人工隐藏、只读历史和历史连接只在有记录时显示。Profile 留空使用 `~/.multica/config.json`；填写 `work` 使用 `~/.multica/profiles/work/config.json`，然后点击 **保存 profile**。不会根据目录修改时间猜测 profile。**Multica 连接** 显示状态、daemon 主机、已验证用户、API 地址、前端地址、配置来源和同步状态；先确认服务与身份，再启用规则。未登录或登录失效时，同一卡片给出登录命令和 **复制命令**。

登录范围是 **daemon 主机及其运行用户**。另一个设备上的 Paseo 客户端、另一用户的 CLI 或浏览器登录不会自动共享。API 的 `server_url` 与页面的 `app_url` 分别使用，保留自部署端口；没有硬编码云地址兜底。

沿用 daemon 进程已有的 `MULTICA_SERVER_URL`、`MULTICA_TOKEN`、`MULTICA_APP_URL`／`FRONTEND_ORIGIN` 覆盖，勿把凭据填入插件设置。修改启动环境后需按部署方式重启 daemon；CLI 文件的原子替换、重新登录和登出则会重新读取。`MULTICA_TASK_CONFIG_ROOT` 指定任务私有根目录；任务 ID、daemon 端口环境或目录标记触发隔离时，缺少必要注入便拒绝借用拥有者登录。有效凭据移除后不沿用旧缓存。

同服务同账号换 Token 或切换到指向同身份的 profile 会续用原映射；更换服务或账号建立独立连接，从空规则开始。旧历史、原作者角色、人工隐藏、待核实投递和停止告警保留在原连接。管理页 **历史连接** 可查看这些身份；通过 CLI 和 profile 切回后继续使用原映射。

## 筛选与本地目录

初始没有启用规则，**不导入任何任务**。在 **Multica 工作区与筛选规则** 打开目标 Multica 工作区的开关；默认只匹配“未开始”和“进行中”状态类别，其他条件不限。点击 **配置筛选条件** 选择成员／agent／squad 负责人、Multica 项目与标签，状态在“按状态类别”与“按具体状态”中二选一。字段间 AND，同字段多值 OR，多个标签命中任一即可；直接分配成员与分配其 agent/squad 是不同条件。

匹配任务动态进入原生项目树；退出筛选自动归档，重新匹配恢复原 ID 与历史。停用工作区规则还会移除已无活跃工作区的插件 Project；若其中有用户自建的活跃工作区，则保留 Project。重新启用时可重建 Project 和任务的本地 Paseo 工作区外壳，Multica 任务、原讨论 ID、占位目录、评论与执行历史保持，人工隐藏继续有效。停用规则和归档整个 Paseo 工作区不取消远端 Run。关闭 tab 或手动归档 Paseo 工作区会持久人工隐藏，自动同步不会重新打开；在管理页 **人工隐藏** 分别恢复 Paseo 工作区或指定讨论。

每项任务有独立非 Git 占位目录；它**不是远端代码仓库**。原生文件和终端功能指向占位目录，Multica 执行仍在远端。状态和目录位于拥有者 daemon 的 `PASEO_HOME/multica-provider`，按服务／用户与稳定远端 ID 隔离。目录在归档后保留；删除本地状态会失去原映射、隐藏意愿、原始输入和故障回执，不能当作日常恢复手段。

## 讨论、执行与停止

本人普通评论显示为原生 user，其他成员及 agent 为带作者名称的 assistant；assistant 表示呈现角色。系统变化、已观察到的编辑和删除追加独立事件，不覆盖原始消息。首次导入只代表源端当前可获取的快照。历史与长正文按需分页，保留文本、Markdown 和已有附件链接；上传、编辑、删除评论及 Issue 状态修改仍在 Multica 完成。

在主讨论发送创建新 Thread，在真实 Thread 发送回复根评论。Paseo 0.16.0 及以上的讨论输入框提供 **提及 Agent** 选择器：搜索当前 Multica 工作区的 agent，选择后把带 ID 的完整引用插入光标处，随评论一起发送。Paseo 0.15 宿主没有该选择器，仍在管理页 **提及 Agent** 选择任务后 **复制引用** 并粘贴。引用不能用同名裸 `@名字` 代替身份；宿主输入框的 `@` 候选是 Paseo 内置的工作区文件引用，插件不能替换为 agent。投递区分 **插件已接收**、**评论已保存**、**Run 状态**；评论保存可能没有执行。主讨论已保存投递可用 **继续此 Thread** 进入对应 tab。

每个 Run 只有一个持久展示归属，后补关联和重连不迁移、不复制。一个 tab 的多个未结束 Run 聚合为原生活动；展开执行段读取任务错误、失败原因、来源原样的远端执行路径，以及日志和工具信息。远端路径明确标为 REMOTE，与 Paseo 本地占位目录分开呈现；执行消息为空或不可用时仍显示已有任务元数据，未提供的调用 ID、缺口、完整性与截断状态明确呈现。最终 agent 评论仍走普通评论通道，不把执行日志重复成回复。

普通运行中发送仅发表普通评论，由 Multica 排队或合并，不强制远端 steering。显式 **interrupt** 先由宿主停止，再接收新输入；停止未确认时不会继续替换。显式 **queue** 的输入先由 Paseo 客户端保留，全部归属 Run 结束后才释放给插件；它与远端 queued Run 不同。队列“立即发送”遵循当前 composer 模式，可能先中断。实际原生 queue 控件及视觉体验尚未验收。

原生 **Stop** 和关闭运行中 tab，只取消操作开始时归属此 tab 的全部未结束 Run；不扩大到后来 Run 或其他 tab。跨 Thread 的同一 Run 整体取消。取消与完成竞态保留服务器实际终态；HTTP 成功不等于进程已退出。部分失败会使原生停止失败，在管理页 **停止结果** 查看逐 Run 告警及 **重试此 Run**，关闭 tab 后仍保留；重试不会恢复隐藏讨论。

## 结构化提问卡片

普通评论（含子回复）中的 `askuser.json`（`version: "1"`、附件类型 `application/json`）会在所属 Thread 显示稳定的时间线卡片，保留标题、完整警示说明、题目与选项。当前连接用户可答且卡片未决时，插件提供 Paseo 原生 `QuestionFormCard`；后台同步也会主动加载符合条件的未打开讨论，使宿主根据待决问题显示 `needs_input`，人工隐藏和归档仍优先。卡片支持文本、单选、多选、自定义选项及条件必填校验；提交会生成 Multica 网页格式的 `**确认结果**` 评论，子回复卡片的回答直接指向卡片评论。投递复用 7 天幂等核实与待核实保护；**评论已保存**不等于 Run 已开始，结果未知时从管理页核实原投递。

原生 **Dismiss** 仅本地收起，随后可在时间线点 **重新展开作答**；远端跳过使用独立的 **跳过此卡 → 确认远端跳过** 两步操作。全选填文本表单额外显示一题 **提交确认**：选中「确认提交以上非空回答」后再提交，确认题不进入远端回答正文；即使已填写文字并选中确认，Dismiss 仍仅本地收起。缺少确认的模糊 allow 或原题全空的回答也仅本地收起；含必填题或选项题的表单不增加确认题。每题携带「仅本地收起（不跳过）」按钮文案。条件校验失败会保留表单，宿主显示通用错误，详细条件提示见题目与时间线。首次发现的新卡片在原生加载完成后走 live 权限路径，重启缓存仍静默回放；通知正文包含可读标题和说明，实际系统通知仍待手动验收，详见 [主动加载与通知边界](docs/askuser-wakeup.md)。

已答、已跳过、非指定用户、离线或失权卡片保留只读信息；跳过时间和操作者仅在远端提供时显示。内容较长时点 **读取完整提问** 阅读全部详情。Stop 会清理本地待决表单并阻止尚未发出的旧回答／跳过，不会远端跳过卡片；普通聊天保持普通评论语义。本功能尚未安装或 reload 到用户 daemon，真实原生表单、通知及远端跳过协议仍待 [#26 手动验收](docs/askuser-acceptance.md)。

附件按连接、Issue 和附件 ID 持久缓存，后台同步与打开 Thread 共用下载；只允许当前 API 同源地址，拒绝重定向和超过 64 KiB 的正文。下载或严格 schema 校验失败会显示原因及原评论／附件引用，普通评论继续同步。仅有未确认终态卡片的 Issue 才额外读取一次完整 `timeline`，同时核对直接回复与跳过状态，避免摘要正文截断造成误判。已确认终态继续使用缓存；删除、失权、离线及换账号后的已读卡片可在 **只读历史** 阅读。

## 同步与问题处理

客户端贡献加载后立即引导同步，失败每 10 秒重试；daemon 建立唯一后台循环，每 15 秒核对。管理页无需先打开，多客户端不会重复建 worker；关闭客户端后已启动的 daemon 继续同步。daemon／插件进程重启后需要**至少一次客户端连接**重新引导，不承诺没有客户端时无人值守自启。管理页和讨论中显示同步阶段、最后完成时间（本地时间）及缓存提示；WebSocket 重连还需分页快照核对。

| 状态／入口 | 处理方式 |
| --- | --- |
| CLI 配置缺失、损坏、不可读、未登录或已失效 | 在显示的 daemon 主机，以同一用户修复 CLI／重新登录，点击刷新；命名 profile 按显示命令登录。 |
| 任务上下文受隔离 | 检查 daemon 的任务环境和私有配置注入，不复制拥有者凭据绕过隔离。 |
| 无法连接／同步未完成 | 检查原 API、权限和网络，保留缓存，等待恢复核对；连接故障不会当成批量删除。 |
| Paseo 更新后插件 worker 协议不匹配 | 核对运行中的 daemon 与安装文件版本；按正常部署方式重启目标 daemon，使进程与应用文件一致，再检查插件状态。 |
| 评论投递失败／待核实 | 在 **评论投递** 读取原输入，先点 **核实原投递**；此动作只查询原回执。 |
| 核实后仍未知 | 在原服务确认。仅在接受可能重复评论及执行的风险后点 **重新发送… → 确认另发一次**；它建立独立新请求并保留旧记录。 |
| 取消失败或进程清理未知 | 在 **停止结果** 逐项核对任务终态与清理证据，必要时恢复原连接后重试；不把 HTTP 200 当作物理终止。 |
| Issue 已确认不存在或失权 | 原 Paseo 工作区自动归档，阻止新写入和远端明细／取消重试；在 **只读历史 → 读取缓存历史** 阅读已缓存描述、评论、执行、原输入和停止记录。 |

响应丢失先查原回执。只有当前服务已有可核实的正面去重证据、原始时间在 7 天内且原 Stop 栅栏未变时，才允许沿用同 key、同正文和目标自动重试一次。能力不支持、回执冲突、超期或仍未知会停止自动恢复并保留待核实；查无回执不证明评论从未发表。停止后的旧输入不会自动重发。真实目标服务能力必须分别验证，见验收记录。

只读缓存跨离线、登出、换账号和正常重启保留。单个对象的 403／404 需结合有效连接与 Multica 工作区证据分类，不凭失败列表猜删除。恢复访问还需直接对象可读且重新匹配筛选才恢复原身份，人工隐藏仍优先。

## 文档与开发依据

- [交付验收记录](docs/acceptance.md)：版本、实际结果、自动化范围和未验证项。
- [askuser 验收与手动清单](docs/askuser-acceptance.md)、[主动加载与通知边界](docs/askuser-wakeup.md)。
- [GitHub 规格正文](docs/github-spec.md)、[首版规格](docs/spec.md)、[实现计划](docs/implementation-plan.md)。
- [术语表](GLOSSARY.md)、[设计与原始证据](docs/design.md)、[实现上下文](CONTEXT.md)。
- [架构决定](docs/adr)：[Thread](docs/adr/0001-thread-as-paseo-session.md)、[目录](docs/adr/0002-use-existing-paseo-with-placeholder-directories.md)、[Run 归属](docs/adr/0003-unique-run-display-ownership.md)、[Stop](docs/adr/0004-native-interrupt-stops-remote-run.md)、[历史](docs/adr/0005-preserve-native-comment-history.md)、[身份](docs/adr/0006-isolate-connection-identities.md)、[幂等恢复](docs/adr/0007-retry-comments-only-with-deduplication.md)、[CLI 登录](docs/adr/0008-reuse-multica-cli-authentication.md)、[提及选择器](docs/adr/0009-composer-mention-picker.md)。

CLI 兼容依据为 Multica CLI 0.6.3 固定提交 [`18fa9f7`](https://github.com/multica-ai/multica/tree/18fa9f728a9e25f2465df2789631edb2a75442ad)。开发检查使用真实锁定 SDK、临时 CLI 配置、隔离 HTTP/WebSocket 和公开贡献／provider／RPC 边界；这些测试覆盖故障与竞态，但不能代替真实宿主或真实服务验收。构建后 `dist` 中的副本不进入类型检查或测试发现。
