# 切换 CLI profile 时清空本机插件数据

用户要求本机只保留当前所选 CLI profile 的插件数据，因此切换 profile 时删除前一 profile 留下的全部本地映射、缓存、原生讨论、插件 Project 与占位目录，不再按 [ADR 0006](./0006-isolate-connection-identities.md) 保留旧身份以便切回续用。Multica 远端数据与 CLI 配置不受影响。

设置页以下拉框选择 profile。CLI 0.6.3 没有列出 profile 的命令，也没有已保存的 active profile，插件因此按 CLI 目录布局枚举 `<配置根>/profiles/*/config.json`（配置根遵循 `MULTICA_TASK_CONFIG_ROOT`），`token` 与 `server_url` 均非空即视为已登录，名称还须通过插件设置 schema。枚举只读文件，不向 RPC 返回凭据，也不用未选中 profile 的 token 调用 `/api/me`；选项只显示名称与服务主机，切换后才验证身份。环境变量覆盖凭据时提示切换不改变账号。

插件服务端只能读取和订阅设置，选择由客户端保存。清理因此由持久归属驱动：state 记录数据所属的 profile，设置中的 profile 与之不同时，先清理，再允许同步、导入或规则写入。各步骤可重复执行，失败时保留原归属，由下一次 bootstrap 重试；任何客户端或设置来源的变更都走同一路径，客户端在保存前请用户确认。

- 两个 profile 指向同一服务与账号时同样清理，切换后从空规则重新开始。profile 是清理边界，不先验证新身份。
- 同一 profile 下经 CLI 换账号仍按 ADR 0006 形成新连接键，不因外部 CLI 变化自动删除数据；这些数据在下次切换 profile 时一并清空。
- 插件 Project 内有用户自建工作区时，只删除插件自己的讨论并归档其工作区，保留该 Project 与占位目录，并提示用户。
- 旧版本 state 没有归属时采用当前 profile，升级时不删除；首次切换清空全部连接。

删除讨论使用 `deleteAgent`。Paseo 0.15.3、0.17.4 与 main 的处理均先 `closeAgent`（只调用 `session.close()`，不发中断）再删除存储，因此不会取消远端 Run；清理前 hold 这些讨论，拒绝竞争打开。`removeProject` 归档项目内的活跃工作区并删除注册记录。Paseo 没有删除工作区记录的接口，归档的工作区记录会残留在 daemon 中。占位目录中用户手动放入的文件随目录删除；已发出的评论或停止请求不能撤回。

## 考虑过的替代方案

- 保持现状，按连接键隔离并允许切回续用：与用户要求清理本机旧数据冲突。
- 新旧身份相同时跳过清理：需要在新 profile 可能离线时先验证身份，边界不可预期。
- 服务端 RPC 一次完成清理并写入设置：插件 API 不提供服务端写设置。
- 为每个 profile 调用 `/api/me` 以显示账号：会使用未选中 profile 的凭据。
