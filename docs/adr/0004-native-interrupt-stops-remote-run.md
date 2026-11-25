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

## 显式发送模式的宿主边界（#12）

公开 `ProviderPrompt.delivery` 只有 `auto | steer`，不含 `interrupt`、`queue` 或宿主内部的 `expectedTurnId`。因此 provider 无法从单条 prompt 反推出用户点击了哪个控件，也不新增插件队列。默认运行中普通发送仍以 `prompt.steer` 仅确认输入接收，不向 Multica 提交强制 steering。

显式 interrupt 由宿主先运行取消路径，等待原生停止确认，再发送普通 `auto` prompt。取消不被确认时，实际 0.15.3 的替换请求返回 `Cannot replace agent … because its active run cancellation was not acknowledged`，不进入 provider 投递接收。provider 保持逐项真实停止结果及失败活动，不能为让新评论继续发表而伪造成功。母任务在更新宿主前已通过实际 0.15.3 SDK 验证该顺序；这不是原生视觉控件验收。

固定 Paseo 源码的 `queueComposerMessage` 将输入保留在客户端；`HostRuntime.drainQueuedAgentMessage` 在该 agent 活动转为空闲时，只释放队首，并以 SDK `activeTurnBehavior: steer` 发送。全部属于 tab 的 Run 终结才结束聚合 turn；其他 tab 的活动不影响它。若释放时新自主 turn 已开始，host 以 steer 接收，provider 返回此新周期的 UUID。空闲时则是普通 `auto` prompt。`sendQueuedComposerMessageNow` 的手动立即发送使用普通 composer 路径，按当前设置选择 steer 或 interrupt，不能一概称为不中断的队列释放。

上述客户端队列不是 Multica 的 queued Run，也不是插件已持久接收的投递。原生队列释放以接收为界；接收后的远端错误由稳定投递记录报告，不回头把评论已保存或 Run 已触发当作队列成功的定义。Paseo 客户端负责原生队列的存储、编辑和恢复。

`tests/send-modes.test.ts` 从贡献注册入口驱动真实 provider/RPC，观察模拟 Multica 的评论和取消结果：普通接收不取消；显式中断的固定多 Run 集合及其后的单次同 Thread 投递；HTTP 503 与 HTTP 200 仍活动的部分失败；聚合空闲后的队列释放输入；新周期抢先开始后的接收及保存失败。测试明确只验证宿主发出的公开输入序列，不模拟出一个声称真实原生队列的插件实现。目标宿主原生 queue 控件与视觉验收仍未验证，不能据此标记完成。

## 修订：直接停止当前 Run（OPT-07）

取消停止记录、进程清理追踪、跨会话单 Run 重试和投递 epoch 栅栏。原生 Stop 固定当前讨论的活跃 Run 集合并逐项取消，成功后结束捕获的宿主 turn，部分失败直接返回原生请求错误，由用户再次点击 Stop。保留并发出现的新 Run 的独立活动周期，以及清理时等待已经接受的停止请求。

AskUser 回答、回答重发与远端跳过同样取消 receivedEpoch／Stop epoch 栅栏；Stop 仅本地收起待答权限，不代表远端跳过，也不撤回已经在途的回答。
