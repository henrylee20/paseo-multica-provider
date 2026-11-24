# 原生中断停止远端执行

Paseo v0.15.4 的原生停止与关闭运行中 tab 使用同一个不携带原因的中断请求，因此在不修改 Paseo 核心的条件下，provider 无法分别处理二者。
用户选择保留原生停止体验，将原生中断连接到 Multica 的运行取消操作，并接受关闭运行中 tab 也会停止对应远端执行；不采用独立插件停止入口来替代原生停止。
workspace 归档、空闲资源释放与连接关闭仍仅处理本地展示或资源，不因单纯的 session.close 而取消远端 Run，也不删除 Multica 任务或讨论串。

停止范围是操作发生时归属当前 tab 的全部未结束 Run，包括等待执行的 Run；不取消其他 tab 的 Run，也不修改已结束的历史记录。
一个跨 Thread 的 Run 作为整体取消，无法只取消它处理的某一条讨论。

部分取消失败时逐项显示真实结果，原生停止报告失败；即使关闭继续完成归档，管理页仍保留失败告警与重试入口，不自动重新打开已关闭 tab，也不宣称所有 Run 已停止。

#9 在已打开的 provider 会话上处理真实 `session.interrupt`，先在一个持久事务中固定该讨论当时归属的 queued、dispatched、running、waiting_local_directory、deferred Run ID，并推进讨论的停止 epoch；随后逐项调用 `POST /api/issues/{issueId}/tasks/{runId}/cancel`。不使用 agent 全量取消，也不因后台发现新 Run 扩大本次集合。每项响应校验 Issue 与 Run 身份，使用实际返回状态；completed／failed 的完成竞态保持原样，HTTP 或格式失败不阻止继续处理集合中其他项。

停止回执与缓存 Run 状态在同一事务保存；旧快照不能使已经终结的同一 Run 回到活动状态，终态之间的后续核对仍允许更新。管理页分别显示最后已知任务状态与进程清理证据：pending、unconfirmed、明确 confirmed 或 unknown；缺字段和普通 HTTP 成功都不是清理确认。远端任意 result 正文不进入停止记录。原生停止有未确认项时返回 `request.failed`，记录与单 Run 重试入口跨 tab 关闭、插件重启及 CLI 离线保留，重试不恢复任何本地对象。普通会话生命周期、整 workspace 归档、筛选退出和贡献清理不创建取消请求；贡献清理只等待已经接受的停止操作完成。

真实 0.15.3 宿主在调用中断前捕获原 turn 的 settlement promise。成功中断后若该 promise 两秒未结束，宿主会强制取消当前 turn；若继续复用原聚合 turn 展示后来出现的 Run，原生活动会永久丢失。因此 provider 也在中断开始前捕获 turn ID，只在固定取消集合全部确认终结后完成仍匹配的原 turn，并在返回 `request.completed` 前用新 UUID 展示剩余活动 Run。宿主按序处理 terminal／started 事件，原 promise 可独立结束，后续活动保留。原生 turn 的结束仅表示本次聚合边界，不声称后来 Run 已取消，也不代表进程清理确认；部分失败不走此成功结束路径。

每个连接／Issue／讨论的 `stopEpochs` 是 #10／#11 投递工作的持久栅栏。投递应在原生接收时保存 epoch，并在持久领取待发送或重试工作时通过 `StopCoordinator.guardDelivery` 校验；停止推进 epoch 后，旧待投递不能重新触发执行。该接口只提供停止协调，不在 #9 内构造评论投递或自动重试，也不承诺撤回已经发出的远端请求。

公开贡献测试覆盖原生 provider 中断、多 Run 与跨 Thread 归属、并发发现后的固定集合、终态竞态、旧活动快照、部分失败、归档后持久告警及不恢复 tab 的单项重试，以及纯生命周期不取消；编译后的管理页验证停止结果和重试动作。真实 Paseo 0.15.3 原生停止／关闭与目标 Multica 服务验收由母工单单独保留证据，不以模拟宿主测试替代。
