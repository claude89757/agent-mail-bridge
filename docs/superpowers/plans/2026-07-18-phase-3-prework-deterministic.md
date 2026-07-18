# Phase 3 前置确定性构件实施计划（批次一）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在红线 3 发信确认与 codex CLI 决策仍挂起期间，先落地 Phase 3 中与这两项外部依赖零耦合、可完整 TDD 的确定性构件：Authentication-Results 解析与 DKIM 对齐判定、bridge-owned worktree manager、AgentDriver 接口 + fake 实现、dispatch intent 生命周期。

**范围裁定（orchestrator ruling，对照 spec §5 Phase 3）**：本计划是 Phase 3 的前置子集，完成 ≠ Phase 3 完成。刻意不含：DKIM 因子的自发自收真实形态适配与 fallback（等 P0-3 实测，spec §3.3 控制 2 明文"实测为准"）、CodexDriver 实现（等 codex CLI 决策 + P0-2）、imap-smtp 真实 transport（独立成批次二计划——块头大，验证策略不同）、SMTP send 与 live loop（等红线 3；不提前堆积无法验证的发信代码）、daemon（依赖 transport + send）。Phase 3 正式计划在 P0-2/P0-3 输入到位后编写，届时本批次构件按其集成设计接线。

**Architecture:** 四个构件全部循守既有分层：`domain/` 纯函数（AR 解析、intent 状态机）、`application/` 用例（worktree manager，git 经注入 io）、`drivers/` 接口层（类型 + 契约，实现后置）、`store/` 迁移与扩展（migration 002）。无新增运行时依赖。

**Tech Stack:** TypeScript strict + ESM + nodenext、Node ≥22（`child_process.execFile` promisify）、vitest、better-sqlite3（仅经 src/store）。git 为被测外部系统（worktree 集成测试在临时仓库上跑真 git）。

---

## 锁定决策

### D-P3P-1 Authentication-Results 解析器（RFC 8601 简化子集）

```ts
// src/domain/authResults.ts
export interface DkimResinfo { result: string; domain: string | null } // result 小写化; domain 取 header.d 优先、缺失时 header.i 的 @ 后段, 均小写化
export interface ParsedAuthResults { authservId: string | null; dkim: readonly DkimResinfo[] }
export function parseAuthenticationResults(raw: string): ParsedAuthResults;
export function parseAllAuthenticationResults(raws: readonly string[]): readonly ParsedAuthResults[];
export type DkimFactorReason = 'NO_AUTH_RESULTS' | 'NO_DKIM_PASS' | 'DOMAIN_MISMATCH';
export function checkDkimFactor(parsed: readonly ParsedAuthResults[], selfDomain: string):
  { ok: true; matchedDomain: string } | { ok: false; reason: DkimFactorReason };
```

- 解析容错但**判定 fail closed**：无法解析的片段丢弃；`checkDkimFactor` 只在存在 `result === 'pass'` 且域与 `selfDomain` **精确相等（大小写不敏感）** 的 dkim resinfo 时通过。子域/组织域对齐 v0.1 一律不认（宁可拒真不认假）；P0-3 实测若显示 Gmail 自收路径用别的形态，凭证据出 ADR 再放宽。
- 多头实例：邮件可携带多个 Authentication-Results 头（转发链），全部解析，任一含合格 resinfo 即可（authservId 校验——即"这是谁写的头"的信任问题——属于 Phase 3 正式阶段与 P0-3 一起定：内部投递头的 authservId 形态未实测前不锁定）。此裁量写入 doc comment。
- reason 优先级：无任何可解析头 → NO_AUTH_RESULTS；有头但无 pass → NO_DKIM_PASS；有 pass 但域不齐 → DOMAIN_MISMATCH。
- 纯函数、无 IO、无正则灾难（拒绝回溯型嵌套正则；按分号/空白 token 化解析）。

### D-P3P-2 worktree manager

```ts
// src/application/worktreeManager.ts
export interface GitIo { execFile(args: readonly string[], cwd: string): Promise<{ stdout: string }> } // 仅 git 子命令; 注入以便单测错误路径
export interface CreateWorktreeInput { repoRoot: string; baseRef: string; worktreesRoot: string; taskId: string }
export function createTaskWorktree(input: CreateWorktreeInput, io: GitIo & FsIo):
  Promise<{ worktreePath: string; baseCommit: string }>;
export function removeTaskWorktree(input: { repoRoot: string; worktreePath: string; force?: boolean }, io: GitIo): Promise<void>;
```

安全不变量（spec §3.4，每条都有对应测试）：

