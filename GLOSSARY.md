# Paseo–Multica

用于在 Paseo 中呈现 Multica 任务的领域语言。两个产品中的 workspace 含义不同，始终使用带产品名称的完整称呼。

## Language

**Multica 工作区（Multica workspace）**：
Multica 任务所属的协作范围，对应 Paseo 中归集这些任务的 project。
_Avoid_: 未指明产品的 workspace、Paseo workspace

**Paseo 项目（Paseo project）**：
同一个 Multica 工作区在 Paseo 中的任务分组。
_Avoid_: Multica 任务、Paseo workspace

**Multica 项目（Multica project）**：
Multica 内归集任务的项目，在本集成中是任务筛选维度，不是 Paseo project 的对应对象。
_Avoid_: Paseo project、Multica 工作区

**Multica 任务（Issue）**：
Multica 中需要完成的一项工作，包含目标、讨论、负责人和任务状态。
_Avoid_: API task、Thread、执行过程

**Paseo 工作区（Paseo workspace）**：
一项 Multica 任务在 Paseo 中的工作单元。
_Avoid_: 未指明产品的 workspace、Multica 工作区、Paseo project

**任务讨论串（Thread）**：
一项 Multica 任务内，以一条顶层评论为起点的讨论及其全部后代回复，在 Paseo 中对应一个 agent tab；同一讨论串可以先后或同时引出多次执行。
_Avoid_: Multica 任务、执行过程

**评论（Comment）**：
讨论中的一条有作者的发言，在 Paseo 中呈现为对话消息。
_Avoid_: 工具调用、执行过程

**评论更正记录（Comment correction）**：
已导入评论在 Multica 被编辑或删除后追加的通知，保留原始消息并说明后续变化。
_Avoid_: 原位替换、新的参与者评论

**Agent 提及（Agent mention）**：
评论中以 agent ID 指向一个 Multica agent 的引用；Multica 据此决定是否启动该 agent 的执行，裸 `@名字` 或普通链接不构成有效提及。
_Avoid_: 裸 @名字、执行成功

**执行过程（Agent run）**：
智能体对一项任务的一次执行活动，可以涉及零个、一个或多个任务讨论串。
_Avoid_: Thread、Comment

**展示归属（Run display ownership）**：
一个 Run 在 Paseo 中唯一承载其执行流的 tab，可以对应任务讨论串或本地主讨论；展示归属不表示该 Run 只处理这个讨论串的评论。
_Avoid_: 所有参与讨论串、远端运行所有权

**本地主讨论（Local main discussion）**：
每个 Issue 在 Paseo 中用于呈现任务描述和首次展示时无评论关联 Run 的本地会话；在此发送消息会新建真实 Thread，但主讨论本身不对应一个 Multica Thread。
_Avoid_: Multica Thread、任务的全部讨论

**执行段（Run segment）**：
单个 Run 在对话中的可展开展示，包含执行 agent、状态、工具调用及结果、运行文本和错误。
_Avoid_: 评论、整个 Thread

**Multica 连接（Connection）**：
Paseo 与一个 Multica 服务之间、绑定单一 Multica 用户身份的连接；该身份是判断“自己的评论”的参照，更换服务或用户属于不同的连接身份。
_Avoid_: Multica 工作区、Paseo workspace

**CLI 登录上下文（CLI login context）**：
Multica CLI 有效的服务地址、登录身份与凭据来源，是本集成默认复用的连接上下文；命名 profile 区分不同的已配置登录环境。
_Avoid_: 独立插件账号、浏览器登录 Cookie

**评论投递（Comment delivery）**：
一条 Paseo 输入成为 Multica 评论的过程；评论已保存与智能体已开始执行是两个不同结果。
_Avoid_: Agent run、执行成功

**任务筛选规则（Task filter）**：
决定哪些 Multica 任务应在 Paseo 中展示的条件，任务范围随条件匹配结果变化；状态按具体状态多选，与负责人、项目和标签组合。
_Avoid_: 手动选中列表、固定任务清单

**人工隐藏（Manual hide）**：
用户通过关闭 tab 或归档 Paseo 工作区表达的隐藏意愿，优先于筛选规则的自动收录，直到用户主动恢复；恢复 Paseo 工作区与恢复其中某个讨论是独立的选择。
_Avoid_: 远端删除、任务完成、自动退出筛选范围

**原生归档（Native archive）**：
Paseo 中保留记录与历史、移出活跃展示的本地生命周期操作；整项 Paseo 工作区归档不表示取消 Multica 执行。
_Avoid_: 远端删除、远端停止、人工隐藏的唯一来源

**结构化提问卡片（AskUser card）**：
Multica 评论携带的一组文本或选项问题，区分待答、已答与已跳过；本地收起不表示远端跳过，卡片回答仍是所属讨论中的评论。
_Avoid_: Run、Thread、普通聊天、停止执行
