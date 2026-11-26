# 将每个 Run 呈现为所属讨论下的 provider subagent

执行段把 Run 的执行内容压在一个可展开的插件行里，工具调用与运行文本不是原生时间线。用户改为让每个 Multica Run ID 对应一个 Paseo provider subagent：Thread／本地主讨论仍是 agent tab，ADR 0001 的项目、工作区与 tab 层级不变；Run 子代理只读、不接受输入，挂在 ADR 0003 首次固定的展示归属讨论下，不复制到其他 Thread。subagent 时间线只承载该 Run 自身的执行消息、任务错误、失败原因与远端目录；触发评论、Run 生成的评论和 AskUser 卡片仍是所属讨论中的评论。

实现采用插件 provider 的子会话契约：父会话协商 `session.subsession`，每个 Run 以 `session.opened{parentSessionId, toolCallId, restoration: "parent"}` 打开子会话。标题为执行 agent 名称，描述为输入评论的触发来源与创建时间；系统作者显示“系统”，Run 自己生成的评论只参与展示归属，不当作输入触发来源；无输入关联的任务级执行也显示有效创建时间；Multica 的 queued、dispatched、running、waiting_local_directory、deferred 映射为 running，completed／failed／cancelled 对应 completed／failed／canceled，活跃期内的细分状态变化以简短条目追加到子时间线。

所属讨论仍按 ADR 0003 聚合活动 turn，原生 Stop 与关闭运行中 tab 仍按 ADR 0004 取消该讨论当时的全部活跃 Run，并由插件把对应子会话结束为 canceled。所属讨论时间线按来源行与 Run 创建时间排定静态 `sub_agent` 位置标记，固定为 completed，不随 Run 状态更新；子会话的 `toolCallId` 指向该徽章。

父会话统一安排首次输出：AskUser 卡片紧跟携带它的评论；Run 标记在输入来源行确认后，按创建时间排在首条来源时间严格较晚的后续评论及其分隔线之前，同时间按 Run ID 排序。无输入锚点的 Run 在完整评论快照可用后参与排序；有来源却没有任何行时，须等开始等待后才发起的一次讨论刷新投递完成，才能认定来源缺失。宿主按到达顺序追加，插件不能移动已经错位的旧时间线；需要用户自行在设置页“重建数据”，该操作会清除人工隐藏。

## Considered Options

- **带 `paseo.parent-agent-id` 标签的子 agent**：拥有独立 Stop、输入框、归档与脱离，会成为持久 agent 记录并出现在 agent 列表中。与只读要求冲突，且会把人工隐藏扩展到单个 Run，Run 数量多时记录膨胀。
- **只用 `sub_agent` 工具调用徽章**：宿主 UI 不读取 `childSessionId`，徽章不可点开也没有详情，无法承载执行内容。
- **徽章跟随 Run 状态更新**：宿主只在同一 turn 内合并同一工具调用；重启、Stop 边界或宿主强制取消 turn 后，旧徽章会停留在 running 并出现重复的新徽章。状态在两处可能不一致比徽章不显示状态更糟。
- **保留执行段并另加 subagent 入口**：两套展示并存，用户选择完全取代。

## Consequences

- 宿主只在内存中保存 provider subagent，且应用读取子时间线时不回调插件，因此 ADR 0003 #8 的"展开执行段才按需读取"改为：讨论在宿主中打开（含导入）时，先按上述顺序发出 Run 标记，再打开对应子会话并补推已缓存内容；`history:skip` 中已有标记的 Run 立即恢复子会话。只有本进程实际打开过的讨论才从远端补读缺失明细，活跃 Run 定期刷新，终态成功拉取后保存 `runDetails.finalized` 再停止；最终拉取前不越过消息序号缺口，拉取完成后按可得源顺序补齐。子会话释放时立即按已知 Run 终态结束，不等待明细读取，离线、CLI 登出或读取失败也不会显示为运行中；终态后仍可追加执行消息。每次父会话打开都需重新发出子会话。Run 的 `markerProjected` 仅在标记实际发出后保存，`history:skip` 只补发尚未发出的标记，包括父讨论关闭期间新发现的 Run。
- 子会话没有原生 Stop、输入或权限请求；单个 Run 无法在 Paseo 中单独停止，停止入口只在所属讨论。
- 宿主关闭父会话运行时会把仍在运行的子会话标为 canceled；插件关闭父投影时只清理本地子会话 map，不主动发出子会话 `session.closed`，避免宿主将运行中子代理覆盖为 completed。这仅是本地显示，远端 Run 不受影响，下次打开讨论时由插件按真实状态纠正。归档讨论会一并移除其子会话，恢复后重新发出；单个 Run 没有独立的人工隐藏。
- 执行段插件行及 `run.read` 等按需读取 RPC 被移除，不为已存在宿主历史中的旧执行段行保留渲染兼容；已有旧数据通过设置页的**数据重建**清理并重新导入，见 [ADR 0012](./0012-data-rebuild.md)。
- manifest 仍声明 `>=0.15.3`。插件子会话路径已在 0.15.3 daemon 与 0.15.4 SDK 中确认，0.15.x 应用的 Subagents 展示未验证；执行段不再作为后备，无该展示的宿主将看不到 Run 内容。
