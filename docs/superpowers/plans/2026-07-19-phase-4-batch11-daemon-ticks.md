# Phase 4/5 批次十一：daemon ticks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 daemon 的单步函数（ticks）：启动恢复、过期扫描、邮件主
tick（fetch→ingest→就地派发→回信）、孤儿恢复 tick、outbox 生命周期胶水
与 echo 对账。全部注入式、单步可测、零长驻循环（循环/信号/CLI 归下批
shell）。**零模型额度**（FakeAgentDriver）、**零发信**（fakeTransport；
真发信 E2E 等红线 5 请批）。

**Architecture:** 新目录 `src/daemon/`（spec §3.1 模块边界）：
`replySender.ts`（outbox 生命周期胶水）+ `ticks.ts`（四个 tick）。一切
依赖注入（stores/transport/driver/index/composers 已全存在）；tick 产出
结构化 report 供 shell 记录。先决：seam 缺口两处（transport 无
mailboxStatus、outbox 无按 command/messageId 查询）在 T1 补齐。

**Tech Stack:** TypeScript strict + ESM、vitest。零新依赖。

**范围裁定（明确排除）：** 长驻循环/定时器/信号/CLI start（daemon shell
批次）；IDLE watch（同前）；QUEUED_WINDOW 复活扫描（v0.1 默认配置无时间
窗故不可达——doc 注明 follow-up）；澄清记录/token/澄清邮件（真机走查；
本批只有 stopgap 一次性 cannot-route 回信）；识别网关（ADR-0003）；
In-Reply-To 扩键（另批）；真实 E2E（红线 5）。

---

## 锁定决策

### D-P4B11-1 seam/store 补缺（T1）

```ts
// transports/types.ts：MailTransport 增方法（pre-1.0 直改，D-P3B2-1 先例）
/** 当前邮箱状态——daemon 引导水位与 UIDVALIDITY 变更检测的输入。 */
mailboxStatus(mailbox: string): Promise<{ uidValidity: string; uidNext: number }>;
```

- `ImapReadTransport` 实现（imapflow `status()` 或 mailboxOpen 字段，
  只读）；`fakeTransport` 机械补齐（脚本可设值）；
- `OutboxStore` 增 `findByCommandId(commandId): OutboxSummary[]`（按 id
  序）与 `findByMessageId(messageId): OutboxSummary | undefined`
  （message_id 无唯一约束——多行时取 id 序首行，doc 注明并测试钉住）。

### D-P4B11-2 replySender（src/daemon/replySender.ts）

```ts
export interface ReplySenderDeps {
  db: TransactionRunner;            // ingest 同款结构型事务面
  outboxStore: OutboxStore;
  transport: MailTransport;
  clock(): string;
}
export interface SendReplyResult {
  outboxId: string | null;          // registerOutbox 已跑则非 null
  status: 'SENT' | 'UNCERTAIN' | 'REGISTER_FAILED';
}
export function buildRegisterOutbox(deps): (receipt, mail) => Promise<void>;
// = db.transaction 内 create({id: receipt.outboxId, messageId: receipt.messageId,
//   commandId: mail.commandId, kind: mail.kind, now}) + transition(id,'SENDING',now)
export async function sendReply(deps, mail: OutboundMail): Promise<SendReplyResult>;
```

- `sendReply` 语义（C3 发送次序不变式的 daemon 侧收口）：调
  `transport.send(mail)`（其内部先 await registerOutbox 再 SMTP）——
  resolve ⇒ `transition(outboxId,'SENT',now)`，返回 SENT；reject 且
  outbox 行已存在（isKnownOutboxId）⇒ `transition('UNCERTAIN')` 返回
  UNCERTAIN（**绝不自动重发**——spec「隔离对账，不盲目重发」，
  effectively-once）；reject 且行不存在（register 前就炸）⇒
  REGISTER_FAILED（无行可转移，doc：这类失败可安全重试，因为什么都没
  发生）；
- receipt 的 outboxId 从 transport.send resolve 值拿；reject 路径拿不到
  receipt ⇒ 用 `mint 侧不可知` 的现实：transport reject 时 daemon 无
  receipt——**因此** registerOutbox 回调里把 (receipt.outboxId → 行) 写库
  后，reject 路径靠 `findByCommandId(mail.commandId)` 取最新 SENDING 行
  定位（同 command 多行取 id 序末行 = 最新，doc + 测试钉住）；
  commandId null 的邮件（理论不该有——回信都有 command）⇒ reject 时
  无从定位 ⇒ 返回 REGISTER_FAILED 语义并 doc 注明该组合不可达。

### D-P4B11-3 ticks（src/daemon/ticks.ts，四函数）

```ts
export function recoverInterruptedIntents(deps: {intentStore; clock}): { recovered: readonly string[] };
// findByStatus('RUNNING') 逐个 transition(id,'FAILED','INTERRUPTED_BY_RESTART',now)
// —— intentState.ts 既有崩溃恢复契约的落地；启动时跑一次（shell 批次接线）。

export function sweepExpiredClarifications(deps: {clarificationStore; clock}): { expired: readonly number[] };
// findPendingExpiredBefore(now) 逐个 transition(id,'EXPIRED',null,now)。

export async function runMailTick(deps: MailTickDeps): Promise<MailTickReport>;
export async function runOrphanTick(deps: OrphanTickDeps): Promise<OrphanTickReport>;
```

