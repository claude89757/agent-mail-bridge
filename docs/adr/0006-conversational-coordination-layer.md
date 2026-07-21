# ADR-0006: 邮件对话式协调层 — 推翻 D5,门后引入 codex 驱动的只读协调 agent

- Status: accepted (user, 2026-07-21)
- Deciders: 用户(产品负责人)+ bridge maintainers
- Supersedes: 决策表 **D5**（"v0.1 纯确定性路由 + 邮件澄清,不调用模型路由"）
- Related:
  - spec §3.3 身份门 / §3.4 执行安全（**保留不变**）、§1.3 prompt injection 风险、§6 验收标准；
  - ADR-0003（身份门极性）、ADR-0004（`codex exec` session 语义）；
  - AGENTS.md 安全红线 2（脱敏)、4/5（额度/发布)、工程约定（禁 `danger-full-access` / `--dangerously-bypass-*`)；
  - `src/domain/routing.ts`、`src/domain/identity.ts`、`src/application/dispatch.ts`、`src/application/ingest.ts`。

## Context

用户将「通过邮件对话式交互」定为本项目**核心**。原 D5 的确定性路由——
`Subject` 第一个词必须精确匹配项目名、否则回澄清邮件——在体验上是「填表单」,
不符合产品预期。

但确定性路由并非保守选择,它服务于三个真实安全目标:

1. **prompt injection 防线**(spec §1.3,列为中风险):当前核心防御是「路由层不给
   模型任何工具,正文只当受限沙箱任务的输入」。让模型理解正文意图再决定路由,会把
   injection 面从「沙箱内的任务」扩大到「路由决策本身」。
2. **红线 2**:项目/会话数据含**真实本地路径**,绝不能进回复文本,须脱敏。
3. **spec §6「低置信永远澄清而不猜测」**:模型路由本质是猜意图,与该验收标准冲突。

因此不能简单「让模型读懂正文」了事,必须在**保住安全内核**的前提下引入对话智能。

## Decision

引入门后的「协调 agent」层,推翻 D5。三条同时成立:

1. **安全内核原样保留**。身份门(C1 严格自寻址 + AUTH 认证头因子 + echo / readyAt /
   幂等,确定性、**模型永不参与**)与执行隔离(codex `workspace-write`,在
   bridge-owned worktree 内,参数不受邮件控制)一条不动。
2. **门后新增协调 agent(codex 驱动)**。身份门放行后、执行前,由一个 **read-only
   codex 会话**理解自然语言邮件、多轮澄清、只读元查询(查项目 / 会话 / 进度 / 历史),
   最终输出**结构化决策**。
3. **协调 / 执行解耦**。协调层只读 + 脱敏 + 无写权;真正改代码由执行层用**不受邮件
   控制的参数**完成。injection 即便命中协调层,也越不过三道墙:
   `read-only sandbox` → `工具边界脱敏` → `dispatch 参数映射回 allowlist`。

### 协调 agent 的 codex 承载(实测证据,codex-cli 0.144.6)

方案的每一步都落在 codex 现成能力上,协调 agent 不是把 coding agent「硬掰成路由器」,
而是 = `read-only codex` + `bridge 只读 MCP 工具` + `结构化输出契约`:

| 需求 | codex 能力(实测) |
| --- | --- |
| 协调会话无写权 | `codex exec --sandbox read-only` — 文件系统只读,sandbox 级保证(纵深防御第一层) |
| 只读元查询工具 | `codex mcp add <NAME> -- <cmd>` / `mcp_servers` 配置 — bridge 以 **stdio MCP server** 暴露 `list_projects` / `list_sessions` / `get_status` 等只读工具;返回值在**工具边界脱敏**(路径→别名),协调 agent 永不见真实路径原文(红线 2 在此守住) |
| 结构化决策输出 | `codex exec --output-schema <FILE>` — 强制最终响应符合 decision JSON Schema(`dispatch` \| `clarify` \| `answer` + 参数),无需正则刮取;`-o` 落盘最终消息 |
| 多轮协调对话 | `codex exec resume <thread_id>`(ADR-0004:thread_id 稳定、上下文保留、resume 命中 prompt 缓存)— 邮件线程内多轮协调用 resume 实现 |

- 栈保持 **codex-only**(符合 D2 / D4),不引入第二套依赖 / 凭据 / 额度来源。
- 不碰 AGENTS.md 禁区:协调用 `read-only`、执行用 `workspace-write`,绝无
  `danger-full-access` / `--dangerously-bypass-*`。

### 确定性 `routeCommand` 的新定位

`src/domain/routing.ts` 的四判决(`CONTINUE_SESSION` / `DISPATCH_NEW` /
`CLARIFY_AMBIGUOUS` / `CLARIFY_NO_MATCH`)从「顶层裁决」降为**协调 agent 可调用的
确定性工具 + 兜底**:协调 agent 失败 / 超预算 / 输出不合 schema 时,回退到确定性
路由 + 澄清邮件(**fail closed,不猜测**)。既有确定性安全属性一条不丢。

## Consequences

**正面**

- 发任务从「填表单」变对话;查项目 / 会话 / 进度天然由只读工具承载。
- 安全内核零回退;新增 injection 面被三道墙 + read-only sandbox 关住。
- 复用现有 `CodexDriver` / worktree / dispatch 管线,协调层是「前置的一层」而非重写。

**代价 / 负面**

- **稳定消耗 codex 额度**(每轮协调都过模型,相对原确定性路由的零额度)。用户已接受。
- 复杂度上升:新增协调 driver、只读 MCP 工具进程、脱敏层、decision schema、协调
  对话状态(thread ↔ 协调 session ↔ 执行 session 三层映射)。
- injection 面客观扩大(协调层读正文)→ 靠只读 + 脱敏 + 参数隔离补偿,并需**安全测试
  专项覆盖**:伪造 / 注入邮件不得诱导协调 agent 越权 `dispatch`(allowlist 外路径)
  或泄露真实路径。

## 范围(用户选定:一步到位)

自然语言发起任务 + 多轮澄清 + 只读元问答(项目 / 会话 / 进度 / 历史)+ 跨项目操作。
分批 TDD 落地,见后续实现计划。

## 后续 spike / 未决(实现期解决,不阻塞本决策)

1. **codex 协调承载联调 spike**(P0 级):`--sandbox read-only` + stdio MCP server +
   `--output-schema` 三者串起来实跑一次,确认工具调用与结构化输出如约。**消耗少量
   额度,按红线 5 先报预估再跑**。
2. decision JSON Schema 与只读工具集的精确契约。
3. 协调对话状态模型(三层映射的持久化与崩溃一致性)。
4. 元问答 / 跨项目的脱敏与权限边界细化(哪些字段可回、跨项目 dispatch 的确认语义)。
