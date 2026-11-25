# 交付与组合验收

记录日期：2026-11-25（Asia/Shanghai）。本记录区分真实 Multica 云服务、实际 Paseo daemon 配合隔离服务、公开边界自动化、以及尚未执行的验收。通过一层不代表其他层已通过。此前 #1 及后续修复的真实测试 Issue 为 [HENR-2](https://multica.ai/henrylee/issues/HENR-2)；这些历史证据不构成 #20 askuser 的真实验收。

## askuser（#20）：本轮模拟验证

用户明确要求“就Mock测试即可，之后的真实测试我手动执行。”因此 #21–#25 的功能只完成公开贡献／provider／RPC、隔离 HTTP／WebSocket／CLI／原生宿主替身和编译后客户端测试。本轮没有连接真实 daemon 或 Multica 服务，没有安装、reload、操作原生界面或执行真实写入。[askuser 验收记录与手动清单](askuser-acceptance.md) 列出最终检查、覆盖矩阵、宿主限制及待采集协议证据；[#26](https://github.com/henrylee20/paseo-multica-provider/issues/26) 的真实验收保持未完成。

manifest 仍为 `requirements.paseo = >=0.15.3`、没有最高版本，不修改 Paseo 核心。真实验收以用户当前 `0.17.4` daemon 和目标自部署测试 Issue 为准；本轮产物需要用户手动更新已安装源码后再部署验证。以下“交付版本与构建”及组合矩阵保留 #1 与后续修复的原证据、版本和测试数量；#20 的最新结果单列于上述清单，不将历史安装或云服务结果记作 askuser 通过。

## 交付版本与构建

- manifest：`requirements.paseo = >=0.15.3`，没有最高版本；不修改 Paseo 核心。输入框提及选择器需要 Paseo 0.16.0 及以上；0.15 宿主不显示选择器，管理页保留复制引用。
- 开发／插件依赖：`@getpaseo/plugin`、`client`、`protocol` 固定 `0.15.4`，由 `package-lock.json` 安装。
- 实际宿主：早期原生验收为 `0.15.3`；应用在任务中更新为 `0.17.4` 后，在独立 daemon 上继续验收。早期版本证据没有改记为新版本通过。2026-11-25 输入框提及选择器在用户主 daemon（`srv_k4Tm0x9H1FtO`，0.17.4，listener `127.0.0.1:6767`）上以本地目录安装重新加载；只 reload `multica` 插件，daemon 进程未重启（PID `4116328` 与 reload 前一致）。
- 真实服务：当前 `https://api.multica.ai` 云实例，复用 daemon 用户默认 CLI 登录；CLI 为 `0.6.3`，提交 `18fa9f728`。云后端精确构建版本未获取，能力按本次实际响应记录。
- 干净构建：在独立 worktree 中执行官方 npm registry 的 `npm ci --ignore-scripts`；`node_modules` 是独立目录，没有使用开发工作区的用户符号链接。类型检查和完整行为测试通过。
- 最终代码 `7474cbad` 的类型检查、149 项测试、构建和校验通过；规范与规格两路独立评审的全部发现已修复并定向复核，剩余发现为 0。
- 可安装产物：`npm run build` 生成源码目录、`.tar.gz` 与 SHA-256 文件，包含 manifest、锁文件、两端入口及源码、文档、开发检查配置；排除 `node_modules`、Git 元数据和运行状态。
- 从压缩包解出至另一独立目录，执行 manifest 的 `npm ci --omit=dev --ignore-scripts` 成功。用未修改的实际 `0.17.4` 宿主编译器源码编译两个入口，并用宿主共享 SDK `0.17.4` 加载贡献：provider／settings、管理页／侧栏、5 个 renderer 注册，客户端 bootstrap 发起一次。编译器的 esbuild／TypeScript 由私有 harness 提供；这项离线加载检查不称为新 daemon 安装或视觉验收。验证环境为 Node `26.13.1`、npm `12.2.3`。
- 随后把独立解压并安装生产依赖的产物，通过实际 CLI 安装至全新 `0.17.4` daemon home，专用 loopback `17687`。插件状态 `running`，官方 `0.15.4` SDK 读取到 79,494 字节客户端 bundle；合成任务环境仅指向没有配置的私有根目录，无 Token／服务覆盖，连接状态正确为 `missing_config`、凭据来源 `none`、历史连接及原生 agent 均为 0。没有读取拥有者 CLI。证明完成后立即停止该唯一 daemon，确认端口关闭、supervisor 退出；没有触及用户主 daemon 或其他验收实例。