**runMailTick 编排（normative）**：
1. `transport.mailboxStatus(mailbox)` → `{uidValidity}`；
2. `metaStore.getWatermark(mailbox, uidValidity)` → since（validity 变更
   ⇒ 新键水位 0 ⇒ 全量重扫，靠 ingest 幂等 + readyAt fence 收敛——spec
   有界重扫的 v0.1 实现路径，doc 写明「有界」来自 fence 与去重而非抓取
   截断）；
3. `transport.fetchSince(mailbox, uidValidity, since)`；逐封（升序）：
   a. `ingest(mail, new Date(clock()))`；
   b. `transport.markProcessed(mail)`（无论 outcome——\Seen 是外观）；
   c. outcome `echo` ⇒ **echo 对账**：`outboxStore.findByMessageId(规范化
      messageId)`（echo gate 用的同键）行存在且 UNCERTAIN ⇒
      transition('SENT')（对账闭环：唯一把 UNCERTAIN 转出的路径）；
   d. outcome `ready` ⇒ 就地派发（下述 dispatch 胶水）；
   e. 单封处理抛错 ⇒ 记入 report `failures` 继续下一封（fail open 到
      report；致命错误——fetchSince 自身抛（UIDVALIDITY 竞态等）——向上
      抛给 shell）；
4. report：{fetched, outcomes 计数, dispatched, replies: SendReplyResult[],
   failures: [{uid, stage, message}] }（message 过批次九 scrubText——
   report 是日志素材，红线 2）。

**dispatch 胶水（mailTick 内部函数，orphanTick 复用）**：
1. `extractCommand({subjectRaw: headers 'subject' 首实例 ?? null, bodyText,
   messageIdNormalized: ingest 同款规范化, references: headers 全实例,
   inReplyTo: 首实例 ?? null})`；
2. `threadKey ?? prompt` 任一 null ⇒ 不派发：intent 两步终态化
   `PENDING→RUNNING→FAILED('EXTRACTION_INCOMPLETE')` + 回信
   `composeDispatchFailedReply(stage 'SESSION_STATE'… 不对——用
   dispatch-failed 组装器但 stage 语义不符)`——**裁定**：新常量不引入，
   直接 `composeDispatchFailedReply(ctx, {stage: 'SESSION_STATE', reason:
   'EXTRACTION_INCOMPLETE: missing ' + 缺失项列表})`？stage 枚举是批次八
   锁定的三值，不扩——**改为**：抽取不完整走
   `composeDryRunReply`？也不对。**最终裁定：抽取不完整 ⇒ intent 两步
   终态化 + `composeResultReply` 不可用（无 terminal）⇒ 本批新增第五
   组装器不做**，用 `composeDispatchFailedReply` 并把 stage 联合在
   replyComposition 侧扩一个成员 `'EXTRACTION'`（domain 纯类型扩展，
   一行 + 测试；批次九组装器的 stage 参数来自 dispatch 的三值联合 +
   本批 'EXTRACTION'——扩联合是加法变更，既有测试不动）；
3. `sessionStore.findByThreadKey(threadKey)` → RoutingSessionView 投影；
   `term === null ? [] : index.lookup(term)` → RoutingCandidate 投影；
4. `dispatchIntent({intentId, threadKey, term, prompt}, …)`；
5. outcome → 回信：
   - `executed` ⇒ `composeResultReply`（ScrubContext: worktreePath =
     `sessionStore.findByThreadKey(threadKey)?.worktreePath ?? null`（派发
     后再查一次，DISPATCH_NEW 的新行已存在），homeDir = deps.homeDir；
     projectName = session.projectPath 的最后路径段 ?? null）+
     `sendReply`；ackEnabled 且 executed ⇒ **不另发 ACK**（结果已到，ACK
     只在 shell 批次的异步场景有意义——本批同步派发完才回信，ACK 语义
     留 shell 批次接，doc 注明组装器已备）；
   - `dispatch-failed` ⇒ `composeDispatchFailedReply` + `sendReply`；
   - `skipped-dry-run` ⇒ `composeDryRunReply` + `sendReply`；
   - `clarification-needed` ⇒ **stopgap**：`findByCommandId(commandId)`
     已有 kind==='ERROR' 行 ⇒ 跳过（曾告知过）；否则
     `composeDispatchFailedReply(ctx, {stage: 'EXTRACTION'… 不对——}`
     **裁定**：stopgap 用 `composeDryRunReply(ctx, verdict)`？dry-run
     语义误导。**最终裁定：stopgap 复用 composeDispatchFailedReply，
     stage 联合再扩一员 `'ROUTING'`**，reason = `cannot route: ambiguous
     (N candidates: names…) | no match` （names 只列 name 不列 path——
     批次九纪律；文本过 scrub）；intent 保持 PENDING（升级路径归澄清
     批次，doc）；
