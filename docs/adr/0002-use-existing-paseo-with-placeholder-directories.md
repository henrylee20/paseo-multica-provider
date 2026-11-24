# 使用现有 Paseo 与本地占位目录

Paseo v0.15.4 的 provider 契约不能单独生成原生 project/workspace 层级，交互 workspace 又要求 daemon 上存在实际目录。
首版保持 Paseo 核心不变，采用 provider、任务同步器及本地占位目录，而不新增远程 workspace 类型；占位目录不代表 Multica 的代码工作区，因此原生文件和终端功能可能指向占位目录。
归档 workspace 保持为本地展示操作；原生停止与关闭运行中 tab 的远端执行语义见 [ADR 0004](./0004-native-interrupt-stops-remote-run.md)。

客户端连接后自动引导 daemon 侧同步，成功启动后客户端离线不终止同步。
daemon 或插件进程重启后需要至少一次客户端连接来重新引导；首版接受这一条件，不承诺完全无人连接时自行恢复。

#3 的适配层使用真实低层 SDK：`addProject` 注册 Multica 工作区的非 Git 占位根目录，再以显式 `source.projectId` 将每项 Issue 的独立目录放入该 project。主讨论通过稳定 provider handle 的 `importAgent` 导入；原生 workspace ID、创建幂等键和映射意图在创建前持久化。标题不参与远端身份判断。

高层 `PaseoApi` 不公开底层 `DaemonClient`。插件从拥有者 daemon 注入的 `PASEO_HOME` 读取 `paseo.pid.listen`，使用仅在服务端读取的 `local-credential` 回调独立连接，再比较低层 `listHosts().self.serverId` 与 RPC 上下文 `paseo.hosts.list().self.serverId`，确认相同后才变更原生记录。凭据不进入插件状态或 RPC；不使用可能指向另一实例的 `PASEO_HOST`。

显式停用工作区规则通过 workspace 级归档保留历史，持久化自动归档原因。重新启用先恢复原 workspace，只恢复因该规则归档的已归档 agent；不对运行中的 agent 调用具有中断语义的 `refreshAgent`。

#4 将 workspace 级自动生命周期扩展到动态筛选退出。自动归档前持久化 `rule_disabled`／`filter_exit` 原因、待确认标记与所有此前活跃的 Multica tab 身份；归档回执丢失时保留该集合重试，不用归档后的空活跃集合覆盖。重新匹配时先恢复原 workspace，再仅恢复这份集合中仍已归档的 agent。工作区 WebSocket 只负责使完整分页快照失效，网络、鉴权、格式与分页错误均不能推导任务离开范围。

#6 将人工隐藏独立持久化为 workspace 与讨论身份集合。真实 SDK 提供 `agent.archive.after` 和 `workspace.archive.after`；宿主 `archiveWorkspaceContents` 会先逐个产生 agent 归档事件，再归档 workspace 记录，事件没有归档原因或操作编号。常规原生 WebSocket 归档路径的 `archivingAt` 又属于各自 Session 的 WorkspaceDirectory，不能作为所有客户端、所有调用路径共享的原因标记。因此不能靠时间窗口猜测某个 tab 是先前被单独关闭还是本次 workspace 归档的组成部分。

为了保留全部人工选择，管理页分别提供“仅恢复工作区”和“恢复此讨论”。恢复某个讨论先恢复原 workspace，再仅当选定原 agent 确已归档时 refresh；其他隐藏讨论保持隐藏。workspace 归档所关闭的讨论也逐项可恢复，不猜测归档前的活跃集合。自动筛选归档仍使用事先持久化的 `archiveReason`、`archivePending` 与可恢复 agent 集合，在这些事件中不新增人工隐藏。人工隐藏优先于自动重返；失败或回执丢失保留选择，重试遇到已存活 agent 不 refresh。原生归档不删除占位目录或历史，`session.close` 仅释放资源，不表示人工隐藏或远端取消。

真实 0.15.3 宿主会拒绝对活跃 workspace 调用 `restoreWorkspace`，因此恢复讨论与自动规则重返都先核对低层 `fetchWorkspaces` 的活跃目录，已存在时跳过 workspace 恢复。该目录描述不含 `archivedAt`，不能猜测归档字段；0.15.3 宿主及 0.15.4 协议虽接受 `idPrefix`，实际不按该字段过滤，所以必须逐页比对完整 ID，缺失或循环分页游标视为失败。创建响应丢失后的身份核对复用同一查询，避免原 workspace 位于后续页时再次创建。恢复回执丢失后仍保留原隐藏或自动归档意图，重试依靠实际活跃目录及选定 agent 的归档状态完成剩余步骤。

上述事件顺序已从固定宿主源码核对，公开贡献入口的原生契约测试覆盖之；真实 0.15.3 加载及 UI 演示由集成验收单独记录，不以模拟宿主替代实际验证。
