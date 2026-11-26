# 通过设置页数据重建清理并重新导入当前连接数据

当宿主持久化时间线结构发生不兼容演进（如 [ADR 0011](./0011-run-as-provider-subagent.md) 移除旧执行段）或需要重置本地投影时，插件在设置页提供**数据重建（Data rebuild）**入口，避免要求用户手工删改宿主记录与状态目录。数据重建仅作用于当前连接，且仅在连接 `ready`、无未完成 profile 清理（[ADR 0010](./0010-clear-local-data-on-profile-switch.md)）时可用；无已启用规则时仍允许执行清理并以 `0/0` 结束。

发起前针对当前连接本地缓存中的活跃 Run（含已人工隐藏或自动归档任务）向远端复核，列出仍阻塞的讨论与 Run；无阻塞或用户明确确认全部「确定无法确认」Run 后，二次确认待删数量，暂停后台同步与规则写入，严格按公开底层 SDK 顺序执行：`deleteAgent` 彻底删除当前连接全部插件讨论（含已归档）→ `archiveWorkspace` 归档活跃目录中的当前连接插件工作区（含已无讨论的工作区）→ 完整分页复核后 `removeProject` 移除不含用户自建活跃工作区的插件项目 → 保留 `state.owner` 与当前连接筛选规则、递增持久化 `rebuildGeneration`（缺省 `0`）、清空该连接其余缓存与人工隐藏 → 按规则重新导入并恢复同步。中间进度仅保存在 daemon 内存，不提供中途取消，失败或重启后再次点击直接从头重跑。

## 候选 Run 的针对性复核

人工隐藏、筛选退出或规则停用归档的任务不会持续刷新 Run 状态，单凭本地活跃缓存可能永久阻止重建。因此预检、启动首次检查与 `exclusive` 内最后检查共用一套复核规则：只将本地活跃 Run 按 Issue 分组，每个候选 Issue 串行读取一次现有 timeline 快照；优先复用本地 Multica 工作区 slug，缺失时本轮惰性读取一次工作区列表。请求继续通过既有远端读取与 `assertCurrent`，身份变化直接使整次预检或启动失败。

已确认终态的候选 Run 经 `RunSynchronizer` 的窄方法单向写回，只允许「活跃 → 终态」，只更新 `status`、`completedAt` 与按 `discover()` 相同语义合并的 `metadata`，再通知观察者。预检不占用同步队列，单向写回可保留并发同步已经写入的终态；复用 `discover()` 则会额外拉取 agents/members、重算关联并更新其他 Run，故不采用。复核结果与确认 ID 不持久化。

远端仍活跃时展示最新状态并继续阻止。Issue 404、Run 快照接口因无权访问 Multica 工作区返回 403、Multica 工作区不在工作区列表中、快照缺少该 Run 归为「确定无法确认」，附原因；仅当剩余阻塞项全部属于此类时提供「仍然重建」，同时展示待删数量并明示不会取消远端 Run。用户提交 `acknowledgedRunIds` 后，两次启动复核仍须逐项满足「确定无法确认且 ID 已确认」。首次复核未通过时返回最新阻塞项；通过后 RPC 立即返回 `started: true`，进度显示「等待后台同步」，不等待 `exclusive` 获取队列。新出现或重新确认为活跃的 Run 不被放行，`exclusive` 内拒绝时在任何删除前抛错并将进度置为 `failed`，错误信息列出剩余任务标题、讨论、Run ID 与复核结果，提示重新打开重建以重新复核。工作区列表读取失败（含 403）、超时、网络错误、5xx 与 schema 校验失败只允许重试，不允许通过确认绕过。

## 考虑过的替代方案

- **调用 `archiveAgent` 归档后再重导**：相同 `providerHandleId` 的 `importAgent` 会复活旧归档记录与旧时间线，且 `archiveAgent` 会对运行中会话发 `session.interrupt` 误杀远端 Run。
- **直接修改 Paseo 内部存储文件物理删除工作区**：违背 [ADR 0002](./0002-use-existing-paseo-with-placeholder-directories.md) 不触碰宿主内部存储的边界。
- **重建后保留并重放人工隐藏，或持久化断点续做状态机**：显著增加恢复保护与状态机复杂度，而从头幂等重跑即可覆盖残留对象。
- **点击前实时全量拉取远端 Run 再做预检**：任务多时阻塞交互，且所用清理接口均不发中断，不会误杀预检后新产生的远端 Run。采用上述仅针对本地活跃候选的复核，解决隐藏或归档任务中的陈旧阻塞，避免扩大为全量扫描。

## 影响与边界

- **工作区代数隔离与全新时间线**：宿主无公开删除工作区接口，旧工作区会作为空归档记录留在宿主注册表中并占用原 `workspaceId` 与 `idempotencyKey`；新映射将持久化 `rebuildGeneration` 混入 `workspaceId` 与创建幂等键（覆盖立即重导及后续普通同步），讨论经 `deleteAgent` 后重新导入会分配全新 `agentId` 与干净时间线。
- **远端安全与归属重判**：已在 Paseo `0.17.4` daemon 源码核实 `deleteAgent`、`archiveWorkspace` 与 `removeProject` 均只走 `closeAgentRuntime` 发送 `session.close()`（其中 `deleteAgent` 亦已在 `0.15.3` 源码核实），不触发 `session.interrupt`，绝不会取消远端 Run。重建后各 Run 的展示归属会基于当前完整远端快照重新判定。
