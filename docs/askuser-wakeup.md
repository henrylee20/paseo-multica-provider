# askuser 后台主动加载（#24）

后台完成 Thread 卡片与 Run 概要同步后，只为包含当前连接用户可答、未决、未本地收起且已核对完整 timeline 的卡片调用原生 `listCommands(agentId)`。所属 Multica 任务必须仍在启用的规则范围内；人工隐藏、自动归档、失权、归档处理中与讨论生命周期 hold 均阻止加载。原生 agent 与活跃 Paseo 工作区的身份也会重新核对。

此调用使用 SDK 的交互加载路径，未传 `purpose: "history"`。已加载的 provider 讨论通过生命周期订阅识别并跳过；未加载但包含远端活动 Run 的讨论仍可恢复问题。加载不调用 `refreshAgent`、不发送中断、不取消远端 Run，也不人为结束或替换聚合 turn。

同一连接／任务／Thread 的后台加载同时去重，尝试之间至少间隔 60 秒，失败同样限流。单个原生请求失败不会阻断其他 Thread 或任务的同步。明确点击「重新展开作答」后，RPC 重新核对卡片与身份；若原生宿主已释放空闲会话，则立即加载，保留隐藏、归档、权限与 hold 检查，不受后台重试间隔限制。

原生隐藏恢复和后台同步共用串行宿主操作队列，恢复持有 hold 时不会并行开始后台加载；provider 打开与提问 RPC 同时保留 hold 检查。模拟贡献边界测试暂停原生恢复，观察 `session.open` 被拒绝、提问重展被拒绝且没有新增 `listCommands` 或原生权限。

## 原生回放与注意力边界

固定核查的 Paseo 0.17.4 源码在初次打开至 `session.ready` 之间，将 `session.permission` 作为非 live 历史恢复：它恢复表单及待答状态，不广播历史注意力通知。`session.ready` 后到达的新卡片才走 live 路径，并由宿主注意力策略决定通知。首次后台发现卡片后主动打开，也可能进入这个初次打开的静默回放路径；本插件不声称能保证首次未打开 Thread 的系统推送。可读的卡片 title 与 description 已包含在原生 permission 中。

`tests/askuser-wakeup.test.ts` 只通过公开贡献／RPC／provider 边界和模拟原生宿主验证加载、权限事件、状态保护、限流、失败隔离及 Run 不受中断。测试观察初次权限先于 `session.ready`；已加载讨论新卡片在 ready 后发出权限。`needs_input` 由宿主根据待决权限推导，测试未运行真实侧栏、QuestionFormCard、注意力广播或操作系统通知。

本轮没有安装、reload 插件，没有连接真实 daemon，也没有读取或写入真实 Multica 服务。真实原生视觉与通知验收保留给 #26 的手动清单；模拟结果不能替代这些验收。