6. 回信主题 ctx.originalSubject = headers 'subject' 首实例 ?? null。

**runOrphanTick 编排**：`intentStore.findByStatus('PENDING')` 逐个：
- `commandStore.getById(intent.commandId)`；行缺失 ⇒ 两步终态化
  `FAILED('ORPHAN_COMMAND_MISSING')`（防御性，理论不可达——FK 在）；
- command.status !== 'READY_FOR_DISPATCH' ⇒ 跳过（QUEUED_WINDOW 复活归
  follow-up）；
- 已有 kind==='ERROR' outbox 行（stopgap 已告知）⇒ 跳过（澄清 held）；
- `command.uid === null` ⇒ 终态化 `FAILED('ORPHAN_NO_UID')`；
- `transport.fetchSince(mailbox, command.uidValidity, command.uid - 1)`
  → 找 `uid === command.uid` 那封；fetchSince 抛（validity 已变）⇒
  终态化 `FAILED('ORPHAN_UNRECOVERABLE')`；找不到（已删信）⇒ 同前
  reason `'ORPHAN_MAIL_GONE'`；找到 ⇒ dispatch 胶水复用（就地派发 +
  回信）。
- 终态化 = `PENDING→RUNNING→FAILED(reason)` 两步（PENDING 无直达 FAILED
  边——批次八已锁 intent 状态机，不改机器，用两步 + doc）。

### D-P4B11-4 测试（tests/unit/daemon-ticks.test.ts + replySender 并入 +
既有 transport/store 测试机械跟进）

- T1：mailboxStatus（imap 假件脚本 + fakeTransport）；outbox 两查询
  round-trip + 多行序语义；
- replySender：SENT happy（transition 链 PENDING→SENDING→SENT 行状态
  断言）；SMTP reject ⇒ UNCERTAIN（行在 + 状态对 + **绝无第二次
  transport.send 调用**断言）；register 前炸 ⇒ REGISTER_FAILED 零行；
- ticks：recover（RUNNING×2 → FAILED reason 全等；空集no-op）；sweep
  （边界 `<=` 例）；mailTick happy 全链（fake transport 喂 1 封 ready
  命令邮件 → ingest → 派发（FakeAgentDriver completed）→ RESULT 回信
  经 fake transport 发出 + outbox SENT + 水位前进 + report 形状）；
  echo 对账（UNCERTAIN 行 + echo 邮件 ⇒ SENT；非 UNCERTAIN 不动）；
  单封炸不毒整批；validity 变更全量重扫收敛（同 Message-ID 去重）；
  抽取不完整 ⇒ EXTRACTION 回信 + 终态化；clarification stopgap 首次
  发 ROUTING 回信、二次跳过（outbox 行去重）、intent 保持 PENDING；
  orphanTick 五分支各一例（含 uid 重取成功派发例）；
- stage 联合扩员（'EXTRACTION' | 'ROUTING'）在 replyComposition 侧的
  加法测试；
- 红线：零真实 codex、零真实发信、夹具全合成、report message 过 scrub。

---

## 任务列表

### Task 1: seam/store 补缺

**Files:** Modify `src/transports/types.ts`、`src/transports/imapRead.ts`、
`tests/helpers/fakeTransport.ts`、`src/store/outboxStore.ts`; Test 并入既有。

- [ ] RED → GREEN → commit。

### Task 2: replySender + stage 联合扩员

**Files:** Create `src/daemon/replySender.ts`、`src/daemon/README.md`;
Modify `src/domain/replyComposition.ts`（stage 加 'EXTRACTION'|'ROUTING'）;
Test `tests/unit/daemon-reply-sender.test.ts` + replyComposition 加法例。

- [ ] RED → GREEN → commit。

### Task 3: 四 ticks

**Files:** Create `src/daemon/ticks.ts`; Test `tests/unit/daemon-ticks.test.ts`。

- [ ] RED → GREEN → commit。

### Task 4: 批次收尾

- [ ] 四件套全绿；threat-model C3（对账闭环）/C8（stopgap 与 held 语义）
  证据；architecture 表 daemon ticks 行 + not-started 刷新（只剩 shell/
  IDLE/识别网关/澄清正式流）；完成记录（移交：shell 接线清单、ACK 异步
  语义、QUEUED_WINDOW 复活、E2E 请批模板到点）；
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：可靠性模型全表落 tick（增量同步水位/at-least-once + 幂等/
  UIDVALIDITY 重扫收敛/echo 对账 effectively-once）；崩溃恢复契约
  （INTERRUPTED_BY_RESTART）落地；C3 发送次序 daemon 侧收口。
- 一致性：全部 API 与批次八/九/十的现行导出核对过（extractCommand 入参、
  dispatchIntent 形状、组装器 ctx、查询面、TransactionRunner 结构型）。
- stage 联合扩员是唯一触碰既有 domain 的点（加法、一行 + 测试）。
- 红线：零额度零发信；report 文本过 scrub；stopgap 只发 ERROR 类回信
  （authed self-send 既批类别 A 的同类——但本批只进 fake transport，
  真发信在 E2E/shell 阶段）。
- 无占位符：每测试点具体。
