# 通过设置页数据重建清理并重新导入当前连接数据

当宿主持久化历史形态发生不兼容变化（如 [ADR 0011](./0011-run-as-provider-subagent.md) 移除旧执行段）或需要清零重导时，插件在设置页提供**数据重建（Data rebuild）**入口，而非要求用户手动清理宿主记录与插件状态目录。数据重建只作用于当前 Multica 连接，且仅在连接状态为 `ready` 时可用；无已启用筛选规则时仍允许执行，完成清理后以 0 个任务结束。

数据重建保留各 Multica 工作区的筛选规则与启用状态及连接的重建代数，清空该连接其余全部本地缓存与人工隐藏，不改动其他连接的数据，也不删除包含用户自建工作区的 Paseo 项目（沿用 [ADR 0002](./0002-use-existing-paseo-with-placeholder-directories.md)）。保留顶层 `state.owner` 的 profile 归属，若 ADR 0010 的 profile 清理尚未完成则拒绝重建。发起前以本地缓存检查当前连接是否存在活跃 Run，有则拒绝开始并列出对应讨论与 Run；确认框展示将删除的项目、工作区与讨论数量，并说明保留规则、清除人工隐藏。重建在 daemon 侧执行并暂停后台同步，进度框分“删除”与“导入（已完成 x / 共 N 个任务）”两阶段，中途不提供取消按钮；离开设置页后后台继续完成，重开可见实时进度或结果。不持久化中间进度，失败或重启后再次点击直接从头开始。

删除严格通过公开低层 SDK 按顺序执行：先对当前连接下全部插件讨论（含已归档）调用 `deleteAgent` 彻底删除记录与持久化时间线；再从宿主活跃工作区目录按已知 ID 或当前连接占位目录识别插件工作区（包括已无讨论的工作区），仅对这些活跃插件工作区调用 `archiveWorkspace` 归档；再对不含用户自建工作区的插件项目调用 `removeProject` 彻底移除；随后保留筛选规则并递增 `rebuildGeneration`（缺省为 0），清空当前连接其余本地状态，按规则重新导入并恢复后台同步。

## Considered Options

- **用 `archiveAgent` 归档再重导**：`importAgent` 会按相同 `providerHandleId` 复活已归档记录与旧时间线；且 `archiveAgent` 会对运行中讨论发送 `session.interrupt`，按 [ADR 0004](./0004-native-interrupt-stops-remote-run.md) 误取消远端 Run。
- **直接修改 Paseo 内部文件物理删除工作区**：绕过公开 SDK，违背 [ADR 0002](./0002-use-existing-paseo-with-placeholder-directories.md) 不改宿主核心与内部存储的边界。
- **重建后保留并重放人工隐藏**：需要再次引入先恢复再保护归档的复杂流程，得不偿失。
- **保存重建断点续做或支持中途取消**：增加持久状态机复杂度，中途停止或失败直接从头重新开始即可覆盖残留对象。
- **点击前全量拉取远端最新 Run 列表再检查活跃 Run**：任务多时响应慢，且所用删除接口不发 `session.interrupt`，不存在误取消远端新 Run 的风险。

## Consequences

- Paseo 没有删除工作区的公开接口，只能 `archiveWorkspace`。旧工作区会作为不含讨论的空归档记录留在宿主恢复记录中（侧栏不可见），且原 `workspaceId` 与 `idempotencyKey` 仍被宿主注册表和创建凭据占用，因此重建后的新任务映射必须将持久化 `rebuildGeneration` 混入 `workspaceId` 与 `idempotencyKey`；立即重导、0 规则清理后启用、后续命中以及失败后的普通同步均使用此代数，避免回退到旧凭据。
- 经 `deleteAgent` 彻底删除后，以相同 `providerHandleId` 重新 `importAgent` 会分配全新 `agentId` 与干净时间线，不会复活旧执行段行。
- 已从 Paseo 0.17.4 daemon 源码核实 `deleteAgent`、`archiveWorkspace` 与 `removeProject` 均仅走 `closeAgentRuntime` 发送 `session.close`，不触发 `session.interrupt`，因此数据重建绝不会取消远端 Run（0.15.3 daemon 未现场源码核实）。
- Run 的展示归属会按远端完整快照重新判定；此前因暂时缺少评论关联而固定在本地主讨论的 Run，重建后可能归属到对应的 Thread 下。
