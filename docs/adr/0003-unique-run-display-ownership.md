# 为每个 Run 保留唯一展示归属

Multica 的单次 Run 可以同时合并处理同一 Issue 下多个 Thread 的评论，也可能不关联任何评论，而 Paseo 中重复渲染同一 Run 会造成状态与时间线混乱。插件为每个 Run 持久固定唯一的展示归属 `ownerRootId`，确定后不因后续合并评论或重连而迁移；执行详情以归属讨论下的只读 provider subagent 呈现（[ADR 0011](./0011-run-as-provider-subagent.md)）。

归属仲裁从完整成功的 `task-runs?view=timeline` 快照读取触发、合并、已交付、补充及 `source_task_id` 生成评论五类关联：优先采用明确触发评论所属 Thread；无触发评论时按关联评论真实的 RFC3339Nano `created_at` 选择最早者所属 Thread（生成评论参与归属判断但不充当触发输入描述）；缺失父链或跨 Thread 评论缺少可靠时间时等待后续快照补齐，不按数组顺序猜测，也不提前回退本地主讨论；仅当完整快照确认零评论关联时才固定到本地主讨论 `main`。

## 影响与边界

- **单一原生 turn 聚合与新 UUID**：Paseo 每个讨论 tab 只有一个原生活动 turn 槽位，同一讨论下所有处于 `queued`、`dispatched`、`running`、`waiting_local_directory`、`deferred` 的归属 Run 共同维持该活动周期，全部终结后才结束 turn。每次从空闲进入活动必须分配全新 UUID（Paseo `0.15.3` 实测复用已完成 turn ID 会导致后续完成事件被忽略）。
- **原生 Stop 结算边界**：点击 Stop 时捕获当前原生 turn 与固定取消集合；集合全部终结后先结束该原 turn，若期间已有后来发现的活跃 Run，再立即以全新 UUID 开启后续 turn，避免宿主在 2 秒超时后强制取消导致新 Run 的原生活动状态丢失。部分取消失败保留当前活动状态并返回错误。
