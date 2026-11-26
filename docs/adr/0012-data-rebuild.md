# 通过设置页数据重建清理并重新导入当前连接数据

当宿主持久化时间线结构发生不兼容演进（如 [ADR 0011](./0011-run-as-provider-subagent.md) 移除旧执行段）或需要重置本地投影时，插件在设置页提供**数据重建（Data rebuild）**入口，避免要求用户手工删改宿主记录与状态目录。数据重建仅作用于当前连接，且仅在连接 `ready`、无未完成 profile 清理（[ADR 0010](./0010-clear-local-data-on-profile-switch.md)）时可用；无已启用规则时仍允许执行清理并以 `0/0` 结束。

发起前按当前连接本地缓存预检活跃 Run，存在活跃 Run 时列出对应讨论与 Run 并拒绝开始；无阻塞时二次确认待删数量，暂停后台同步与规则写入，严格按公开底层 SDK 顺序执行：`deleteAgent` 彻底删除当前连接全部插件讨论（含已归档）→ `archiveWorkspace` 归档活跃目录中的当前连接插件工作区（含已无讨论的工作区）→ 完整分页复核后 `removeProject` 移除不含用户自建活跃工作区的插件项目 → 保留 `state.owner` 与当前连接筛选规则、递增持久化 `rebuildGeneration`（缺省 `0`）、清空该连接其余缓存与人工隐藏 → 按规则重新导入并恢复同步。中间进度仅保存在 daemon 内存，不提供中途取消，失败或重启后再次点击直接从头重跑。

## 考虑过的替代方案

- **调用 `archiveAgent` 归档后再重导**：相同 `providerHandleId` 的 `importAgent` 会复活旧归档记录与旧时间线，且 `archiveAgent` 会对运行中会话发 `session.interrupt` 误杀远端 Run。
- **直接修改 Paseo 内部存储文件物理删除工作区**：违背 [ADR 0002](./0002-use-existing-paseo-with-placeholder-directories.md) 不触碰宿主内部存储的边界。
- **重建后保留并重放人工隐藏，或持久化断点续做状态机**：显著增加恢复保护与状态机复杂度，而从头幂等重跑即可覆盖残留对象。
- **点击前实时全量拉取远端 Run 再做预检**：任务多时阻塞交互，且所用清理接口均不发中断，不会误杀预检后新产生的远端 Run。

## 影响与边界

- **工作区代数隔离与全新时间线**：宿主无公开删除工作区接口，旧工作区会作为空归档记录留在宿主注册表中并占用原 `workspaceId` 与 `idempotencyKey`；新映射将持久化 `rebuildGeneration` 混入 `workspaceId` 与创建幂等键（覆盖立即重导及后续普通同步），讨论经 `deleteAgent` 后重新导入会分配全新 `agentId` 与干净时间线。
- **远端安全与归属重判**：已在 Paseo `0.17.4` daemon 源码核实 `deleteAgent`、`archiveWorkspace` 与 `removeProject` 均只走 `closeAgentRuntime` 发送 `session.close()`（其中 `deleteAgent` 亦已在 `0.15.3` 源码核实），不触发 `session.interrupt`，绝不会取消远端 Run。重建后各 Run 的展示归属会基于当前完整远端快照重新判定。
