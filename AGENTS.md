# AGENTS.md

Paseo 源码插件（插件 ID：`multica`），将 Multica 工作区、Issue、Thread 与 Agent Run 映射为 Paseo 原生层级与会话。宿主版本要求 `>=0.15.3`，开发 SDK 固定 `0.15.4`；输入框提及选择器需 `0.16.0+`，Run 子代理视图在 `0.15.x` 桌面端未验证且无旧执行段后备。

## 常用命令

- `npm run check`：运行 `tsc --noEmit` 与 `vitest run`（提交与修改必过；`dist/` 不参与检查）。
- `npm run build`：通过 `scripts/build.mjs` 生成源码插件目录 `dist/paseo-multica-provider-<version>/`、`.tar.gz` 与 `.sha256`。切勿用 `npm pack` 替代（会漏掉 manifest `npm ci` 所需的 `package-lock.json`）。

## 文档导航（按需读取）

- [`GLOSSARY.md`](./GLOSSARY.md)：领域词汇与反模式（区分 Multica 工作区 vs Paseo 工作区、Paseo 项目 vs Multica 项目等）。编写界面文案、RPC 命名、测试描述或文档前先核对。
- [`docs/spec.md`](./docs/spec.md)：当前产品行为的唯一权威规格，涵盖身份隔离、筛选归档、评论发送与回声、AskUser 表单与唤醒、Run 子代理与停止、后台同步恢复及数据重建。修改业务行为、状态流转或协议契约时读取。
- [`docs/design.md`](./docs/design.md)：上游固定版本源码核查证据（Paseo `0.15.3`/`0.15.4`/`0.17.4` 与 Multica CLI `0.6.3` / 服务端固定提交）。修改原生宿主交互、Provider 事件流、时间线恢复或 CLI 配置解析前读取。
- [`docs/adr/README.md`](./docs/adr/README.md)：12 份不可逆架构决策与被拒替代方案（`0001`–`0012`）。调整会话边界、占位目录、Run 展示归属、Stop 范围、历史回扫、连接/Profile 隔离、提及选择器、Run 子代理或数据重建前读取。
- [`docs/acceptance.md`](./docs/acceptance.md)、[`docs/askuser-acceptance.md`](./docs/askuser-acceptance.md)：已执行的真实云/宿主验收矩阵、尚未验证边界与 `#26` AskUser 待执行手动验收清单。更新验收结论或声称端到端已验证前读取。

## 模块职责地图

- **入口与构建契约**
  - `index.server.ts`、`index.client.tsx`：Paseo 编译的服务端与客户端贡献入口。Paseo 0.15 会即时捕获导出，入口须保持顶层提升的 `export default function contribute(...)`（由 `tests/bundle.test.ts` 验证）。
  - `scripts/build.mjs`：打包发布目录与归档白名单。增删根目录文件或调整 `docs/` 结构时同步更新白名单。
- **共享契约（`shared/*`）**
  - 客户端与服务端共用的 Zod RPC 定义、设置 schema、时间线插件行 schema 与活跃 Run 分类。
- **客户端（`client/*`）**
  - `connection-screen.tsx`、`workspace-list.tsx`、`workspace-rule.tsx`、`data-rebuild.tsx`、`hidden-objects.tsx`、`sync-status.ts`：设置页（连接与 CLI profile 切换确认、工作区筛选与只读预览、数据重建、人工隐藏恢复）；侧边栏顶部快捷入口在 `index.client.tsx` 通过 `addSidebarHeaderItem` 打开同一设置页。
  - `mention-picker.tsx`：Paseo `0.16+` 输入框 `multica-mention` 选择器，读取 agent `metadata` 中的连接与任务标识并插入带 ID 的 canonical 引用。
  - `task-description.tsx`、`thread-events.tsx`、`askuser-card.tsx`、`delivery-status.tsx`、`chunked-text.ts`：注册 6 类时间线 renderer（`task-description`、`thread`、`comment-divider`、`comment-event`、`askuser`、`comment-delivery`）。
