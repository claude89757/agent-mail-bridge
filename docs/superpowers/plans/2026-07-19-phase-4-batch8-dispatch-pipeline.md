# Phase 4 批次八：dispatch 管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已有零件接成 dispatch 用例：PENDING intent + 抽取后输入 →
`routeCommand` 裁决 → 按裁决执行（新派单走 session 承诺 → worktree →
`driver.startTask`；继续会话走 `resumeTask`；澄清与 dry-run 各自短路），
终态回写 intent 并产出结构化 outcome 供回信组装批次消费。**零模型额度**
（全走 FakeAgentDriver 与假 worktree 注入）。

**Architecture:** `src/application/dispatch.ts` 注入式编排（ingest.ts 同层
先例）：store 类 + `ProjectIndex` + `AgentDriver` seam + 窄化的 worktree
创建函数全部经 deps 注入；migration 005 给 agent_sessions 补 `worktree_path`
（resume 必须回到原 worktree——codex 会话的工作状态在那棵树里）。

**Tech Stack:** TypeScript strict + ESM、better-sqlite3（仅 store）、vitest。

**范围裁定（明确排除）：** 词抽取/prompt 抽取与邮件格式（真机走查后；本
用例收「已抽取值」）；澄清记录创建与 token 生成（归澄清邮件组装批次——
token 要进邮件，记录创建必须与发信同批设计）；回信组装与 outbox 入队
（下批，携带 C9 渲染 scrub 义务）；识别网关（ADR-0003）；daemon 循环、
超时/重试/并发上限、RUNNING 残留的 INTERRUPTED_BY_RESTART 恢复、
partial-dispatch 异常行的恢复策略（daemon 批次）；真实 codex E2E（红线 5）。

---

## 锁定决策

### D-P4B8-1 migration 005 + SessionStore 扩展

```sql
-- migration 005（表已存在，加列；无回填——既有行 worktree_path 为 NULL）
ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT;
```

- user_version 4 → 5；
- `SessionSummary` 增 `worktreePath: string | null`；`create` 输入不变
  （初始 NULL）；
- 新增 `recordWorktreePath(id, worktreePath, now)`：与
  `recordDriverSessionId` **同款首写不变量**（NULL⇒写；相同⇒幂等 touch
  updated_at；不同⇒抛；id 不存在⇒抛）——一个 session 的 worktree 一经
  确定不许静默漂移（worktreesRoot 配置变更导致的路径变化必须显式处理，
  归 daemon 批次）；
- 既有阶梯 tip 断言机械跟进 4 → 5（store-database、cli-doctor；004 子阶梯
  断言意图不动，必要时按先例钉 `version <= 4`——措辞教训见批次七完成记录）。

### D-P4B8-2 dispatch 用例形状（src/application/dispatch.ts 新建）

```ts
import type { AgentDriver, DriverEvent } from '../drivers/types.js';
import type { RouteVerdict } from '../domain/routing.js';
import type { CreateWorktreeInput } from './worktreeManager.js';

export interface DispatchInput {
  /** 必须指向状态为 PENDING 的 intent；否则抛错（调用方 bug，fail closed）。 */
  intentId: string;
  threadKey: string;
  /** 已抽取的项目词；抽取失败/缺失 = null。 */
  term: string | null;
  /** 已抽取的任务文本（喂给 driver 的 prompt）。 */
  prompt: string;
}

export interface DispatchDeps {
  intentStore: IntentStore;
  sessionStore: SessionStore;
  index: ProjectIndex;
  driver: AgentDriver;
  /** 窄化注入：生产绑 createTaskWorktree + buildDefaultWorktreeIo，测试假件。 */
  createWorktree(input: CreateWorktreeInput): Promise<{ worktreePath: string; baseCommit: string }>;
  /** resume 前校验持久化的 worktree 目录仍在（fail closed）。 */
  directoryExists(path: string): Promise<boolean>;
  worktreesRoot: string;
  baseRef: string;
  /** ISO 时钟（`new Date().toISOString()` 生产绑定）。 */
  clock(): string;
}

export type DispatchOutcome =
  | {
      kind: 'executed';
      verdict: 'DISPATCH_NEW' | 'CONTINUE_SESSION';
      terminal: Extract<DriverEvent, { kind: 'completed' | 'failed' }>;
      /** 全量事件（终态含在末位）；缓冲上限归 daemon 批次。 */
      events: readonly DriverEvent[];
    }
  | { kind: 'clarification-needed'; verdict: Extract<RouteVerdict, { kind: 'CLARIFY_AMBIGUOUS' | 'CLARIFY_NO_MATCH' }> }
  | { kind: 'skipped-dry-run'; verdict: RouteVerdict }
  | { kind: 'dispatch-failed'; stage: 'SESSION_STATE' | 'WORKTREE' | 'DRIVER_START'; reason: string };

export async function dispatchIntent(input: DispatchInput, deps: DispatchDeps): Promise<DispatchOutcome>;
```