1. `taskId` 白名单 `^[a-z0-9][a-z0-9-]{0,63}$`——不满足即拒绝（路径注入/逃逸的第一道闸）；
2. `repoRoot`/`worktreesRoot` 必须已存在；两者 realpath 后使用；`worktreePath = realpath(worktreesRoot)/taskId` 必须仍以 realpath(worktreesRoot) + path.sep 为前缀（symlink 逃逸拒绝）；
3. `repoRoot` 必须是 git 仓库（`git rev-parse --git-dir` 成功）；`baseRef` 经 `git rev-parse --verify <ref>^{commit}` 解析为明确 commit sha，解析失败即拒绝（"从明确 base commit 创建"）；
4. 创建用 `git worktree add --detach <path> <sha>`（detach：不占分支名、绝不改动任何既有分支/工作树）；目标路径已存在 → 拒绝（不复用、不覆盖）；
5. `removeTaskWorktree` 默认不 `--force`：有未提交改动时 git 自然失败 → fail closed 向上传播；`force: true` 是上层显式决定（Phase 3 正式阶段的清理策略再定何时用）；
6. 用户当前 worktree 永不触碰：模块内除 `worktree add/remove/rev-parse` 外不出现任何写型 git 子命令（checkout/reset/clean 等一律不得出现——测试用 io 记录断言全部调用序列）。

集成测试策略：`mkdtemp` 里 `git init` + 首 commit 构造真实仓库，跑真 git 验证快乐路径 + 脏 worktree remove 失败 + symlink 逃逸拒绝；错误路径（git 不存在、非仓库）用注入 fake io。CI 有 git，无需跳过。

### D-P3P-3 AgentDriver 接口 + fake（D2「接口先抽象」，事件模型向 ACP 语义对齐）

```ts
// src/drivers/types.ts
export interface DriverCapabilities { supportsResume: boolean; agentName: string }
export interface AgentTaskInput { prompt: string; cwd: string; dryRun: boolean }
export interface AgentTaskHandle { sessionId: string | null } // codex exec --json 的 session id 提取语义待 P0-2; null = 驱动未暴露
export type DriverEvent =
  | { kind: 'agent-message'; text: string }
  | { kind: 'tool-activity'; summary: string }
  | { kind: 'completed'; resultText: string }
  | { kind: 'failed'; errorText: string };
export interface AgentDriver {
  capabilities(): DriverCapabilities;
  startTask(input: AgentTaskInput): Promise<AgentTaskHandle>;
  resumeTask(sessionId: string, input: AgentTaskInput): Promise<AgentTaskHandle>;
  streamEvents(handle: AgentTaskHandle): AsyncIterable<DriverEvent>;
  close(): Promise<void>;
}
```

- 形状严格照 spec §3.1（startTask/resumeTask/streamEvents/capabilities）+ close；DriverEvent 是 ACP 语义的最小投影（消息/工具活动/终态二分），CodexDriver（批次外）把 `codex exec --json` 的事件流映射进来，P0-2 结论若要求增补事件种类，凭 ADR 扩展 union（加成员不破坏既有 consumer）。
- `tests/helpers/fakeAgentDriver.ts`：脚本化——构造时给定 `Array<DriverEvent[]>`（每次 startTask/resumeTask 消费一段），事件经 async generator 逐个 yield；记录全部调用（inputs、resume 的 sessionId）供断言；`failOnStart` 注入启动即败路径。每个 task 的 `sessionId` 由确定性计数器生成（无随机/时钟）。
- 终态约束：一个事件流恰好以一个 `completed` 或 `failed` 结尾——fake 在脚本违反时 throw（帮助上层测试自证），接口 doc comment 记为契约。

### D-P3P-4 intent 生命周期（最小闭环）

- migration 002（`src/store/migrations.ts` 追加）：`ALTER TABLE dispatch_intents ADD COLUMN status_reason TEXT; ALTER TABLE dispatch_intents ADD COLUMN updated_at TEXT;` 既有行 `updated_at` 回填 = `created_at`（一条 UPDATE）。STRICT 表加列合法（TEXT 可空）。
- `src/domain/intentState.ts`（与 command/outbox 状态机同构：映射即数据 + assert）：

```ts
export type IntentStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED_DRY_RUN';
export const INTENT_TRANSITIONS = {
  PENDING: ['RUNNING', 'SKIPPED_DRY_RUN'],
  RUNNING: ['COMPLETED', 'FAILED'],
  COMPLETED: [], FAILED: [], SKIPPED_DRY_RUN: [],
} as const;
export function assertIntentTransition(from: IntentStatus, to: IntentStatus): void; // IllegalTransitionError('intent', ...)
```

