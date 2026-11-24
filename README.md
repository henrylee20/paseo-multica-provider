# paseo-multica-provider

将 Multica 工作区、任务与讨论映射到 Paseo 原生项目树，并查看评论与执行流、发表评论和停止远端执行。
支持自部署 Multica，默认只读复用 Paseo daemon 所在用户的 Multica CLI 登录上下文，包括服务地址与现有凭据。

当前状态：27 项产品决定及自部署、CLI 登录复用补充已获整体确认；已通过 `/to-spec` 发布 [规格 issue #1](https://github.com/henrylee20/paseo-multica-provider/issues/1)，标记为 `ready-for-agent`。尚未实现插件或完成运行验收。

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
