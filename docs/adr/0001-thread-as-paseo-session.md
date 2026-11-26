# 以 Multica 讨论串作为 Paseo 会话边界

为在 Paseo 中忠实呈现 Multica 的协作结构，将 Multica 工作区映射为 Paseo project、Issue 映射为 Paseo workspace、Issue 内以顶层评论为根的 Thread 映射为独立 agent tab（另设承载任务描述与无评论关联 Run 的本地主讨论），而不把单次 Run 或单个 Multica agent 当作 tab 边界。

连接用户本人的普通评论呈现为原生 `user` 消息，其他成员及 agent 的发言呈现为带作者名称的原生 `assistant` 消息（编辑与删除策略见 [ADR 0005](./0005-preserve-native-comment-history.md)）。一次 Run 可能跨多个 Thread 处理评论，但仅在唯一归属讨论下以只读 provider subagent 呈现，不成为独立 tab，也不复制到多个 Thread，详见 [ADR 0003](./0003-unique-run-display-ownership.md) 与 [ADR 0011](./0011-run-as-provider-subagent.md)。
