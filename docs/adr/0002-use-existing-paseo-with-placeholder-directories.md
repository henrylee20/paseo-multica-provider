# 使用现有 Paseo 与本地占位目录

Paseo 的外部 provider 契约不能单独生成原生 project / workspace 层级，且交互式 workspace 要求 daemon 主机存在实际目录。插件选择不修改 Paseo 核心，改由 daemon 侧同步器配合 `PASEO_HOME/multica-provider` 下的独立非 Git 本地占位目录建立层级：通过 `PASEO_HOME/paseo.pid.listen` 连接拥有者 daemon 并校验 `serverId` 一致后调用底层 `DaemonClient`（不使用可能指向其他实例的 `PASEO_HOST`）。客户端连接后每 10 秒幂等引导后台同步，启动后客户端离线不终止同步，daemon 重启后需至少一次客户端连接重新引导。

归档 workspace 仅作为本地展示生命周期（远端停止语义见 [ADR 0004](./0004-native-interrupt-stops-remote-run.md)）。插件将自动归档原因 `archiveReason`（`rule_disabled` / `filter_exit`）及归档前活跃讨论集合 `ruleArchivedAgentIds` 与用户关闭 tab / 归档工作区产生的持久人工隐藏分开保存，使人工隐藏始终优先于自动恢复，并在设置页分别提供「恢复 Paseo 工作区」与「恢复讨论」。

## 影响与边界

- **本地占位目录语义**：占位目录不代表远端代码仓库，原生文件树与终端会指向该目录；除切换 CLI profile 清理（[ADR 0010](./0010-clear-local-data-on-profile-switch.md)）外，日常归档与数据重建保留占位目录。
- **停用规则移除空 Project 与外壳迁移**：显式停用工作区规则并归档任务后，完整分页核对确认该插件 Project 下无用户自建活跃工作区时，调用 `removeProject` 移除空项目（含用户自建活跃工作区则保留）。由于重新 `addProject` 会分配新 ID 且旧 workspace 无法直接挂回，重新启用时生成新的工作区外壳并以原 cwd 与 provider handle 重新 `importAgent`，将已归档讨论迁入新外壳，完整保留原 `agentId`、历史与人工隐藏。
- **恢复工作区时的隐藏唤醒保护**：Paseo `0.15.3` 拒绝对已活跃工作区调用 `restoreWorkspace`（须完整分页比对 `fetchWorkspaces`，不能依赖宿主忽略的 `idPrefix`），而 `0.17.4` 恢复归档工作区时存在 60 秒时间戳回退，可能连带唤醒同工作区的其他人工隐藏讨论。自动与手动恢复因此统一走 `restoreWorkspacePreservingHidden`：先对未选定解除隐藏的讨论持有 `DiscussionLifecycle.hold()`、结束本地投影并等待已接收 Stop 完成，恢复工作区后立即安全重归档被宿主唤醒的隐藏记录，全程不调用对存活运行中会话有中断副作用的 `refreshAgent`，也不取消远端 Run。
