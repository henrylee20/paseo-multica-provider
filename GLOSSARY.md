# Paseo–Multica

用于在 Paseo 中呈现 Multica 任务的领域语言。两个产品中的 workspace 与 project 含义不同，始终使用带产品名称的完整称呼。

## Language

### 对象映射与目录

**Multica 工作区（Multica workspace）**：
Multica 任务所属的协作范围，对应 Paseo 中归集这些任务的 Paseo 项目。
_Avoid_: 未指明产品的 workspace、Paseo 工作区

**Paseo 项目（Paseo project）**：
同一个 Multica 工作区在 Paseo 中的任务分组容器。
_Avoid_: Multica 项目、Multica 任务、Paseo 工作区

**Multica 项目（Multica project）**：
Multica 内归集任务的项目维度，在本集成中作为筛选条件与概览信息，不对应 Paseo 项目。
_Avoid_: Paseo 项目、Multica 工作区

**Multica 任务（Issue）**：
Multica 中需要完成的一项工作，包含目标描述、讨论、负责人和任务状态。
_Avoid_: API task、Thread、执行过程

**Paseo 工作区（Paseo workspace）**：
一项 Multica 任务在 Paseo 中的本地工作单元。
_Avoid_: 未指明产品的 workspace、Multica 工作区、Paseo 项目

**本地占位目录（Placeholder directory）**：
为满足 Paseo 交互式工作区要求而在 daemon 主机创建的非 Git 本地目录，不代表 Multica 远端代码仓库。
_Avoid_: 远端代码仓库、Git 工作树

### 讨论、消息与提问

**任务讨论串（Thread）**：
一项 Multica 任务内以一条顶层评论为起点的讨论及其全部后代回复，在 Paseo 中对应一个 agent tab。
_Avoid_: Multica 任务、本地主讨论、执行过程

**本地主讨论（Local main discussion）**：
每个 Issue 在 Paseo 中承载任务概览、任务描述、Multica 平台生成的顶层系统评论和无评论关联 Run 的本地会话，本身不对应远端 Multica Thread。
_Avoid_: Multica Thread、任务的全部讨论

**讨论会话（Discussion session）**：
一个讨论（任务讨论串或本地主讨论）在 Paseo 中被打开后的 provider 会话，负责该讨论时间线的发出顺序、可写性守卫与活动 turn 生命周期；关闭会话只释放本地状态，不影响远端 Run。
_Avoid_: Paseo 工作区、agent tab、Run 子代理

**评论（Comment）**：
讨论中的一条有作者的发言，在 Paseo 中呈现为原生对话消息。
_Avoid_: 工具调用、执行过程、评论更正记录

**评论更正记录（Comment correction）**：
已导入评论在 Multica 被编辑或删除后追加的独立时间线通知，保留原始消息并说明后续变化。
_Avoid_: 原位替换、新的参与者评论

**Agent 提及（Agent mention）**：
评论中以稳定 agent ID 指向某个 Multica agent 的规范化引用，供 Multica 判断是否触发该 agent 执行。
_Avoid_: 裸 `@名字`、宿主文件引用、执行成功

**评论投递（Comment delivery）**：
一条 Paseo 输入提交保存为远端 Multica 评论的过程；评论已保存与智能体已开始执行是两个独立结果。
_Avoid_: Agent run、执行成功

**结构化提问卡片（AskUser card）**：
Multica 评论附件携带的一组结构化问题，具有待答、已答或已跳过状态；本地收起表单与远端跳过卡片是不同状态。
_Avoid_: Run、Thread、普通聊天、停止执行

### 执行与展示归属

**执行过程（Agent run）**：
智能体围绕一项任务的一次远端执行活动（API 中的 `AgentTask`），可关联零个、一个或多个讨论串；每次重跑产生新的独立 Run。
_Avoid_: Thread、Comment、同一 agent 多次执行的合称

**展示归属（Run display ownership）**：
一个 Run 的子代理唯一从属且首次确定后不再迁移的讨论（某个任务讨论串或本地主讨论）；不表示该 Run 仅处理该讨论串的输入。
_Avoid_: 所有参与讨论串、远端运行所有权

**Run 子代理（Run subagent）**：
一个 Run 在所属讨论下的只读原生子会话呈现，承载该次执行的智能体身份、状态、运行文本、工具调用及错误信息。
_Avoid_: 执行段、独立 tab、评论

**Run 位置标记（Run marker）**：
所属讨论时间线中标明一个 Run 出现位置的静态徽章，仅标识执行者与触发来源，不反映实时运行状态。
_Avoid_: Run 实时状态、执行段、可展开的执行内容

### 连接、筛选与生命周期

**Multica 连接（Connection）**：
Paseo 与特定 Multica 服务地址及单一 Multica 用户身份绑定的连接上下文，是判定“本人评论”和隔离本地映射的基准。
_Avoid_: Multica 工作区、Paseo 工作区、CLI profile 名称

**Paseo 映射对象（Mapped Paseo objects）**：
插件按 Multica 映射在 Paseo 中生成的原生讨论、Paseo 工作区、Paseo 项目及本地占位目录；不含本地映射记录，也不含用户自建的 Paseo 工作区。
_Avoid_: Multica 映射数据、本地映射、插件原生足迹

**CLI 登录上下文（CLI login context）**：
daemon 主机上 Multica CLI 当前有效的服务地址、登录凭据与配置来源；命名 profile 用于区分不同的本地 CLI 登录环境。
_Avoid_: 独立插件账号、客户端机器登录、浏览器 Cookie

**任务筛选规则（Task filter）**：
按 Multica 工作区配置的动态收录条件，决定哪些匹配的 Multica 任务进入 Paseo 展示。
_Avoid_: 手动选中列表、固定任务清单

**人工隐藏（Manual hide）**：
用户通过关闭讨论 tab 或归档 Paseo 工作区表达的持久本地隐藏意愿，优先于筛选规则的自动导入，直至用户显式恢复。
_Avoid_: 远端删除、任务完成、自动退出筛选范围

**原生归档（Native archive）**：
Paseo 中保留本地历史记录但移出活跃侧边栏的生命周期状态；归档整个 Paseo 工作区不取消远端执行。
_Avoid_: 远端删除、远端停止、物理清除

**数据重建（Data rebuild）**：
清理当前 Multica 连接的 Paseo 映射对象与本地缓存，并按已保留的任务筛选规则从 Multica 重新导入的操作。
_Avoid_: 普通同步刷新、切换 CLI profile 清理、远端删除