### D-P4B8-3 编排次序（normative，逐步测试钉住）

1. `intentStore.getById(intentId)`：缺失或非 PENDING ⇒ **抛错**（daemon 只喂
   PENDING；RUNNING 残留恢复是 daemon 的 INTERRUPTED_BY_RESTART 契约，
   本用例不越权处理）；
2. 裁决（纯段，零副作用）：`sessionStore.findByThreadKey(threadKey)` →
   view；`term === null ? [] : index.lookup(term)` → `RoutingCandidate`
   投影（`{name, path}`，aliases 丢弃）→ `routeCommand`；
   **term 为 null 时不得调用 lookup**（测试钉住零调用）；
3. `CLARIFY_*` ⇒ outcome `clarification-needed`，**intent 保持 PENDING 不
   转移、零副作用**（澄清生命周期完成后 intent 才走向执行或过期——归
   澄清/daemon 批次；doc 注明）。dry-run 与澄清同时成立时澄清胜出
   （澄清不是执行，dry-run 无从跳过它）；
4. 可执行裁决（DISPATCH_NEW / CONTINUE_SESSION）且 `intent.dryRun` ⇒
   `transition(PENDING→SKIPPED_DRY_RUN, reason null)` + outcome
   `skipped-dry-run`（不建 session 行、不碰 worktree/driver——driver 的
   dryRun 抛错防线保持不可达，纵深防御）；
5. `transition(PENDING→RUNNING, reason null)`（最先落执行标记：读断言
   PENDING 在任何承诺性副作用前再拦一道调用方 bug）；
6. **DISPATCH_NEW**：
   a. `sessionStore.create({threadKey, projectPath: project.path, now})`
      ——session 行 = 派单承诺标记，先于一切外部副作用；
   b. `taskId = 'amb-session-' + 行 id`（十进制；恒匹配 worktreeManager 的
      TASK_ID_PATTERN，doc 注明推导）；
   c. `createWorktree({repoRoot: project.path, baseRef, worktreesRoot, taskId})`；
   d. `recordWorktreePath(行 id, worktreePath, now)`；
   e. `driver.startTask({prompt, cwd: worktreePath, dryRun: false})`；
   f. handle.sessionId 非 null ⇒ `recordDriverSessionId(行 id, sessionId,
      now)`；null（thread.started 前早退）⇒ 不记录（后续合成 failed 走 8）；
   g. → 8；
7. **CONTINUE_SESSION**：不建行、不建树。session 行的 `driverSessionId`
   或 `worktreePath` 为 null ⇒ `transition(RUNNING→FAILED,
   'SESSION_STATE_INCOMPLETE')` + outcome `dispatch-failed`/`SESSION_STATE`
   （partial-dispatch 残留，恢复策略归 daemon——fail closed 不自动重建）；
   `directoryExists(worktreePath)` false ⇒ FAILED `'WORKTREE_MISSING'` +
   stage `WORKTREE`；否则 `driver.resumeTask(driverSessionId, {prompt,
   cwd: worktreePath, dryRun: false})` → 8；
8. 消费 `streamEvents(handle)` 到终态（seam 契约保证恰一条终态居末）：
   `completed` ⇒ `transition(RUNNING→COMPLETED, null)`；`failed` ⇒
   `transition(RUNNING→FAILED, errorText)`；outcome `executed` 携带终态 +
   全量 events；
9. 步骤 6c/6e/7-resume 的**同步抛错**兜底：catch ⇒
   `transition(RUNNING→FAILED, 阶段前缀 + describeError)` + outcome
   `dispatch-failed`（stage 对应 WORKTREE / DRIVER_START）。intent
   status_reason 是本地 DB 运行态，可含真实路径（红线 2 管 git/日志/邮件
   ——邮件渲染的 scrub 义务在回信组装批次，threat-model C9 已档）。

### D-P4B8-4 测试（tests/unit/dispatch.test.ts 新建 + store 测试并入）

