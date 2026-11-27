# 将每个 Run 呈现为所属讨论下的 provider subagent

自定义插件行（执行段）将整次 Run 压缩在单行折叠卡片内，工具调用与运行文本无法使用宿主原生时间线渲染。插件改为让每个 Multica Run ID 对应一个只读的 Paseo provider subagent：Thread 与本地主讨论仍是 agent tab（[ADR 0001](./0001-thread-as-paseo-session.md)），Run 子代理挂在 [ADR 0003](./0003-unique-run-display-ownership.md) 首次固定的归属讨论下，不接受输入、不复制到其他 Thread。子时间线仅承载该 Run 的运行文本、思考、工具调用与结果、任务错误、失败原因及远端目录；触发评论、Run 生成评论和 AskUser 卡片仍留在父讨论时间线。

父会话协商 `session.subsession`，每个 Run 以 `session.opened{parentSessionId, toolCallId, restoration: "parent"}` 打开子会话（标题为执行 agent 名称，描述为输入触发来源与创建时间，系统作者显示「系统」，Run 自身生成评论不当作触发输入，无输入关联时标为带创建时间的「任务级执行」；五类活动状态映射为 `running` 并在细分状态变化时追加简短说明，`completed` / `failed` / `cancelled` 对应 `completed` / `failed` / `canceled`）。父讨论仍聚合活动 turn 并统一响应原生 Stop（[ADR 0004](./0004-native-interrupt-stops-remote-run.md)），父时间线按来源行与 Run 创建时间排定静态 `sub_agent` 位置标记（状态固定 `completed`，供 `toolCallId` 指向）。

子会话 ID 固定为 `multica:run:<runId>`，对应 `multica:run-marker:<runId>`。宿主每次 resume 都分配新的父会话 UUID，但热重载保留原 agent 的内存子代理及其时间线；子身份不能依赖父会话 ID，否则旧子代理与已打开面板永久失联。宿主显式关闭子会话时回复 `session.closed` 并清除本地子映射，保证同连接可重新打开。

父会话统一编排首次时间线输出：AskUser 卡片紧跟携带它的评论行（后续状态更新原位合并）；Run 标记等待其输入来源行（优先本讨论触发评论，否则最早输入关联评论）确认后，按创建时间排在首条来源时间严格较晚的后续评论及其分隔线之前，同时间按 Run ID 排序。无输入锚点的 Run 在完整评论快照可用后按纳秒时间参与排序；存在输入来源却无对应行时，须等开始等待后才发起的一次讨论刷新投递完成才认定来源缺失。宿主按到达顺序追加并固定条目位置，已错位的旧时间线无法原位移动，需用户在设置页执行「重建数据」（会清除人工隐藏）。

## 考虑过的替代方案

- **使用带 `paseo.parent-agent-id` 标签的持久子 agent**：会暴露独立输入框、独立 Stop、归档与脱离操作，违背只读要求且导致 agent 目录膨胀。
- **仅发出 `sub_agent` 工具调用徽章**：宿主 UI 不读取 `childSessionId` 展开详情，无法承载执行日志。
- **让父时间线徽章随 Run 状态实时变化**：宿主仅在同一 turn 内合并同 ID 工具调用；跨重启或跨 Stop 边界后旧徽章会卡在 `running` 并产生重复徽章。
- **同时保留旧执行段行与子代理**：双轨展示冗余，选择彻底移除旧执行段与 `run.read` 等 RPC，旧历史通过数据重建清理（[ADR 0012](./0012-data-rebuild.md)）。

## 影响与边界

- **导入与 live 恢复分开**：首次导入在 `ready` 前收集子会话历史；已有 `agentId` 的讨论在 `ready` 前不占用子会话 ID，等待无中断 `listCommands(agentId)` 返回、原生订阅完成后，再 live 恢复子会话及父聚合 turn。后台与用户主动打开均走该确认；独立调用未提供原生回调时保留原行为。`markerProjected` 仅在实际发出标记后持久化，live 恢复不重复既有标记，仅补发新标记（可能追加在既有评论后）。
- **复用内存子时间线**：恢复前通过公开 SDK 的 `listProviderSubagents` 与完整分页 `fetchProviderSubagentTimeline` 核对宿主缓存，按文本身份／前缀及其他消息内容跳过已投影部分，仅追加缺失输出。daemon 重启后无子代理缓存则全量恢复；读回失败仍结算最新状态，抑制首次缓存批次以避免重复日志，后续增量继续，既有缺失部分待下次成功重开核对。仅本进程实际打开过的讨论每 2 秒增量补读活跃 Run 明细，终态成功补齐后标记 `runDetails.finalized` 停止，补齐前不越过序号缺口。
- **自动唤醒**：同步发现活跃 Run 或刚由活跃结算终态时，按固定归属唤醒主讨论与 Thread；遵守启用规则、归档、人工隐藏、`hold`、身份和原生目录守卫，以 `listCommands` 无中断加载并按讨论节流 60 秒。只关闭本地会话不会取消远端 Run。
- **热重载硬边界**：runtime 关闭时宿主先退订插件事件，再合成失败；短暂 `failed`、父时间线 `Provider connection closed` 及前端本地 `Subagent failed` 无法由插件阻止或清除。插件负责随后自动恢复，实机验收待执行，当前仅有隔离／模拟回归。旧版含父会话 ID 的子代理没有公开改名／删除接口，首次升级可能保留旧项，daemon 重启后清空。
- **关闭与兼容性**：子代理无独立 Stop 或人工隐藏；父投影纯关闭时仅清空本地子会话 map，不主动发子会话 `session.closed`（避免宿主将运行中子代理误标为 `completed`）。manifest 保持 `>=0.15.3`，但 `0.15.x` 桌面客户端的 Subagents 界面未验证且无执行段后备，不支持该展示的客户端将无法查看 Run 明细。
