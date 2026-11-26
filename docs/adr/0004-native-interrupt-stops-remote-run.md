# 原生中断停止远端执行

Paseo 的原生 Stop 按钮与关闭运行中讨论 tab 共用同一个不带原因字段的 `session.interrupt` 请求，provider 在不修改宿主核心的前提下无法区分二者。插件选择保留原生停止体验：将 `session.interrupt` 映射为取消操作开始时归属该讨论的全部活跃 Run（`queued`、`dispatched`、`running`、`waiting_local_directory`、`deferred`），并接受关闭运行中 tab 也会取消该讨论当时的活跃 Run；不另设自定义停止面板替代原生按钮。

单纯的 `session.close`、整 Paseo 工作区归档、筛选退出、切换 profile 的 `deleteAgent` 与数据重建仅释放或清理本地资源，绝不发送远端取消请求；插件卸载清理仅等待已接收的 Stop 请求完成。

## 影响与边界

- **取消粒度与竞态**：逐项调用单任务取消接口，不使用 agent 级全量取消，也不扩大到其他 tab 或中断开始后新出现的 Run；跨多个 Thread 的同一 Run 作为整体取消。若取消与远端自然完成发生竞态，保留服务端返回的实际终态（`completed` / `failed`），且旧活动快照不能覆盖已终结的 Run；任一项取消失败直接返回 `request.failed`，不伪造成功应答（否则宿主会单方面强制将 turn 标为 `canceled`），用户可再次点击 Stop。HTTP 取消成功不证明远端执行进程已物理退出。
- **运行中发送模式边界**：公开 `ProviderPrompt.delivery` 仅有 `auto | steer`。运行中普通发送通过 `steer` 接收输入并发表普通评论（返回接收时捕获的宿主 turnId，避免被外部适配器当作不可用而触发中断替换），交由 Multica 合并或排队；显式 `interrupt` 由宿主先执行取消并在确认后发送 `auto` prompt；显式 `queue` 由 Paseo 客户端暂存，待聚合 turn 空闲后释放。
- **对 AskUser 卡片的影响**：点击原生 Stop 仅在本地收起待答提问表单，不会触发远端跳过，也不会撤回已在途的评论或回答。