Store 侧（并入 store-records / store-database）：005 阶梯（v4→v5、fresh
直达 5、既有行加列后 worktree_path 为 NULL）、recordWorktreePath 四分支
（首写/幂等 touch/不同抛/缺 id 抛）+ updated_at 变异杀手、tip 断言机械跟进。

dispatch 侧（真 in-memory store + FakeAgentDriver + 假 createWorktree/
directoryExists，调用日志断言次序）：
- DISPATCH_NEW happy：session 行齐（worktree_path + driver_session_id 落
  库）、intent PENDING→RUNNING→COMPLETED、outcome executed、
  createWorktree 入参逐字段全等（含 taskId = `amb-session-<id>`）；
- 次序 pin：create 行 → createWorktree → startTask → recordDriverSessionId
  （调用日志序列断言）；
- 终态 failed ⇒ intent FAILED 且 reason === errorText；
- handle.sessionId 为 null ⇒ 零 recordDriverSessionId 调用，合成 failed
  → FAILED；session 行 driver_session_id 保持 NULL；
- CONTINUE happy：resumeTask 入参全等（sessionId + cwd = 持久化
  worktreePath）、无新 session 行、零 createWorktree 调用；
- CONTINUE 异常三连：driverSessionId null / worktreePath null /
  directoryExists false ⇒ 各自 FAILED reason + outcome stage 断言，
  零 driver 调用；
- CLARIFY_AMBIGUOUS 与 CLARIFY_NO_MATCH：outcome 形状 + intent 行整行
  不动断言 + 零 store 写/零 worktree/零 driver（fake 调用计数全零）；
- dry-run：DISPATCH_NEW 裁决 + dryRun ⇒ SKIPPED_DRY_RUN + 零副作用；
  CONTINUE 裁决 + dryRun 同；CLARIFY + dryRun ⇒ 澄清胜出；
- intent 缺失/非 PENDING ⇒ 抛错且零副作用；
- term null ⇒ index.lookup 零调用（间谍断言）；
- createWorktree 抛 ⇒ FAILED（stage WORKTREE）；startTask 同步抛 ⇒
  stage DRIVER_START；
- ProjectEntry→RoutingCandidate 投影（aliases 不入裁决）。

红线：全程零真实 codex、零发信、零真实路径夹具（/tmp/fixtures/*）。

---

## 任务列表

### Task 1: migration 005 + SessionStore.recordWorktreePath

**Files:** Modify `src/store/migrations.ts`、`src/store/sessionStore.ts`;
Test 并入 `tests/unit/store-database.test.ts`、`tests/unit/store-records.test.ts`
（tip 断言涉及 `tests/unit/cli-doctor.test.ts` 时机械跟进）。

- [ ] 失败测试先行（D-P4B8-4 store 侧全部）。
- [ ] RED → 实现 → GREEN → commit。

### Task 2: dispatchIntent 编排

**Files:** Create `src/application/dispatch.ts`; Test `tests/unit/dispatch.test.ts`。

- [ ] 失败测试先行（D-P4B8-4 dispatch 侧全部）。
- [ ] RED → 实现 → GREEN → commit。

### Task 3: 批次收尾

- [ ] 四件套全绿；threat-model C6/C8 证据句接上 dispatch 编排（执行标记
  次序、澄清零副作用短路、session 承诺标记语义）；architecture 表新增
  dispatch 行并刷新 not-started 行；完成记录（移交说明：回信组装接
  outcome.events 必须过 C9 scrub、澄清记录创建归澄清批次、RUNNING 残留
  与 partial-session 恢复归 daemon、E2E 请批模板沿批次六）；
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：§3 pipeline 的 router→driver 段第一次真正接通（spec §3.1
  dispatch 用例）；D5 worktree 与 D6 driver seam 的消费侧；C6 的执行面
  编排落地（sandbox 天花板已在 driver argv 层钉死）；C8 澄清短路保持
  fail closed。
- 类型一致性：全部形状取自已核对的现行导出（IntentStore.transition /
  SessionStore 两 record 方法 / CreateWorktreeInput / ProjectIndex.lookup /
  AgentDriver 五方法 / RouteVerdict 四裁决 / INTENT_TRANSITIONS 边）。
- resume 回原树：worktree_path 持久化 + 目录存在校验，缺失一律 fail
  closed 不自动重建（恢复策略归 daemon）。
- 与真机走查解耦（收抽取后值）；与 ADR-0003 解耦（不触识别网关）；与
  红线 5 解耦（假 driver）；与红线 3 解耦（零发信）。
- 无占位符：每测试点具体。
