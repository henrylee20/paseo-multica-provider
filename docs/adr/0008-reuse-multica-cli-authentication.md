# 复用 Multica CLI 的登录上下文

为同时支持官方云服务与自部署实例且免去用户维护独立插件 PAT，插件在 Paseo daemon 侧只读复用运行用户已有的 Multica CLI 登录上下文，不改写 CLI 配置文件、不自动发起浏览器登录，也不将凭据复制到插件持久状态或 RPC 响应中。

配置解析严格对齐 Multica CLI `0.6.3`：遵循 `MULTICA_SERVER_URL`、`MULTICA_TOKEN`、`MULTICA_APP_URL` / `FRONTEND_ORIGIN` 环境变量覆盖及 `MULTICA_TASK_CONFIG_ROOT` 与任务上下文隔离标记（受隔离且缺少显式注入时拒绝读取拥有者 `~/.multica`）；API `server_url` 与界面链接 `app_url` 分开使用，不设硬编码云地址回退。配置文件按 `mtime` 与大小做内存缓存，`/api/me` 身份核验结果最多复用 60 秒并在配置变化或 `401`/`403` 时失效。

## 影响与边界

- **按目录布局只读枚举 CLI profile**：Multica CLI `0.6.3` 没有列出 profile 的公开命令，也不保存全局 active profile。按 [ADR 0010](./0010-clear-local-data-on-profile-switch.md)，插件通过只读扫描 `<配置根>/config.json` 与 `<配置根>/profiles/*/config.json` 供设置页下拉框选择（`token` 非空且 `server_url` 有效，名称须通过设置 schema；任务隔离上下文直接返回空列表且不发请求），仅以各 profile 自身凭据只读调用其自身服务的 `/api/me` 读取显示名，显示名与登录判定仅在内存缓存。该枚举依赖 CLI `0.6.3` 的目录结构，若未来 CLI 调整存储布局需同步适配。
