# 按服务与用户身份隔离本地映射

Status: partially superseded by [ADR 0010](./0010-clear-local-data-on-profile-switch.md)

评论投影为原生 `user` 或 `assistant` 取决于当前登录用户，而宿主持久化历史无法事后改写消息角色。插件因此以规范化 API `server_url` 与 `/api/me` 返回的真实 `user.id` 组成 `connectionKey` 隔离本地对象映射（Token 值与 profile 名称不参与计算连接键）：同一 CLI profile 下同服务同账号轮换 Token 继续复用原有 project / workspace / 讨论映射；同一 profile 下通过外部 CLI 更换服务或账号则建立新的连接键并从空规则开始，历史角色、`ownerRootId` 与人工隐藏留在原连接下。

每次远端请求在发出前通过内存撤销信号 `assertCurrent` 重新核对当前所选 profile 及有效 CLI 服务地址与凭据（CLI 文件按 `mtime` 与大小缓存解析，`/api/me` 结果最多缓存 60 秒并在配置变化或 `401`/`403` 时立即失效），确保旧连接绝不借用新登录身份发表评论、回答/跳过卡片、取消 Run 或补读远端明细。

## 影响与边界

- **跨 CLI profile 切换改为清空旧数据**：早期设计曾允许切换 CLI profile 后保留旧连接以便切回续用；该约定已被 [ADR 0010](./0010-clear-local-data-on-profile-switch.md) 取代——切换 CLI profile 时统一清空前一 profile（含其下曾累积的全部连接）在本机的映射、规则、缓存、原生讨论与占位目录。`connectionKey` 隔离与发送前身份校验仍用于防在途串号及处理同一 profile 内的外部 CLI 换号。
