# ADR-0007: 协调层只读上下文改「prompt 预注入脱敏快照」— codex exec 非交互下 MCP 工具不可用

- Status: accepted (user, 2026-07-21)
- Deciders: 用户(产品负责人)+ bridge maintainers
- Refines(细化,不推翻):[ADR-0006](0006-conversational-coordination-layer.md)
  的**实现手段**——协调 agent 的决策(门后只读协调层)整体不变,仅把「只读上下文
  怎么送到协调 agent」从「codex 经 MCP 工具**拉**」改为「bridge 把已脱敏快照**推**进
  prompt」。ADR-0006 Decision 表格里「bridge 以 stdio MCP server 暴露只读工具」一格被
  本 ADR 修正。
- Related:
  - AGENTS.md 安全红线 2(脱敏)、5(额度)、6(外部行为与 spec 不符 → fail closed +
    写 ADR + 停下问用户)、工程约定(禁 `danger-full-access` / `--dangerously-bypass-*`);
  - ADR-0004(`codex exec` session 语义);
  - `src/domain/coordinatorDecision.ts`、`src/drivers/coordinatorDriver.ts`、
    `src/application/coordinatorTools.ts`、`src/transports/coordinatorMcpServer.ts`。

## Context

ADR-0006 把协调 agent 的只读上下文(项目 / 会话 / 进度)设计为:bridge 以 stdio MCP
server 暴露 `list_projects` / `list_sessions` / `get_status`,codex 在 `--sandbox
read-only` 会话里按需**调用**这些工具查证。ADR-0006「后续 spike 未决」第 1 条要求先
实跑一次三件套联调确认可行。

批次 D spike(2026-07-21,codex-cli 0.144.6,红线 5 已获用户批准)实跑发现一条**硬
阻塞**:

> **非交互 `codex exec` + `--sandbox read-only`(或 workspace-write)下,MCP 工具调用
> 一律 `"user cancelled MCP tool call"` 立即失败。**

