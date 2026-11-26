# 输入框提及选择器使用 composer item 并镜像讨论身份

Paseo 输入框内置的 `@` 弹出候选固定为工作区文件引用，不向插件开放扩展接口。插件因此采用 Paseo `0.16` 引入的 `addComposerItem`、`useComposer` 与 `Combobox`：在讨论输入框注册「提及 Agent」（`multica-mention`），选中后向光标处插入带身份 ID 的规范引用 `[@名称](mention://agent/<id>)`（列表中同时展示 agent ID 以区分同名智能体），发送仍走普通评论投递路径。选择器仅在宿主支持 `addComposerItem` 时注册，manifest 保持 `>=0.15.3` 下限，`0.15.x` 宿主不显示该选择器。

由于 `useComposer` 只向客户端暴露当前 agent 的 `metadata` 而不暴露 `agentId` 或 `labels`，daemon 将各讨论 tab 的 `multica.connection` 与 `multica.issue` 标签镜像写入 agent `metadata`：进程内首次 bootstrap 分页扫描补齐存量讨论（成功后不再重复全量扫描，失败则在后续每 10 秒的 bootstrap 机会重试；宿主不支持 `setMetadata` 时停止尝试），新导入与恢复讨论时单独写入。选择器仅在这两项 `metadata` 齐备时渲染。

## 考虑过的替代方案

- **修改 Paseo 核心扩展 `@` mention source**：需要用户长期维护自定义宿主分支，违背不改核心约束。
- **将 manifest 最低宿主版本提高到 `0.16.0`**：阻断 `0.15.x` 宿主使用其余核心同步与讨论能力。
- **在本地占位目录生成同名文件借用宿主 `@` 菜单**：插入的是带引号文件路径而非 Multica mention 链接，既污染目录又无法传递 agent ID。
