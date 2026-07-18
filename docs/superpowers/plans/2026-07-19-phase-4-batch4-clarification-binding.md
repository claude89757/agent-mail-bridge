# Phase 4 前置批次四：澄清绑定 C8（domain + store 半边）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地控制 C8（threat-model §5）的确定性半边：澄清请求的状态机、四要素绑定
判定（token + thread + 候选集版本 + TTL，spec 行 205）与持久化（migration 003 +
ClarificationStore）。迟到/陈旧回复的隔离由判定 reason 驱动——接线归 Phase 4 正式阶段。

**Architecture:** 与 command/outbox/intent 三台状态机同构（映射即数据 + assert）；
绑定判定是纯函数（收「已从回复邮件提取的抽象值」，邮件解析/展示格式明确不在本批次——
spec 213 行要求 Phase 4 前真机走查展示格式）；store 沿 D-P2-2 read-assert-write 先例。

**Tech Stack:** TypeScript strict + ESM、better-sqlite3（仅 store）、vitest。

**范围裁定（明确排除）：** 澄清邮件的生成/发送（等红线 3 的 SMTP 批次）；回复解析
（`1/2/新建` 意图提取 + token 从主题/正文抽取——Phase 4 正式阶段，依赖真机走查后的
邮件格式）；候选评分与 thread↔session 映射（依赖 P0-2 session 语义）；quarantine 的
ingest 接线（router 批次）。token 生成的随机源由调用方注入（本批次只存与比）。

---

## 锁定决策

### D-P4B4-1 状态机（src/domain/clarificationState.ts）

```ts
export type ClarificationStatus = 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'SUPERSEDED';
export const CLARIFICATION_TRANSITIONS = {
  PENDING: ['CONSUMED', 'EXPIRED', 'SUPERSEDED'],
  CONSUMED: [], EXPIRED: [], SUPERSEDED: [],
} as const;
export function assertClarificationTransition(from, to): void; // IllegalTransitionError('clarification', ...)
```

- PENDING=已发出待回复；CONSUMED=有效回复已绑定；EXPIRED=TTL 过（由扫描/惰性判定驱动，
  daemon 批次决定触发时机）；SUPERSEDED=同一 command 发出了新一版候选集，旧记录作废。
- doc comment 锁定：同一 command 重发澄清时，旧记录 PENDING→SUPERSEDED **先于**新记录
  创建（同事务，store 层保证）——绝不允许同 command 两条 PENDING 并存。

### D-P4B4-2 绑定判定（纯函数，fail closed，理由优先级固定）

```ts
export interface ClarificationRecordView {
  token: string; threadKey: string; candidateSetVersion: number;
  expiresAt: string;          // ISO 8601（与 readyAt 栅栏同款字典序比较）
  status: ClarificationStatus;
}
export interface ExtractedReplyBinding {
  token: string | null;       // 回复中提取的 token；提取失败 = null
  threadKey: string;          // 回复的 In-Reply-To 归一值（提取归 Phase 4，此处已抽象）
  candidateSetVersion: number | null;
}
export type ClarificationRejectReason =
  | 'NOT_PENDING'             // 记录已终态（含 SUPERSEDED——陈旧线程的回复）
  | 'TOKEN_MISMATCH'          // 含 token 缺失（null）——fail closed
  | 'VERSION_STALE'           // 含 version 缺失（null）
  | 'EXPIRED_AT_REPLY';       // now ≥ expiresAt（字典序）
export function checkClarificationBinding(
  record: ClarificationRecordView,
  reply: ExtractedReplyBinding,
  now: string,
): { ok: true } | { ok: false; reason: ClarificationRejectReason };
```

- 调用方（router，批次外）先按 threadKey 查记录；查无记录的处理在 router 层
  （NO_MATCH 不是本函数的 reason——函数契约是 record 已存在）。
- 理由优先级即上面枚举顺序（每级各测 + 组合时高优先级胜出测试）；
- token 比较：`===` 全等（大小写敏感、不 trim——token 由 bridge 生成并原样嵌入，
  任何变形即不匹配即 fail closed）。doc comment 记录：邮件往返秒级延迟 + 单次机会，
  计时侧信道不构成现实威胁，无需常数时间比较；
- threadKey 一致性由查找路径保证（按 threadKey 查到的记录必然匹配），函数内不重比——
  doc comment 说明该设计（避免假装校验）。