- 与 `approval_policy` / `approvals_reviewer` / `--ignore-user-config` 均无关;
- 是 codex 已知限制,非本项目 bug:
  [openai/codex#24135](https://github.com/openai/codex/issues/24135)、
  [#16685](https://github.com/openai/codex/issues/16685)、
  [社区帖 1379772](https://community.openai.com/t/codex-cli-0-125-0-alpha-3-cancels-mcp-tool-calls-under-read-only-workspace-write-sandbox/1379772);
- 唯一能放行 MCP 工具的 `--dangerously-bypass-approvals-and-sandbox` 会**同时拆掉
  sandbox**——那是 ADR-0006 三堵墙的第一堵(read-only),红线明令禁止,且正属红线 6
  说的「为绕过阻塞而降低安全设计」。**排除**。

按红线 6:fail closed(拒用 dangerous flag)、写本 ADR、停下问用户;用户确认下述方案 A。

## Decision

协调 agent 的只读上下文改由 **bridge 预注入 prompt**,不再走 MCP:

1. **投递方式反转(pull → push)**。bridge 在调用协调 agent **之前**,在自己进程内调用
   `application/coordinatorTools.ts` 的只读工具,拿到**已脱敏的** `ProjectView` /
   `SessionView`(路径→名称,红线 2 边界不变),序列化进协调 prompt 的「只读上下文」段。
   codex 在 `--sandbox read-only` 下**纯读 prompt** 出决策,不调用任何工具。
2. **三堵墙保持**。read-only sandbox(保留)、脱敏边界(同一套 View,只是从「MCP 工具
   返回值」变「prompt 文本」——脱敏发生在 bridge 侧,协调 agent 永不见真实路径)、
   dispatch 参数映射回 allowlist(不变)。安全属性零回退。
3. **MCP 适配层搁置、不删**。`transports/coordinatorMcpServer.ts` 及其 wire 适配保留在
   仓库,待 codex 修复该限制(社区已在请求 `mcp_servers.<name>.auto_approve_tools` /
   `default_mcp_tools_approval_mode="never"`)后可选回迁为「按需拉取」路径。
   `application/coordinatorTools.ts` 的脱敏逻辑**照常复用**(现在产出注入快照)。

### 载体形状(spike 实测,一并定死)

批次 C 的 `coordinatorDecision.ts` / `coordinatorDriver.ts` 按此收口:

| 项 | spike 结论 |
| --- | --- |
| `--output-schema` 形状 | OpenAI 拒绝 root 级 `oneOf`(`400 invalid_json_schema`)。须 root `object` + 内层 `anyOf`;可选字段(如 `clarify.options`)改 **required + nullable**(`type:["array","null"]`);去掉 `minLength`。决策外包一层 `{"decision": {...}}` envelope。 |
| 决策落点 | 走 stream 最终 `agent_message.text`,**无需** `-o/--output-last-message`。 |
| 固定 argv | 协调 cwd 为非 git 的 meta 目录 → `--skip-git-repo-check`;`--ignore-user-config` 隔离用户全局 config(避 `approvals_reviewer` / 无关 MCP server 噪音),**auth 仍用 `CODEX_HOME`**(不碰凭据);`-c approval_policy="never"`;stdin 必须 `</dev/null`(codex exec 总读 stdin)。 |
| 决策解析 | `parseCoordinatorDecision` 之前先解 envelope 取 `.decision`(domain 层 `parseCoordinatorDecisionEnvelope`),再复验;非法一律 fail closed 到确定性 `routeCommand`。 |

## Reproduction steps(Go/No-Go 可复现)

合成 fixture(占位项目 `blog` / `api-server` / `notes`,假路径,不碰真实项目/邮箱):

1. 一个 stdio MCP server(`buildCoordinatorMcpServer` over 合成 index + 空内存
   `SessionStore`),`codex mcp add amb-coord -- node <server>`。
2. schema 文件用 root `object` + `decision.anyOf`(见上「载体形状」)。
3. **MCP 路径(No-Go)**:
   ```
   codex exec --json --sandbox read-only --skip-git-repo-check --ignore-user-config \
     -c 'approval_policy="never"' \
     -c 'mcp_servers.amb-coord.command="node"' -c 'mcp_servers.amb-coord.args=["<server>"]' \
     -C <scratch> --output-schema <schema> "<协调提示 + 用户邮件>" </dev/null
   ```
   → `mcp_tool_call` 事件 `error:{"message":"user cancelled MCP tool call"}`,turn 虽
   completed 但工具无结果。改任何 approval 配置均无效;仅 `--dangerously-bypass-*`(拆
   sandbox)可放行 → 排除。
4. **prompt 注入路径(Go)**:去掉两条 `-c mcp_servers.*`,把脱敏快照写进 prompt 的
   「只读上下文」段,其余 flag 同上。实测:
   - 元查询「我有哪些项目?」→ `{"decision":{"kind":"answer","text":"…blog(别名 b、
     weblog)、api-server(别名 api)、notes…"}}`(准确复述注入数据);
   - 派发「在 api 项目加 README 简介」→ `{"decision":{"kind":"dispatch",
     "projectAlias":"api","prompt":"…","mode":"new"}}`(正确把 `api` 认成 api-server
     别名)。
   两分支形状与内容均正确,read-only 保留,无 dangerous flag。

## Consequences

**正面**

- 协调层**更简单**:去掉「stdio MCP server 进程 + `codex mcp add` 配置 + 工具调用往返」
  一整坨;协调 turn 也更快(无 MCP server 启动)。
- 安全零回退:read-only sandbox + 脱敏 + 参数隔离三堵墙全在;脱敏边界仍是
  `coordinatorTools.ts` 的 View。
- 无外部依赖阻塞:不必等 codex 修复即可推进批次 E/F。

**代价 / 负面**

- 协调 agent 拿的是**快照**,不能像 MCP 那样「按需追加查询」。对项目/会话这类小数据
  一次性注入完全够;但 `get_status`(查某会话细粒度进度)等**较大/按需**的上下文,需在
  prompt 组装时决定注入粒度(批次 E/F 细化),或等 MCP 回迁。
- prompt 变长(注入快照)→ 轻微额度上升,可接受。
- 需**安全测试专项**(批次 F)确认:注入/伪造邮件不能诱导协调 agent 越权 `dispatch`
  (allowlist 外)或从注入上下文里回吐真实路径(脱敏已在 View 层,但要回归测试守住)。

## 回迁条件(反转本 ADR 的手段修正)

codex 提供非交互放行 MCP 工具且不拆 sandbox 的机制(如
`mcp_servers.<name>.auto_approve_tools=true`)后,可在保持三堵墙的前提下把只读上下文
从「prompt 注入」回迁到「MCP 按需拉取」——届时另写 ADR,复用现存
`coordinatorMcpServer.ts`。