- 崩溃恢复语义（doc comment 锁定，daemon 于批次外实现）：daemon 启动时把所有 RUNNING 置 FAILED（reason `INTERRUPTED_BY_RESTART`）——effectively-once：中断任务绝不静默重跑，由结果信/用户决定重发（与 outbox UNCERTAIN 同一哲学）。
- `IntentStore` 扩展：`transition(id, next, reason, now)`（写前 assert，D-P2-2 同模式）、`findByStatus(status): IntentSummary[]`、`getById(id)`；`IntentSummary` 增补 `statusReason`/`updatedAt` 字段（既有 `getByCommandId` 返回形状同步扩展——属加字段，不破坏既有断言）。
- 兼容性：Phase 2 的 ingest 创建 intent 为 'PENDING' 不变；既有测试不得修改断言语义（新增字段允许既有对象断言改为包含式或补字段——以最小 diff 为准，逐处说明）。

### D-P3P-5 测试与边界

- 新文件：`src/domain/authResults.ts`、`src/domain/intentState.ts`、`src/application/worktreeManager.ts`、`src/drivers/types.ts`、`tests/helpers/fakeAgentDriver.ts`；修改：`src/store/migrations.ts`、`src/store/intentStore.ts`。
- 测试：`tests/unit/domain-auth-results.test.ts`、`tests/unit/domain-intent-state.test.ts`、`tests/unit/worktree-manager.test.ts`（含真实 git 集成用例）、`tests/unit/fake-agent-driver.test.ts`、`tests/unit/store-records.test.ts`（intent 扩展并入既有文件）、迁移测试并入 `tests/unit/store-database.test.ts`（v1 库升 v2 回填断言）。
- 分层红线不变：better-sqlite3 仅 src/store/**；drivers/types.ts 零运行时 import；domain 零 IO。

---

## 任务列表

依赖：T1/T2/T3 相互独立；T4 依赖无（并行安全但写者串行调度）；T5 收尾。每任务严格 TDD + 综合审查（spec+quality 单审查员，P5S 模式）。

### Task 1: Authentication-Results 解析器 + DKIM 对齐判定

**Files:** Create `src/domain/authResults.ts`; Test `tests/unit/domain-auth-results.test.ts`。

- [x] 失败测试：典型 Gmail 形态头（构造夹具，占位域）解析出 authservId + dkim pass + header.d；header.i 回退（`@example.com` → `example.com`）；多 resinfo/多方法头只取 dkim；大小写归一；破损片段丢弃不 throw；空串/无 dkim → 空数组；checkDkimFactor 三个 reason 各至少一例 + 优先级（无头 vs 有头无 pass vs 有 pass 域不齐）；域比较大小写不敏感精确相等；子域 `mail.example.com` vs `example.com` → DOMAIN_MISMATCH（fail closed 钉住）。
- [x] RED → 实现 → GREEN → commit。

### Task 2: worktree manager

**Files:** Create `src/application/worktreeManager.ts`; Test `tests/unit/worktree-manager.test.ts`。

- [x] 失败测试（真实 git 临时仓库）：创建成功返回 worktreePath+baseCommit 且路径下有检出内容；baseRef 支持分支名/sha/HEAD~1 且解析为确定 sha；目标已存在拒绝；脏 worktree remove 无 force 失败、force 成功；（fake io）taskId 非法字符拒绝（`../x`、大写、下划线、64+ 长度）；symlink 逃逸拒绝（worktreesRoot 下 symlink 指向外部目录）；非 git 仓库拒绝；调用序列断言——除白名单 git 子命令外无其他（尤其无 checkout/reset）。
- [x] RED → 实现 → GREEN → commit。

### Task 3: AgentDriver 接口 + FakeAgentDriver

**Files:** Create `src/drivers/types.ts`、`tests/helpers/fakeAgentDriver.ts`; Test `tests/unit/fake-agent-driver.test.ts`; Modify `src/drivers/README.md`（若存在陈旧接口描述则同步，参照 Task 7 先例）。

- [x] 失败测试：脚本化事件按序 yield 且以终态收尾；违反单终态契约的脚本 → fake throw；startTask/resumeTask 调用记录（input、sessionId）可断言；failOnStart 路径；sessionId 确定性递增；capabilities 形状。
- [x] RED → 实现 → GREEN → commit。

### Task 4: intent 生命周期（migration 002 + 状态机 + store 扩展）

**Files:** Create `src/domain/intentState.ts`; Modify `src/store/migrations.ts`（MIGRATION 002）、`src/store/intentStore.ts`; Test 并入 `tests/unit/domain-intent-state.test.ts`（新）、`tests/unit/store-database.test.ts`（迁移回填）、`tests/unit/store-records.test.ts`（store 扩展）。

- [x] 失败测试：全矩阵 5×5 迁移扫描（同 command/outbox 模式）；IllegalTransitionError machine='intent'；v1 库开升 v2：既有 intent 行 updated_at 回填 = created_at、status_reason NULL；transition 写前 assert 失败行不动；findByStatus/getById；PENDING→SKIPPED_DRY_RUN 与 PENDING→RUNNING→COMPLETED/FAILED 各链路持久化断言；Phase 2 既有测试全绿（ingest 建 PENDING 不变）。
- [x] RED → 实现 → GREEN → commit。

### Task 5: 批次收尾

- [x] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` 全绿，计数贴本文件完成记录段。
- [x] 本计划追加「完成记录」：commit 列表 + 测试计数 + 移交说明（哪些接口等 P0-2/P0-3/红线3 的哪个输入接线）。
- [x] threat-model C2 补 *Evidence (partial)* 指针（解析与判定已实现待实测形态）；architecture 实现状态表更新。
- [x] commit + push。

---

## Self-review notes

- spec 覆盖：§3.3 控制 2 的可先行半边（解析+判定）✓ T1，实测适配明确排除；§3.4 worktree 六条安全不变量全部映射到 T2 测试；§3.1 AgentDriver 四方法 ✓ T3；Phase 2 验收报告前向备忘（intent 生命周期）✓ T4。
- 类型一致性：IllegalTransitionError 复用（machine 字符串扩 'intent'——errors.ts 本就用 string 无需改）；IntentSummary 扩展字段在 T4 内一次定义。
- 无占位符：每任务失败测试具体；夹具一律占位域（example.com/example.net）。
- 与批次二（imap-smtp transport 读路径）的边界：本计划零 transport 改动；batch 2 需要独立的 live 只读验证策略（凭据、CI skip 语义），单独成计划。

---

## 完成记录（2026-07-19）

全部四任务 + 审查修复闭环。测试基线 18 文件 / 281 测试 → **22 文件 / 391 测试**（+110）；
`pnpm lint && pnpm typecheck && pnpm build && pnpm test` 全绿。

### Commit 轨迹

| Commit | 内容 |
| --- | --- |
| `f5038e4` | T1 AR 解析器 + DKIM 判定（22 测试） |
| `81522ec` | T2 worktree manager（31 测试，3 处变异自检） |
| `391abca` | T1 审查修复：同形域文档姿态 + 空 header.d 回退钉住 + 注释拼接备注 |
| `f7e1ef1` | T3 AgentDriver 接口 + FakeAgentDriver（23 测试） |
| `b96e474` | T4 intent 生命周期：migration 002 + 状态机 + store 扩展（24 测试） |
| `5105131` | T2 审查修复：`--end-of-options` + sha 格式校验 + 真实 symlink 逃逸测试 + remove 绝对路径前置 |
| `e7ba096` | T3 审查补强：真实驱动崩溃须合成 failed 契约句、fake 重放/close 语义文档+钉住、不变量 4 措辞改准 |

每任务综合审查（spec+quality 单审查员）结论：T1 ✅ / T2 ❌→修复→编排者复核 ✅ / T3 ✅ / T4 ✅。
审查过程的两个实测要点值得留档：① `rev-parse --verify` 不会屏蔽下一个 argv 的选项扫描，
无哨兵时安全性只是 git 版本运气（已收紧）；② 对"目标位置预植 symlink 指向外部已存在目录"，
git 2.54 的 `worktree add` 会穿透 symlink 检出到外部——`exists()` 门是唯一防线（变异验证已钉住）。

### 移交说明（哪些接口等哪个外部输入接线）

- `parseAuthenticationResults`/`checkDkimFactor`（C2 确定性半边）→ 等 **红线 3 发信确认 + P0-3**：
  实测 self-to-self AR 头形态后做适配 + authservId 信任策略（Phase 3 正式阶段接入 ingest 身份门）。
- `AgentDriver` 接口（seam 已锁）→ 等 **codex CLI 版本决策 + P0-2**：session id 提取/续跑语义/
  事件映射决定后落 CodexDriver（若需扩 DriverEvent union，凭 ADR 增补成员）。
- `createTaskWorktree`/`removeTaskWorktree` → 等 **Phase 3 正式阶段**：dispatcher 接线与
  cleanup 政策（何时 force）;「邮件不能点名任意路径」的另一半在 router 的 allowlist 范围。
- intent `transition()`/`findByStatus` → 等 **Phase 3 正式阶段**：daemon 启动时
  RUNNING→FAILED（`INTERRUPTED_BY_RESTART`）崩溃恢复 + dispatcher 的 PENDING→RUNNING 驱动。
- 批次二（另立计划）：imap-smtp transport 读路径——需先定 live 只读验证策略
  （凭据注入、CI skip 语义）。
