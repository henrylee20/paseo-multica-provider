# 将每个 Run 呈现为所属讨论下的 provider subagent

自定义插件行（执行段）将整次 Run 压缩在单行折叠卡片内，工具调用与运行文本无法使用宿主原生时间线渲染。插件改为让每个 Multica Run ID 对应一个只读的 Paseo provider subagent：Thread 与本地主讨论仍是 agent tab（[ADR 0001](./0001-thread-as-paseo-session.md)），Run 子代理挂在 [ADR 0003](./0003-unique-run-display-ownership.md) 首次固定的归属讨论下，不接受输入、不复制到其他 Thread。子时间线仅承载该 Run 的运行文本、思考、工具调用与结果、任务错误、失败原因及远端目录；触发评论、Run 生成评论和 AskUser 卡片仍留在父讨论时间线。

父会话协商 `session.subsession`，每个 Run 以 `session.opened{parentSessionId, toolCallId, restoration: "parent"}` 打开子会话（标题为执行 agent 名称，描述为输入触发来源与创建时间，系统作者显示「系统」，Run 自身生成评论不当作触发输入，无输入关联时标为带创建时间的「任务级执行」；五类活动状态映射为 `running` 并在细分状态变化时追加简短说明，`completed` / `failed` / `cancelled` 对应 `completed` / `failed` / `canceled`）。父讨论仍聚合活动 turn 并统一响应原生 Stop（[ADR 0004](./0004-native-interrupt-stops-remote-run.md)），父时间线按来源行与 Run 创建时间排定静态 `sub_agent` 位置标记（状态固定 `completed`，供 `toolCallId` 指向）。

父会话统一编排首次时间线输出：AskUser 卡片紧跟携带它的评论行（后续状态更新原位合并）；Run 标记等待其输入来源行（优先本讨论触发评论，否则最早输入关联评论）确认后，按创建时间排在首条来源时间严格较晚的后续评论及其分隔线之前，同时间按 Run ID 排序。无输入锚点的 Run 在完整评论快照可用后按纳秒时间参与排序；存在输入来源却无对应行时，须等开始等待后才发起的一次讨论刷新投递完成才认定来源缺失。宿主按到达顺序追加并固定条目位置，已错位的旧时间线无法原位移动，需用户在设置页执行「重建数据」（会清除人工隐藏）。

## 考虑过的替代方案

- **使用带 `paseo.parent-agent-id` 标签的持久子 agent**：会暴露独立输入框、独立 Stop、归档与脱离操作，违背只读要求且导致 agent 目录膨胀。
- **仅发出 `sub_agent` 工具调用徽章**：宿主 UI 不读取 `childSessionId` 展开详情，无法承载执行日志。
- **让父时间线徽章随 Run 状态实时变化**：宿主仅在同一 turn 内合并同 ID 工具调用；跨重启或跨 Stop 边界后旧徽章会卡在 `running` 并产生重复徽章。
- **同时保留旧执行段行与子代理**：双轨展示冗余，选择彻底移除旧执行段与 `run.read` 等 RPC，旧历史通过数据重建清理（[ADR 0012](./0012-data-rebuild.md)）。

## 影响与边界

- **按打开讨论顺序推送与补读**：宿主仅在内存中保存 provider subagent 且查看子时间线时不回调插件，因此父讨论打开（含导入）时先按上述顺序发出 Run 标记，再打开对应子会话、推送已缓存内容并立即按已知终态结算（离线、登出或拉取失败不阻塞终态）；`history:skip` 中已有标记的 Run 立即恢复子会话。仅本进程实际打开过的讨论每 2 秒增量补读活跃 Run 明细，终态成功补齐后标记 `runDetails.finalized` 停止，补齐前不越过序号缺口。`markerProjected` 仅在标记实际发出后持久化，`history:skip` 只补发尚未发出的新标记。
- **关闭与兼容性**：子代理无独立 Stop 或人工隐藏；父投影纯关闭时仅清空本地子会话 map，不主动发子会话 `session.closed`（避免宿主将运行中子代理误标为 `completed`）。manifest 保持 `>=0.15.3`，但 `0.15.x` 桌面客户端的 Subagents 界面未验证且无执行段后备，不支持该展示的客户端将无法查看 Run 明细。
