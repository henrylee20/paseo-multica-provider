# 保留原生评论消息并追加更正记录

Paseo 外部 provider 协议不支持按稳定 ID 原位修改或删除原生 `user` / `assistant` 历史消息（Timeline transformer 也拿不到行级来源身份且不改写持久化记录）。插件选择保留原生对话体验：以首次读取快照发出原生消息，相邻原生评论之间插入独立的 `comment-divider` 分隔细线，远端后续发生的评论编辑、删除与系统状态变化统一追加为稳定 ID 的 `comment-event` 插件条目（超长正文经 `thread.event` 按需读取），不原位替换原始消息，也不虚构首次导入前未曾观测到的旧版本。评论的编辑与删除仍在 Multica 完成。

任务描述采用稳定 ID 的 `task-description` 插件行与有界 `revision` / `offset` 分页读取，由 provider 订阅直接推送更新。讨论输入框通过本地校验后，在 `prompt_result` 之前乐观发出携带 `clientMessageId` 的原生 `user_message`；远端发送成功后记录 `clientMessageId → commentId / rootId` 映射以消除同步回声重复，发送失败则保留该原生输入并追加一条错误。

## 影响与边界

- **本地发送附件的原文**：成功回执持久化原正文及附件元数据，原生本人回声仅使用该正文，`history:skip` 不放宽全文检查。附件复用版本 1 的 `comment-delivery` 插件行展示，并由成功缓存补发；主讨论保留旧 `multica:thread-created:<clientMessageId>` ID 与 `{}` 解析，回复附件使用 `multica:comment-attachments:<clientMessageId>`。发送端的宿主药丸与插件行可同时显示，其他评论仍沿用正文附加附件链接。远端在首次同步前改动已确认的发送正文，也追加更正而不覆盖成功原文。
- **跨重启 `history:skip` 完整分页核对**：核查 Paseo `0.17.4` 源码确认，宿主普通消息的 item ID 去重仅存在于单次 provider 会话内存中，只有工具与插件条目具备跨重启持久身份合并。因此 `history:skip` 恢复时仍须通过 `fetchAgentTimeline` 完整分页读回所属 native agent，逐条比对来源 `messageId` 或本人 `clientMessageId`、角色及全文，仅在全页读取成功且无缺口或冲突时补发尚未落盘的缓存原文，防止漏消息或盲目重放造成重复。
- **归档与离线历史阅读**：筛选退出、规则停用或远端删除/失权的任务统一依赖宿主原生归档历史及本地已读缓存（含任务描述与 AskUser 卡片缓存）离线阅读，不维护独立的只读快照浏览器；仅在切换 CLI profile 时按 [ADR 0010](./0010-clear-local-data-on-profile-switch.md) 一并清理前一 profile 的缓存与原生讨论。
