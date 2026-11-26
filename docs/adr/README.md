# 架构决策记录（ADR）

本目录记录 `paseo-multica-provider` 中难以逆转、存在真实取舍且脱离上下文难以理解的关键架构决策。

| 编号 | 决策标题 | 核心结论 |
| --- | --- | --- |
| [0001](./0001-thread-as-paseo-session.md) | 以 Multica 讨论串作为 Paseo 会话边界 | Multica 工作区 → Paseo 项目，Issue → Paseo 工作区，Thread → 独立 agent tab，Run → 归属讨论下的只读子代理 |
| [0002](./0002-use-existing-paseo-with-placeholder-directories.md) | 使用现有 Paseo 与本地占位目录 | 不改 Paseo 核心；用非 Git 占位目录与后台同步器维护层级，移除空 Project 时保留讨论身份并保护人工隐藏 |
| [0003](./0003-unique-run-display-ownership.md) | 为每个 Run 保留唯一展示归属 | 每个 Run 按触发或最早关联评论唯一固定 `ownerRootId`，父讨论聚合活动 turn 并按周期轮换 UUID |
| [0004](./0004-native-interrupt-stops-remote-run.md) | 原生中断停止远端执行 | 原生 Stop 与关闭运行中 tab 取消当前讨论的活跃 Run 快照；纯 `session.close` 与工作区归档绝不取消远端 |
| [0005](./0005-preserve-native-comment-history.md) | 保留原生评论消息并追加更正记录 | 原生消息只增不改，编辑/删除以独立事件追加；`history:skip` 完整分页读回核对原文，防止跨重启丢重 |
| [0006](./0006-isolate-connection-identities.md) | 按服务与用户身份隔离本地映射 | 以 `server_url` + `user.id` 组成连接键并校验在途请求身份；跨 CLI profile 数据保留已由 ADR 0010 取代 |
| [0007](./0007-retry-comments-only-with-deduplication.md) | 评论投递采用同幂等键有限次重试 | 单次发送固定正文、目标与 `Idempotency-Key` 最多尝试 3 次，成功仅保留 `clientMessageId` 回声映射 |
| [0008](./0008-reuse-multica-cli-authentication.md) | 复用 Multica CLI 的登录上下文 | daemon 只读复用 CLI `0.6.3` 配置与目录布局枚举 profile，遵循环境变量覆盖与任务上下文隔离 |
| [0009](./0009-composer-mention-picker.md) | 输入框提及选择器使用 composer item 并镜像讨论身份 | Paseo `0.16+` 注册 `multica-mention` 插入带 ID 的规范引用，由 daemon 将讨论标签镜像至 `metadata` |
| [0010](./0010-clear-local-data-on-profile-switch.md) | 切换 CLI profile 时清空本机插件数据 | 以持久归属 `state.owner.profile` 驱动切换清理，清空旧 profile 本机数据且保留含用户自建工作区的 Project |
| [0011](./0011-run-as-provider-subagent.md) | 将每个 Run 呈现为所属讨论下的 provider subagent | 以 `session.subsession` 投影只读 Run 子代理与静态位置徽章，取代旧自定义执行段行与按需读取 RPC |
| [0012](./0012-data-rebuild.md) | 通过设置页数据重建清理并重新导入当前连接数据 | 串行执行 `deleteAgent` → `archiveWorkspace` → `removeProject` 并递增 `rebuildGeneration`，保留筛选规则重导 |
