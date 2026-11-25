# 以 Multica 讨论串作为 Paseo 会话边界

为在 Paseo 中保留 Multica 的任务与讨论结构，将 Multica 工作区映射为 Paseo project、Issue 映射为 workspace、Issue 内的评论 Thread 映射为 agent tab，而不将一次 Run 或某位 Multica agent 作为 tab 的边界。
自己的评论显示为原生 user message，其他参与者的评论显示为带作者名称前缀的原生 assistant message；执行过程以执行流呈现，评论更正策略见 [ADR 0005](./0005-preserve-native-comment-history.md)。
一次 Run 可能关联多个 Thread，但用户选择每个 Run 仅保留一个展示位置；具体规则见 [ADR 0003](./0003-unique-run-display-ownership.md)。
