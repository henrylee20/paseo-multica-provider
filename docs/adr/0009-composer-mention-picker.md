# 输入框提及选择器使用 composer item 并镜像讨论身份

Paseo 的 `@` 候选由宿主固定为工作区文件引用，插件没有替换或扩展它的接口；要原生用 `@` 选择 agent 只能修改 Paseo 核心。选择器因此使用 Paseo 0.16 起的 composer item：在讨论输入框注册「提及 Agent」，选中后插入带 agent ID 的 canonical 引用，发送仍走既有投递路径，由 Multica 解析提及并决定是否启动 Run。

composer item、`useComposer`、`Combobox` 与 agent `setMetadata` 同属 Paseo 0.16 的首个插件 API。选择器只在 `addComposerItem` 存在时注册；开发 SDK 固定 0.15.4，manifest 继续只声明 `>=0.15.3`，0.15 宿主不显示选择器，管理页保留复制引用。没有为此提高最低宿主版本，也没有修改 Paseo 核心。

composer 只向插件暴露 agent 的 metadata，不暴露 agent ID 或 labels。daemon 因此在客户端每次 bootstrap 时，把各讨论 tab 的 `multica.connection` 与 `multica.issue` 标签镜像进 agent metadata：按连接分页读取宿主能返回的目录（含归档 agent；归档 workspace 的 agent 会被宿主目录省略，恢复后下一次 bootstrap 补齐），只补缺失或与标签不一致的副本；失败不阻塞也不使 bootstrap 失败，下一次 bootstrap 重试；宿主没有 `setMetadata` 时本进程停止尝试。选择器只在该 metadata 存在时出现。

引用必须是 `[@名称](mention://agent/<id>)`，裸 `@名字` 不能确定同名身份，因此选择器同时显示 agent ID。引用是普通 Markdown 文本，用户编辑后可能不再触发执行；评论保存与 Run 启动仍分别报告。选择器不是 `@` 弹出菜单，宿主文件候选保持不变；已在用户主 daemon 的 0.17.4 宿主上完成真实选择、插入与发送，评论保存并触发 Run，随后 Stop（见 [交付验收记录](../acceptance.md)）；移动布局与原生溢出面板仍未验证。

考虑过的替代方案：修改 Paseo 核心增加 mention source（需要用户长期维护宿主分支）；把最低版本提高到 0.16.0（0.15 仍可回退复制引用，没有必要放弃兼容）；在占位目录放 agent 文件让宿主 `@` 列出（插入的是带引号的文件路径、污染工作区，且不显示 agent 身份）。
