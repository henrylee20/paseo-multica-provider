# 使用现有 Paseo 与本地占位目录

Paseo v0.15.4 的 provider 契约不能单独生成原生 project/workspace 层级，交互 workspace 又要求 daemon 上存在实际目录。
首版保持 Paseo 核心不变，采用 provider、任务同步器及本地占位目录，而不新增远程 workspace 类型；占位目录不代表 Multica 的代码工作区，因此原生文件和终端功能可能指向占位目录。
归档 workspace 保持为本地展示操作；原生停止与关闭运行中 tab 的远端执行语义见 [ADR 0004](./0004-native-interrupt-stops-remote-run.md)。

客户端连接后自动引导 daemon 侧同步，成功启动后客户端离线不终止同步。
daemon 或插件进程重启后需要至少一次客户端连接来重新引导；首版接受这一条件，不承诺完全无人连接时自行恢复。

#3 的适配层使用真实低层 SDK：`addProject` 注册 Multica 工作区的非 Git 占位根目录，再以显式 `source.projectId` 将每项 Issue 的独立目录放入该 project。主讨论通过稳定 provider handle 的 `importAgent` 导入；原生 workspace ID、创建幂等键和映射意图在创建前持久化。标题不参与远端身份判断。

高层 `PaseoApi` 不公开底层 `DaemonClient`。插件从拥有者 daemon 注入的 `PASEO_HOME` 读取 `paseo.pid.listen`，使用仅在服务端读取的 `local-credential` 回调独立连接，再比较低层 `listHosts().self.serverId` 与 RPC 上下文 `paseo.hosts.list().self.serverId`，确认相同后才变更原生记录。凭据不进入插件状态或 RPC；不使用可能指向另一实例的 `PASEO_HOST`。

显式停用工作区规则通过 workspace 级归档保留历史，持久化自动归档原因。重新启用先恢复原 workspace，只恢复因该规则归档的已归档 agent；不对运行中的 agent 调用具有中断语义的 `refreshAgent`。