Paseo 安装本地目录时引用该目录，**不执行 manifest build**；必须先安装生产依赖并保留目录。托管 Git 来源安装才执行 build。完整步骤见 [README](../README.md#构建与安装)。

## 组合验收矩阵

“实际宿主＋隔离服务”使用官方 SDK 操作真实 Paseo daemon 和原生记录，HTTP／WebSocket 数据及故障由 loopback fixture 控制；它不是一个真实自部署实例。“自动化”从公开贡献、provider、RPC 和 renderer 边界观察行为，不把内部 mock 或源代码阅读称为真实队列控件验收。

| 场景 | 真实云服务 HENR-2 | 实际宿主＋隔离服务／自动化 | 结论与边界 |
| --- | --- | --- | --- |
| 干净默认 CLI 登录，无新 Token，空规则 | 独立 0.17.4 daemon：复用现有默认登录，空规则 0 agent | 干净插件状态、临时 CLI 与多类配置错误有自动化覆盖 | 默认云登录通过；真实自部署及命名 profile 未执行。 |
| 独立 API／前端地址、环境覆盖、任务隔离 | 未改用户真实环境 | 临时文件／profile／任务标记／注入变量通过公开 HTTP 边界覆盖 | 不把 loopback 地址当真实部署证明。 |
| 显式筛选、原生层级、主讨论 | project-only 规则只导入 HENR-2；project／workspace／main、描述行与独立 cwd 存在 | 0.15.3 原生分页、组合条件、退出重返、同 ID 恢复及隐藏优先通过 | 真实云限定范围通过；全组合来自隔离测试。 |
| Thread 历史、原生角色、编辑／删除提示 | 新评论作为本人原生消息出现 | 0.15.3 原生 Thread／多作者／更正／删除／系统事件；长历史与分页完整性有自动化覆盖 | 未在云上执行编辑／删除或伪造旧版本。 |
| 主讨论新 Thread、回复与有效 mention | 普通主讨论保存 1 评论，新增独立 Thread、无 Run；该 Thread 的 canonical agent mention 回复保存 1 评论并产生 1 Run | 稳定根 parent、同名 ID、回显与竞态测试通过 | 两类真实路由结果通过；仅触及授权 Issue。 |
| 输入框提及选择器 | 现有 HENR-2 的 Thread：UI 选择器插入 canonical 引用，评论保存 1 条，mention 产生 1 Run（queued→running），原生 Stop 后服务端 cancelled、原生 idle | 真实 0.17.4 主 daemon 安装／reload、真实 SDK 类型检查、宿主编译器编译、0.17.4／0.15.3 双 SDK 加载与编译后客户端测试均通过 | 真实主 daemon＋真实云通过；选择器需要 Paseo 0.16.0+，0.15 回退复制引用；Run cleanup 记为 unknown，未证明进程物理退出。 |
| 评论与回显去重 | 原生主讨论原输入一次，新 Thread 的根一次；精确同 key 重发远端仍一条评论 | 响应丢失、重启 replay、原 client ID／角色／全文核对测试通过 | 新 Thread 是独立会话，不当作重复回显删除。 |
| 多 Run 唯一归属及聚合 turn | 真实单 Run 归属本 Thread，原生 running→idle | 0.15.3 多 Thread、交叉关联、无关联后补、并行／queued Run、后续周期 UUID 通过 | 云未制造多 Run；完整组合是实际宿主＋隔离服务证据。 |
| 按需执行明细、日志／工具、缺口与截断 | 真实 run.open 成功，Stop 前消息数组为空 | 0.15.3 实际原生 RPC 分页往返 >200k 字符、序号缺口补读、工具 call ID 与完整性标记通过 | 真实丰富日志与视觉展开未验证；不从空输出推断工具支持。 |
| 普通运行中发送与显式 interrupt | 真实普通评论和 mention 路由通过 | 实际 0.15.3 SDK 普通／interrupt、部分失败拒绝替换、Stop 集合与后续新 Run 竞态通过 | SDK 顺序证据不等于控件视觉验收。 |
| 原生 queue、立即发送、composer 控件 | 未执行 | 已固定源码契约并测试宿主发出的公开输入序列；插件不新增队列 | **原生客户端 queue／控件／视觉仍未验证**。浏览器 host 不可用。 |
| 原生 Stop 范围、取消／完成竞态、关闭 tab | 0.17.4 cancelAgent 约 954ms，唯一 Run 服务端 cancelled、原生 idle | 0.15.3 固定多 Run 集合、其他 tab／后来 Run 不取消、完成／失败终态、部分失败、关闭后单项重试通过 | 云 cleanup 为 UNKNOWN，不能声称进程物理退出。 |
| Paseo 工作区归档、人工隐藏与恢复 | 未对真实目标重复归档 | 0.15.3 整 Paseo 工作区活动时归档 0 cancel；0.17.4 手动恢复的时间戳回退、活动隐藏投影关闭、仅恢复选定讨论均通过，原 ID 与隐藏保留 | 自动归档与人工隐藏分别持久化；最终组合复测 0 远端 POST。 |
| 来源任务错误与远端执行路径 | 真实 Run 提前停止，未验证真实失败元数据 | 0.17.4 四个来源字段精确往返 43,549 字符 JSON、6 页；401 时缓存一致，原 run.read 仍为消息数组，摘要行有界 | 来源值完整保留；远端路径仅作显示，不成为本地 cwd 或链接。 |
| 实际服务幂等能力 | GET 回执 200＋Idempotent-Replayed:true；精确同 key／正文／目标 POST 200、同 comment ID，评论数 1，Run 集合不变 | 旧服务、不支持／冲突／超期、一次安全重试与停止栅栏有自动化覆盖 | 当前云实例正面去重通过；没有实测等待 7 天或真实自部署能力。 |
| 响应丢失与有界恢复 | 未对云注入断线 | 0.17.4：保存后丢响应 1 POST／1 effect；未保存后同 key 重试 2 POST／1 effect；两次均未保存后无第 3 POST；Stop 后 0 重试 | 这是实际 daemon＋隔离 HTTP，不是真实云故障注入。 |
| 同账号续用、切换身份与请求栅栏 | 未旋转真实凭据或切换账号／profile | 0.17.4 合成 A→B→A 保留旧身份、隐藏、投递／Stop 告警，跨身份拒绝写入，回切原 ID；文件轮换／登出／profile／在途撤销有自动化覆盖 | **真实 CLI Token 轮换、命名 profile／账号切换未执行**。 |
| 离线补读、daemon 重启与引导 | 独立 0.17.4 实例实际加载；真实浏览器连接未执行 | 实际 0.17.4 离线重启、5 个 canonical 原文身份和缓存描述／执行恢复通过；编译客户端验证无需打开管理页的 bootstrap 与重试 | 重启后仍需一次客户端连接；不声称无人连接自启或已看见实际 UI 自动连接。 |
| 对象失权只读、连接级失败不误删 | 未撤销云权限或删除目标 | 公开边界覆盖对象 403／404、网络／401／503、缓存历史、写入竞态和恢复；实际 0.17.4 在已合入的 `3f5b940` 验证重新归档修复，包含精确归档时间戳与全部可见讨论重开后的 60 秒回退 | 只读拒收、重新归档及原身份／恢复集合／人工隐藏保留通过；活动缓存隐藏 Run 的本地投影关闭并重新归档，远端 Run 不变且 0 cancel。真实云失权未执行。 |

## 原生发现的问题与修复

实际 0.15.3 验收曾发现恢复已活跃 workspace 被宿主拒绝、导入早期活动事件丢失／完成 turn ID 复用、Stop 等待期间新 Run 导致原生活动丢失、重启后已保存回复重复 replay。实现分别改为核对完整原生目录、挂载后观察并为新周期分配 UUID、结束原 Stop 聚合后用新 turn 展示后来 Run、共享原始消息身份核对。均保留公开行为回归；Stop 后来 Run 及重启恢复有再次实际宿主证据。未通过降低宿主支持范围掩盖问题。

实际 0.17.4 的只读拒收前解归档问题已在 `3f5b940` 完成所需修复范围的实际复验：单个及全部原可见讨论重开、宿主精确时间戳与 60 秒回退均重新归档，匹配筛选后保留原 ID、原恢复集合与人工隐藏。活动隐藏 Run 的已有本地聚合投影先完成并关闭，再读回无活动与归档结果；远端执行及 Stop 状态未变，未发送远端修改。保护结束后另一次显式原生 `fetchAgentTimeline` 可以重新打开已归档讨论的 provider 并产生新的缓存聚合；归档时间戳、隐藏意愿和远端 Run 均保持。这里不承诺任意显式原生查询之后持续没有本地活动；只读缓存应使用管理页 `issue.history`。

后续独立用例在实际 0.17.4 发现同一宿主回退也影响管理页的手动 Paseo 工作区恢复。本轮实现让手动与自动恢复共用关闭隐藏投影、等待已接收 Stop、确认无活动后重新归档的保护；只排除明确选定恢复的讨论，保留其他隐藏记录。最终 `7474cbad` 在实际 0.17.4 的全新组合用例通过：所有原可见讨论已重开、精确时间戳匹配数为 0，仍能在仅恢复 Paseo 工作区时关闭并重新归档活动隐藏投影；随后只恢复选定讨论，其他讨论的原生归档及持久隐藏保持，远端 Run 和 Stop 记录不变。全程 0 远端 POST。已接受 Stop 的等待竞态另有公开边界回归。

Run 任务元数据回归覆盖执行前失败、空／不可用执行消息、长错误与路径的有界分页、版本变化和离线重启。`error`、`failure_reason`、`work_dir`、`relative_work_dir` 原样缓存并在执行段及只读历史显示；远端路径标为 REMOTE，不作为本地目录或工具链接。最终实际 0.17.4 以 6 页精确读取 43,549 字符 JSON，每页不超过 8192 字符，原生摘要行 424 字节，消息接口保持 `[]`；401 时元数据及版本保持一致。这些是实际宿主配合隔离服务及编译 renderer 证据，不增加真实云丰富输出的验收主张。

应用从 0.15.3 更新到 0.17.4 时，旧 daemon 进程与新 plugin worker 文件混用曾造成协议拒绝；仅重启拥有的隔离 daemon 后恢复。用户原主 daemon 未被重启或 reload，本记录不声称最终源码已部署到用户原 daemon。遇到类似更新情况，先确认运行进程和安装文件版本，再按正常部署方式重启目标 daemon 使版本一致。

## 证据范围与复验

2026-11-25 合并后空 Project 清理补充：独立实际 0.17.4 daemon（监听 17697）与只允许 GET 的合成 Multica 服务（17698）完成完整插件流程。停用规则后已归档任务的空 Project 注册消失；daemon 重启后不重建，重新启用生成新的 Project／Paseo 工作区外壳，以原 cwd 和 provider handle 迁回全部 4 个讨论。原讨论 ID、评论内容、来源元数据、Run／停止／投递缓存保持，人工隐藏继续有效，选定恢复才解除。原生重放 envelope 时间可能重新生成或规范化，核对保留的历史内容、顺序、来源时间和原身份，不把重放时间当作远端评论时间。全程 0 次远端修改；实际云服务和用户主 daemon 未参与此项合成验收。原始删除／重建接口探针及完整插件证据位于 `/tmp/paseo-multica-project-rebuild-probe/{evidence,plugin-before-restart,plugin-acceptance-evidence}.json`。

该修复类型检查与 154 项测试通过，覆盖空规则、用户自建工作区及后续分页、不完整目录、删除／导入回执丢失、重启重试和两层人工隐藏。随后确认用户主 daemon 的规则全部停用、讨论均关闭，备份状态并仅 reload Multica 插件，原遗留 Project 消失，同步 ready；2 项任务的已有缓存及 3 个归档讨论按原 ID 读取核对保留。父项目删除后原生讨论目录会省略相关记录，includeArchived 也不能替代精确 ID 核对。此本机应用未重新启用真实规则、未重启整个 daemon、未恢复讨论或修改远端 Issue／Run；证据与备份位于 `/tmp/paseo-multica-main-project-lifecycle/`。本项是合并后修复的部署记录，与前文母任务未 reload 主 daemon 的历史验收范围分开。

自动化在仓库执行 `npm ci --ignore-scripts && npm run check`；构建执行 `npm run build`。从产物独立解压后执行 `npm ci --omit=dev --ignore-scripts`，再在目标 daemon 安装并检查插件状态。真实服务复验需先核对当前账号、工作区、精确 Issue 与唯一可用 agent，限定筛选后再产生评论；不要把已用过的故障注入脚本当作干净状态直接重跑。

私有临时证据位置仅作本次会话审计索引，不是发布包运行依赖，也没有提交完整响应、邮箱、凭据、运行状态或评论正文：

- `/tmp/paseo-multica-real-final-acceptance.md` 及 `/tmp/paseo-multica-live-acceptance/{import,plain-comment,replay-proof,run-stop}-evidence.json`：本次真实云结果。
- `/tmp/paseo-multica-runs-acceptance.md` 与 `/tmp/paseo-multica-runtime-egrktl_j/{runs-acceptance,stops-acceptance,interrupt-acceptance}-evidence.json`：早期 0.15.3 原生结果及其边界。
- 同目录 `stop-late-run-fixed-evidence.json`、`recovery-acceptance52-evidence.json` 与 `/tmp/paseo-multica-recovery-identity-acceptance.md`：修复复验、0.17.4 离线重启和有界恢复／身份隔离。
- `/tmp/paseo-multica-retired-reopen-acceptance.md` 与同运行目录 `retired-reopen-acceptance72-evidence.json`：`3f5b940` 的实际重新归档修复通过；`retired-reopen-post-timeline-observation.json` 单列保护结束后的显式原生查询观察。此前 `readonly-acceptance63-evidence.json` 的原失败证据保留。
- `/tmp/paseo-multica-manual-restore-edge.md` 与同运行目录 `manual-restore-edge74-evidence.json`：随后发现的实际手动恢复回退问题及原始失败证据；新增修复的实际复验另记。
- `/tmp/paseo-multica-delivery-load-evidence.json`：干净产物依赖安装后的实际宿主编译／贡献加载检查；此项没有使用 daemon。
- `/tmp/paseo-multica-delivery-runtime/install-evidence.json`：全新实际 `0.17.4` daemon 安装干净解压产物、catalog／隔离连接／零导入与精确停止清理的证据。
- `/tmp/paseo-multica-final-combined-acceptance.md` 及 `/tmp/paseo-multica-runtime-egrktl_j/final-combined-acceptance75-evidence.json`：最终 `7474cbad` 的元数据、离线缓存、手动恢复及活动隐藏保护组合实测，全部通过且 0 远端 POST。
- `/tmp/opencode/mention-picker/{host-load.mjs,typecheck-0174,host-load-result.txt,verification.json}`：本轮真实 0.17.4 SDK 声明类型检查、实际宿主编译器编译及 0.17.4／0.15.3 双 SDK 加载证据；不使用 daemon、不读写真实 Multica。
- `/tmp/opencode/mention-picker/live/{install-evidence.json,enable-evidence.json,mirror-settle.json,mention-evidence.json,ui-picker-list.png,ui-sent.png,ui-acceptance-evidence.json,final-state.json}`：主 daemon 真实 reload、client bundle hash、metadata 镜像、SDK 与 UI 两条 mention／Run／Stop 及隔离客户端截图；主 daemon 与主窗口未重启。

真实服务早先留下两条授权验收评论作为痕迹；本轮又留下两条（SDK 发送与 UI 选择器各一条），mention 产生的 Run 均已取消。未清除评论、重置 Issue 或扩展至其他任务。宿主原生 queue／视觉、真实自部署、真实 CLI 凭据轮换、丰富真实执行输出、真实对象失权和物理进程清理确认仍是明确的未验收边界。

2026-11-25 输入框提及选择器补充：宿主 `@` 候选只读工作区文件，插件没有 mention source，选择器因此使用 Paseo 0.16 的 composer item（ADR 0009）。验证使用 npm 发布的真实 0.17.4 `@getpaseo/plugin`、`client`、`protocol` 声明（61 个 `.d.ts`）检查新客户端与服务端代码，零错误；使用未修改的实际 0.17.4 宿主编译器（`compiler-build` 及支持源码私有 harness）编译客户端与服务端 bundle，并分别以真实 0.17.4、0.15.3 共享 SDK 加载（宿主 UI 模块以替身提供）：0.17.4 客户端注册 `multica-mention`，0.15.3 不注册，两者均注册设置、管理页、侧栏与 5 个 renderer，服务端 provider／settings 正常。编译后客户端 bundle 覆盖搜索、同名 ID 区分、大小写与空白过滤、失败重试、插入和隐藏条件；服务端 RPC 边界覆盖标签到 metadata 的镜像、分页与循环游标、旧宿主一次停用、失败重试和关闭等待；类型检查与 172 项测试通过。

随后在用户主 daemon 完成真实安装与验收：`paseo plugin reload multica` 编译约 5 秒，daemon PID 不变；官方 SDK 读取到 97,666 字节 client bundle（hash `67cb5fbd314a61f98657865dc5f904a7552fdef22851d85b1fdcdeef259705cf`，含 `multica-mention`）。启用现有 henrylee 规则后，HENR-1 主讨论、HENR-2 主讨论与已有 Thread 的三个 agent metadata 与 labels 一致；`delivery.mentions` 返回真实 agent 拉车的🫏（`5505d430-fd5c-416a-9455-2af92d34b67d`）。两条评论均保存：SDK 发送 `01a2114f-7f2b-776b-b5cc-c27e4c9153fe` 与 UI 选择器发送 `01a21152-da7b-7cc4-afb7-9349a0a27879`，各自触发该 agent 的 Run（`01a2114f-7f59-73ea-b55a-f8732a1cb38d`、`01a21152-da8b-74cb-a604-717a146eafdc`），原生 Stop 后服务端 cancelled、原生 idle（1401ms、667ms）。UI 使用独立 Electron user-data 的第二客户端连同一主 daemon，通过 CDP 打开 HENR-2 的已有 Thread、点击「提及 Agent」、搜索并选择该 agent，输入框收到完整 canonical 引用后点击发送；截图见下条证据。隔离客户端已关闭，主 daemon 与主窗口未重启；验收后 henrylee 规则保持启用、两个任务的讨论保持活跃，便于在同一窗口试用。未验证物理进程退出（cleanup UNKNOWN）、移动布局、原生溢出面板与自部署服务。

## Standards

原评审发现 1 处低影响术语违规：产品文案未区分 Multica 工作区与 Paseo 工作区；另有 2 项判断性的重复逻辑，分别是原生讨论身份分页查找和分段正文收集。修复统一了产品限定词、精确身份与循环游标检查，以及分段读取的前进校验和取消处理。原评审 agent 定向复核确认全部解决，无新增具体回归。

## Spec

原评审发现 3 项 P2：Run 任务错误丢失、远端执行路径未展示、手动恢复意外撤销其他讨论的隐藏。修复保留完整来源元数据及有界读取，使手动与自动恢复共享隐藏保护。原评审 agent 定向复核确认全部解决；最终实际宿主组合复测另行验证元数据及手动恢复。

复核汇总：Standards 原 1 项低影响违规与 2 项判断性重复均已解决，剩余 0；Spec 原 3 项 P2 均已解决，剩余 0。

## askuser 本地收起与跳过（#23，模拟验证）

本轮只运行公开服务端贡献／provider／RPC 与宿主编译客户端 bundle 的隔离测试，没有安装或 reload 插件，没有操作真实 daemon 或 Multica 服务。覆盖本地 Dismiss（含全选填文本的空 `allow`）、同步／重启后保持收起、显式重展、跳过二次确认与取消零请求、失败保真、指定用户／连接／归档隐藏检查、同卡并发和原 Stop epoch 栅栏。

`askuser-skip` 的真实响应码与正文仍未采样。模拟服务使用成功的空 `204` 响应；客户端不依赖返回 JSON，服务端在成功 HTTP 响应后尽力读取完整 timeline 的 `askuser_skipped_at`／`askuser_skipped_by`，然后持久化 `skipped`。`202 Accepted` 仅在 timeline 确认已跳过时进入终态，否则如实报告待核对。没有远端元数据时不生成本地时间戳或推测操作者；HTTP 4xx／5xx 与网络断线不标记已跳过、不清除原生权限，错误明确要求核对远端最后状态。失败后没有自动重发跳过请求。真实响应及原生视觉行为需在 #26 手动验收中核实。

固定宿主的全选填文本表单在已经输入文字后，Dismiss 与 Submit 产生相同的非空 `allow`，插件无法区分。本轮只保证规格中的全空 `allow` 按本地收起处理；不宣称已经解决或实测所有非空 Dismiss 场景。
