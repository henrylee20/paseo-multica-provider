# 复用 Multica CLI 的登录上下文

用户要求支持自部署 Multica，并在本机 CLI 已登录时直接使用该登录态，因此插件默认在 Paseo daemon 侧只读解析 CLI 的有效服务地址与现有凭据，不另建登录、不生成另一枚 PAT，也不把凭据复制到插件配置。
默认选择 CLI 默认 profile，命名 profile 可显式选择；遵循 CLI 的环境覆盖和任务隔离规则，将 API 地址与凭据作为同一个上下文读取，前端 app_url 单独用于界面链接。
CLI 配置变化时重新读取并验证身份，同服务同账号的凭据轮换续用映射，换服务或账号按独立身份处理；没有可用登录或凭据失效时引导通过 CLI 登录，不自动回退云服务或改写 CLI 配置。

## 修订：进程内缓存（OPT-13）

每次使用仍检查 CLI 配置文件的 mtime 与大小，未变时复用解析结果；任务标记探测结果在进程内复用。身份验证结果最多复用 60 秒，配置变化或远端 401／403 后重新验证。工作区 slug 保存在已有项目映射中，Thread 与 Run 读取无需再为它查询工作区目录；不复制或持久化任何凭据。

## 修订：按目录布局枚举 CLI profile（ADR 0010）

Multica CLI 0.6.3 不提供列出 profile 的命令，也不保存全局 active profile。按 [ADR 0010](./0010-clear-local-data-on-profile-switch.md)，插件通过只读枚举 `<配置根>/config.json` 与 `<配置根>/profiles/*/config.json` 供设置页下拉框选择（遵循 `MULTICA_TASK_CONFIG_ROOT`，名称须通过插件设置 schema；任务隔离上下文直接返回空列表，不读取拥有者 `~/.multica`）。该枚举属于对 CLI 0.6.3 目录布局的推断而非 CLI 公开命令契约；仅检查 `token` 与有效 `server_url`，不向 RPC 返回凭据，也不使用未选中 profile 的 token 访问 `/api/me`。
