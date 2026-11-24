# 为每个 Run 保留唯一展示归属

Multica 的一个 Run 可能处理多个 Thread 的评论，但 Paseo 只在一个位置展示该 Run 的执行流，不在每个相关 Thread 中复制。
对有评论关联的 Run，优先选择触发评论所属 Thread，没有触发评论时选择最早关联评论所属 Thread；确定后不因其他 Thread 的合并或追加评论而迁移。
首次展示时完全无评论关联的 Run 固定展示在该 Issue 的本地主讨论 tab，后续即使发现评论关联也不迁移；该 tab 同时承载 Issue 描述，且仅同步展示不会自动向 Multica 发表评论。
