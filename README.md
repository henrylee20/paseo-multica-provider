# paseo-multica-provider

将 Multica 工作区、任务与讨论映射到 Paseo 原生项目树，并查看评论与执行流、发表评论和停止远端执行。
支持自部署 Multica，默认只读复用 Paseo daemon 所在用户的 Multica CLI 登录上下文，包括服务地址与现有凭据。

当前已实现 CLI 连接切片 [#2](https://github.com/henrylee20/paseo-multica-provider/issues/2)：可安装的客户端与服务端贡献、CLI profile 选择及已验证连接状态。任务同步、原生会话与执行功能按 [规格 #1](https://github.com/henrylee20/paseo-multica-provider/issues/1) 继续实现。模拟服务测试与类型检查已通过；真实宿主和目标服务验收单独记录。

## 安装与连接

在 Paseo daemon 所在主机安装此目录，例如 `paseo plugin install /absolute/path/to/paseo-multica-provider`。插件 ID 为 `multica`；支持范围为 Paseo `>=0.15.3 <0.16.0`，开发 SDK 固定为 `0.15.4`。安装命令会执行 manifest 中的依赖安装步骤。

打开 Paseo 侧栏的 **Multica** 或设置中的 **Multica**。Profile 留空表示 CLI 默认 profile；填写名称选择 `~/.multica/profiles/<name>/config.json`。daemon 只读使用其运行用户的 CLI 配置，每次状态读取重新验证 `/api/me`，管理页每 10 秒刷新。通过 `multica setup` 与 `multica login` 管理登录；命名 profile 使用 `multica --profile '<name>' login`。

沿用 daemon 环境中的 `MULTICA_SERVER_URL`、`MULTICA_TOKEN`、`MULTICA_APP_URL`／`FRONTEND_ORIGIN` 覆盖。API 服务与前端地址分开处理，保留自部署端口。`MULTICA_TASK_CONFIG_ROOT` 改用任务私有配置目录；任务身份、daemon 端口和目录标记触发隔离，缺少必要注入时不会回退拥有者的登录。daemon 不会读取其他机器的 CLI 登录。

连接页面区分配置缺失、无法读取、损坏、未登录、鉴权失败和网络故障。凭据不会写入插件设置、RPC 或日志；登出、原子替换配置后不沿用旧凭据。空任务筛选配置不导入任务。

## 开发与验证

```sh
npm ci
npm run check
```

测试从服务端公开贡献入口读取临时 CLI 配置并请求本地模拟 HTTP 服务，覆盖默认／命名 profile、环境覆盖、隔离、配置错误、凭据轮换与移除以及连接身份。bundle 测试执行 Paseo 0.15 编译器的导出转换并加载两个贡献入口。它们不能替代实际 daemon 加载与真实 Multica 服务验收。

CLI 兼容依据为 Multica CLI 0.6.3 的固定提交 [`18fa9f7`](https://github.com/multica-ai/multica/tree/18fa9f728a9e25f2465df2789631edb2a75442ad)，包含 profile 路径、环境优先级、任务目录标记与 API URL 规范化规则。

## 文档

- [GitHub 规格正文](docs/github-spec.md)：已发布 issue 的本地副本，包含用户故事、实现决定和测试边界。
- [首版规格](docs/spec.md)：用户行为、映射关系和产品边界。
- [实现计划](docs/implementation-plan.md)：模块职责、实施步骤及验证要求。
- [术语表](GLOSSARY.md)：Multica 与 Paseo 概念的统一称呼。
- [设计访谈与证据](docs/design.md)：逐项决定、源码约束与验收场景。

## 架构决定

- [0001：以 Thread 为会话边界](docs/adr/0001-thread-as-paseo-session.md)
- [0002：现有 Paseo 与占位目录](docs/adr/0002-use-existing-paseo-with-placeholder-directories.md)
- [0003：Run 的唯一展示归属](docs/adr/0003-unique-run-display-ownership.md)
- [0004：原生中断停止远端执行](docs/adr/0004-native-interrupt-stops-remote-run.md)
- [0005：保留原生评论历史](docs/adr/0005-preserve-native-comment-history.md)
- [0006：隔离连接身份](docs/adr/0006-isolate-connection-identities.md)
- [0007：仅在去重保证下自动重试](docs/adr/0007-retry-comments-only-with-deduplication.md)
- [0008：复用 Multica CLI 登录](docs/adr/0008-reuse-multica-cli-authentication.md)
