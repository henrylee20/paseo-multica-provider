# 切换 CLI profile 时清空本机插件数据

为保证本机只保留当前所选 CLI profile 的插件数据，切换 profile 时删除前一 profile 留下的全部本地映射、规则、人工隐藏、缓存、原生讨论、插件 Project 与占位目录，取代 [ADR 0006](./0006-isolate-connection-identities.md) 早期跨 profile 保留旧数据的约定。Multica 远端数据与 CLI 配置文件不受影响。

设置页以下拉框选择 profile（枚举规则见 [ADR 0008](./0008-reuse-multica-cli-authentication.md)）。由于插件服务端 `PluginSettings` 只能读取与订阅设置而不能写入，切换清理由持久归属 `state.owner.profile` 驱动：客户端弹窗展示本机数据量并经用户确认后保存设置；服务端检测到设置中的 profile 与 `state.owner.profile` 不一致时，先完成可幂等重入的清理，再放行同步、导入或规则写入；中途失败保留原归属，由下一次引导重试。

## 考虑过的替代方案

- **按连接键保留跨 profile 数据以便切回续用**：与本机只保留当前所选 profile 数据的目标冲突。
- **新旧 profile 指向同一账号时跳过清理**：需在新 profile 可能离线或未登录时先行联网验身，边界不可预期。
- **由单个服务端 RPC 同时清理并写回设置**：Paseo 插件契约不提供服务端写设置能力。
- **枚举时逐个调用 `/api/me` 展示账号名**：会动用未选中 profile 的凭据发起远端请求。

## 影响与边界

- 即使新旧 profile 指向同一服务与账号，切换后仍清空旧数据并从空规则开始；同一 profile 下曾因外部 CLI 换号累积的多个连接也在下次切换 profile 时一并清空（旧版无 `owner` 字段的状态首次加载默认归属当前 profile，升级不误删数据）。
- 删除讨论采用 `deleteAgent`（先 `hold` 拒绝竞争打开，底层仅触发 `session.close()` 而不发中断，不会取消远端 Run）；移除项目采用 `removeProject`。若某个插件 Project 内存在用户自建工作区，则仅删除插件讨论、归档插件工作区，保留该 Project 与占位目录并在设置页提示；宿主无删除工作区记录接口，已归档工作区记录会残留在 daemon 注册表中。占位目录内用户手动放入的本地文件会随目录一并删除。