- **服务端（`server/*`）**
  - **鉴权与状态**：`connection.ts`（只读复用 CLI 配置与目录枚举、mtime/大小缓存、60 秒 `/api/me` 缓存、环境变量覆盖、任务上下文隔离、请求级撤销信号 `assertCurrent`）；`state.ts`（位于 `PASEO_HOME/multica-provider` 的原子落盘 `StateStore`，返回只读快照，通过 `state.owner.profile` 追踪数据归属）。
  - **原生宿主与同步生命周期**：`native-host.ts`（从 `PASEO_HOME/paseo.pid.listen` 连接并比对 `serverId` 后调用底层 `DaemonClient`，含防唤醒保护 `restoreWorkspacePreservingHidden`）；`sync.ts`（`SidebarSynchronizer`：15 秒轮询 + `workspace-events.ts` WebSocket 失效触发、独立短队列保存规则、规则版本淘汰旧快照、空 Project 移除与重建外壳迁移、切换 profile 可续跑清理）；`rebuild.ts`（`DataRebuild`：串行暂停同步并按 `deleteAgent` → `archiveWorkspace` → `removeProject` 重建当前连接数据，持久化递增 `rebuildGeneration`）；`hiding.ts`（区分 `archiveReason` 自动归档与人工隐藏 hook）；`discussion-lifecycle.ts`（本地资源 `hold` 门禁）；`discussion-metadata.ts`（首次成功前在 bootstrap 扫描补齐标签到 `metadata` 的镜像，导入与恢复单独写入）。
  - **Provider、讨论、执行与提问**：`provider.ts`（协商 `session.subsession`，`DiscussionOrder` 按来源评论与创建时间交错排定 AskUser 卡片与 Run 标记首次输出，`prompt_result` 前乐观发出 `user_message`，`history:skip` 委托 `projection-recovery.ts` 完整分页核对原生原文）；`threads.ts`、`delivery.ts`（先发现卡片再投递评论分页、相邻评论 `comment-divider`、同 `Idempotency-Key` 最多 3 次发送、成功 `clientMessageId` 回声映射）；`runs.ts`、`run-details.ts`、`run-projection.ts`、`stops.ts`（五类关联 + RFC3339Nano 首次固定 `ownerRootId`、已打开讨论按需每 2 秒补读活跃 Run 明细、只读子会话与静态 `sub_agent` 位置徽章、固定快照逐项取消与聚合 turn UUID 轮换）；`askuser*.ts`（同源 64 KiB `askuser.json` 持久缓存、完整 `timeline` 终态核对、`QuestionFormCard` 映射与全选填文本「提交确认」题、`listCommands` 无中断后台加载及原生注册完成后 live 公布新权限）。

## 核心不变量与宿主红线

- **不修改宿主核心与内部文件**：所有项目、工作区、agent 生命周期仅通过公开插件 SDK 与经 `serverId` 校验的 `DaemonClient` 接口驱动。
- **凭据只读且严格隔离**：绝不将 CLI Token 写入 `StateStore`、RPC 响应或日志；枚举未选中 profile 时不调用 `/api/me`；每次远端读写前执行 `assertCurrent` 核对当前 profile 与身份；检测到任务隔离上下文且缺少显式注入时拒绝读取拥有者 `~/.multica`。
- **本地生命周期绝不误杀远端 Run**：单纯 `session.close`、筛选退出/停用归档、切换 profile 清理（`deleteAgent`）及数据重建（`deleteAgent` → `archiveWorkspace` → `removeProject`）仅释放或清理本地记录，不发送 `session.interrupt`、不调用会对活跃会话发中断的 `archiveAgent`。只有显式 `session.interrupt`（原生 Stop 或关闭运行中 tab）才取消当时归属该讨论的活跃 Run 快照。
- **严防 Paseo 宿主的隐式副作用**：
  - 恢复 Paseo 工作区前必须对未选定解除隐藏的讨论持有 `DiscussionLifecycle.hold()`，在恢复后安全重归档（Paseo `0.17.4` 恢复工作区存在 60 秒时间戳回退，会唤醒同工作区隐藏讨论）。
  - `refreshAgent` 对运行中会话会先触发中断，仅可用于已确认归档的 agent；恢复活跃工作区前须完整分页核对 `fetchWorkspaces`（宿主不按 `idPrefix` 过滤）。
  - `history:skip` 恢复必须完整分页读回 `fetchAgentTimeline` 核对来源 `messageId`/`clientMessageId`、角色与全文（宿主普通消息 ID 去重仅在单次 provider 会话内存中生效，不跨重启保留）。
  - 聚合活动 turn 每次从空闲进入活动或跨过成功 Stop 边界都必须生成新 UUID（复用已完成 turn ID 会被宿主忽略后续完成事件）。
  - 父讨论关闭时只清理本地子会话映射，不主动发送子会话 `session.closed`（避免宿主将运行中子代理误标为 `completed`）。
- **诚实标注验证层级**：`tests/*.test.ts` 通过公开贡献、provider、RPC 与 `paseo-esbuild` 编译产物边界测试行为；隔离/模拟测试通过不得表述为真实 Paseo 宿主 UI 或真实 Multica 服务已验收。