### D-P4B4-3 migration 003 + ClarificationStore（src/store/clarificationStore.ts）

```sql
CREATE TABLE clarification_requests (
  id INTEGER PRIMARY KEY,
  command_id INTEGER NOT NULL REFERENCES commands(id),
  token TEXT NOT NULL,
  thread_key TEXT NOT NULL UNIQUE,
  candidate_set_json TEXT NOT NULL,
  candidate_set_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_clarification_command ON clarification_requests(command_id);
```

- user_version 2 → 3；表全新（无回填）；
- Store API（照 intentStore 先例）：`create({commandId, token, threadKey, candidateSetJson,
  candidateSetVersion, expiresAt, now})`（**同事务**内先把该 command 现存 PENDING 全部
  transition 到 SUPERSEDED reason `REISSUED`，再插入——D-P4B4-1 的不变量在此落地）、
  `findByThreadKey(threadKey)`、`findPendingByCommandId(commandId)`、
  `transition(id, next, reason, now)`（read-assert-write，行不动于 assert 失败）；
- candidate_set_json 是不透明 TEXT（候选结构 Phase 4 正式阶段定，本批次不解析）。

### D-P4B4-4 测试与边界

- 新文件：`src/domain/clarificationState.ts`、`src/store/clarificationStore.ts`；
  修改：`src/store/migrations.ts`（003）；
- 测试：`tests/unit/domain-clarification-state.test.ts`（4×4 全矩阵 + 绑定判定全理由 +
  优先级组合 + 字典序 TTL 边界 now===expiresAt → EXPIRED_AT_REPLY fail closed）、
  `tests/unit/store-database.test.ts`（v2→v3、fresh→3）、`tests/unit/store-records.test.ts`
  （create 的 SUPERSEDED-before-insert 同事务不变量：先建一条 PENDING 再 create 同
  command 新记录 → 旧记录 SUPERSEDED/REISSUED 新记录 PENDING、同事务原子性——注入
  insert 失败则旧记录仍 PENDING；thread_key UNIQUE 冲突抛错；findByThreadKey/
  findPendingByCommandId；transition 全链路）；
- 分层红线：clarificationState 零 IO；better-sqlite3 仅 store。

---

## 任务列表

### Task 1: 状态机 + 绑定判定（domain）

**Files:** Create `src/domain/clarificationState.ts`; Test `tests/unit/domain-clarification-state.test.ts`。

- [ ] 失败测试：4×4 矩阵；IllegalTransitionError machine='clarification'；绑定判定
  四理由各至少一例 + null token/version 的 fail closed + 理由优先级（NOT_PENDING 压过
  TOKEN_MISMATCH 压过 VERSION_STALE 压过 EXPIRED_AT_REPLY，构造多重违规夹具）+
  now===expiresAt 边界拒绝 + 全要素正确 → ok。
- [ ] RED → 实现 → GREEN → commit。

### Task 2: migration 003 + ClarificationStore

**Files:** Create `src/store/clarificationStore.ts`; Modify `src/store/migrations.ts`;
Test 并入 `tests/unit/store-database.test.ts`、`tests/unit/store-records.test.ts`。

- [ ] 失败测试：v2 库升 v3 表存在、fresh 直达 3；create/findByThreadKey 往返；
  同 command 重发 → 旧 PENDING 全部 SUPERSEDED(REISSUED) 且同事务原子（注入失败回滚）；
  thread_key UNIQUE 冲突；transition read-assert-write（非法转移行不动，unknown id 报错）；
  updated_at=now≠created_at 变异杀手。
- [ ] RED → 实现 → GREEN → commit。

### Task 3: 批次收尾

- [ ] 四件套全绿；本计划完成记录（含移交说明：router 接线点、EXPIRED 触发时机归 daemon、
  邮件格式等真机走查）；threat-model C8 补 *Evidence (partial)*；architecture 表；
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：行 205「绑定 token + thread + 候选版本」+ C8 的 TTL 与隔离语义全部映射；
  行 213 真机走查边界显式排除邮件格式。
- 类型一致性：四状态机同构复用 IllegalTransitionError；store 先例 D-P2-2；
  ISO 字典序比较与 readyAt 栅栏同款。
- 与 P0-2 无耦合：不含任何 session 概念；与红线 3 无耦合：不发信。
- 无占位符：每测试点具体（含同事务原子性注入失败用例）。
