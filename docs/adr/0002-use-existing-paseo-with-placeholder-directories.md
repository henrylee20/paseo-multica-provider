# 使用现有 Paseo 与本地占位目录

Paseo v0.15.4 的 provider 契约不能单独生成原生 project/workspace 层级，交互 workspace 又要求 daemon 上存在实际目录。
首版保持 Paseo 核心不变，采用 provider、任务同步器及本地占位目录，而不新增远程 workspace 类型；占位目录不代表 Multica 的代码工作区，因此原生文件和终端功能可能指向占位目录。
归档 workspace 保持为本地展示操作；原生停止与关闭运行中 tab 的远端执行语义见 [ADR 0004](./0004-native-interrupt-stops-remote-run.md)。

客户端连接后自动引导 daemon 侧同步，成功启动后客户端离线不终止同步。
daemon 或插件进程重启后需要至少一次客户端连接来重新引导；首版接受这一条件，不承诺完全无人连接时自行恢复。
