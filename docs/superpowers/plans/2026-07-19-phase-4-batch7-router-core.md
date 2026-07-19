# Phase 4 批次七：路由核心 + thread↔session 映射 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Phase 4 路由的确定性核心：抽取后的项目词 → 项目索引精确候选 →
四种裁决（继续会话 / 新派单 / 需澄清 / 无候选澄清），与 thread↔session 映射的
持久化（migration 004 + SessionStore）。**低置信永远澄清而不猜测**（spec §6）。

**Architecture:** 与 checkClarificationBinding 同构的纯函数路由（收「已抽取值」，
邮件格式/词抽取明确排除——spec 213 行真机走查后 Phase 4 正式阶段锁）；store 沿
D-P2-2 read-assert-write 先例；session 概念此处只指 **driver 会话映射行**，
候选评分不涉 P0-2 之外的任何假设（driver_session_id 就是 ADR-0004 的 thread_id）。

**Tech Stack:** TypeScript strict + ESM、better-sqlite3（仅 store）、vitest。

**范围裁定（明确排除）：** 词抽取与邮件格式（真机走查后）；澄清邮件生成/回复
解析（同前）；dispatch 管线组装（下批：driver+worktree+outbox 接线）；EXPIRED
扫描与索引重建时机（daemon）；识别网关接线（等 ADR-0003）。

---

## 锁定决策

### D-P4B7-1 路由裁决（src/domain/routing.ts，纯函数零 IO）

```ts
export interface RoutingSessionView {
  /** 该 thread 已有的会话映射（router 由 threadKey 查得）；无则 null。 */
  projectPath: string;
  driverSessionId: string | null;   // thread.started 前可为 null
}
export interface RoutingCandidate { name: string; path: string; }
export interface RouteInput {
  /** 已抽取的项目词；抽取失败/缺失 = null（fail closed → 澄清）。 */
  term: string | null;
  /** threadKey 查到的既有会话；新线程 = null。 */
  existingSession: RoutingSessionView | null;
  /** projectIndex.lookup(term) 的结果（router 调用方执行查找后传入，
   *  保持本函数纯性；term 为 null 时传空数组）。 */
  matches: readonly RoutingCandidate[];
}
export type RouteVerdict =
  | { kind: 'CONTINUE_SESSION'; session: RoutingSessionView }
  | { kind: 'DISPATCH_NEW'; project: RoutingCandidate }
  | { kind: 'CLARIFY_AMBIGUOUS'; candidates: readonly RoutingCandidate[] }
  | { kind: 'CLARIFY_NO_MATCH' };
export function routeCommand(input: RouteInput): RouteVerdict;
```

- 优先级固定（每级各测 + 组合胜出测试）：
  1. `existingSession !== null` ⇒ CONTINUE_SESSION（线程连续性压过一切——
     回复既有线程即是「继续」，词重解释归回复解析批次，doc 注明）；
  2. `matches.length === 1` ⇒ DISPATCH_NEW（唯一精确命中才派单）；
  3. `matches.length > 1` ⇒ CLARIFY_AMBIGUOUS（candidates 原序透传，上限
     裁剪归澄清邮件生成方）；
  4. 其余（term null / matches 空）⇒ CLARIFY_NO_MATCH（**绝不猜测**；
     "列出全部项目供选"的候选组装归澄清批次——本函数不接收全量索引，
     防止在此偷偷做模糊匹配）。
- doc 锁定：本函数**永不**返回任何"模糊/近似"结果——精确查找之外一律澄清
  （C7 的 lookup 精确性 + spec 低置信原则的路由落点）。

### D-P4B7-2 migration 004 + SessionStore（src/store/sessionStore.ts）

```sql
CREATE TABLE agent_sessions (
  id INTEGER PRIMARY KEY,
  thread_key TEXT NOT NULL UNIQUE,
  project_path TEXT NOT NULL,
  driver_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_path);
```

- user_version 3 → 4；表全新无回填；
- Store API：`create({threadKey, projectPath, now})`（driver_session_id 初始
  NULL——会话先于 thread.started 存在）、`findByThreadKey`、
  `recordDriverSessionId(id, driverSessionId, now)`（**首写不变量**：仅当现值
  为 NULL 时写入；已有非 NULL 且不同 ⇒ 抛错（同 thread 的 driver 会话不许
  被静默替换——resume 复用同 id 是 ADR-0004 实测语义，变化即异常）；相同则
  幂等更新 updated_at）、`listByProject(projectPath)`（按 id 序）；
- thread_key UNIQUE 冲突抛错（同线程重复 create 是上游 bug，fail closed）；
- 时间戳沿 `.toISOString()` doc-only 生产纪律（readyAt 先例，字段 doc 写明）。

### D-P4B7-3 测试与边界

- `tests/unit/domain-routing.test.ts`：四裁决各至少一例；优先级组合
  （有会话 + 唯一命中 ⇒ CONTINUE；有会话 + 空命中 ⇒ CONTINUE；无会话 +
  多命中 + term 非空 ⇒ AMBIGUOUS；term null + matches 空 ⇒ NO_MATCH；
  term null 但 matches 非空 ⇒ 按 matches 数裁决——doc 注明该入参组合
  理论上不该出现但函数行为仍确定）；candidates 原序透传断言。
- `tests/unit/store-database.test.ts` 并入：v3→v4、fresh 直达 4（既有阶梯
  tip 测试 3→4 机械跟进，002/003 子阶梯用例不动——b96e474/e41e664 先例）；
  `tests/unit/store-records.test.ts` 并入 SessionStore：create/findByThreadKey
  往返（driver_session_id null）、recordDriverSessionId 首写/幂等重写/冲突抛
  （行不动断言）、thread_key UNIQUE 抛、listByProject 序、FK 无（本表不引用
  commands——会话跨多命令，doc 注明设计）、updated_at 变异杀手。
- 分层红线：routing.ts 零 IO；better-sqlite3 仅 store。

---

## 任务列表

### Task 1: 路由裁决（domain）

**Files:** Create `src/domain/routing.ts`; Test `tests/unit/domain-routing.test.ts`。

- [x] 失败测试先行（D-P4B7-3 第一组全部）。
- [x] RED → 实现 → GREEN → commit。

### Task 2: migration 004 + SessionStore

**Files:** Create `src/store/sessionStore.ts`; Modify `src/store/migrations.ts`;
Test 并入 `tests/unit/store-database.test.ts`、`tests/unit/store-records.test.ts`。

- [x] 失败测试先行（D-P4B7-3 第二组全部，含既有阶梯 tip 测试 3→4 机械跟进）。
- [x] RED → 实现 → GREEN → commit。

### Task 3: 批次收尾

- [x] 四件套全绿；threat-model C8 评注补一句（路由裁决的低置信澄清落点）；
  architecture 表新增 router core 行；完成记录（移交说明：词抽取/澄清邮件
  组装等真机走查、dispatch 接线下批、recordDriverSessionId 的调用时机 =
  driver thread.started 后由 dispatch 管线负责）；
- [x] commit + push。

---

## 完成记录（2026-07-19）

三任务闭环。测试基线 29 文件 / 553 → **30 文件 / 576**（+23：T1 路由 13、
T2 会话映射 9、T3 收尾补 FK pragma 断言 1；572 通过 + 4 live 默认 skip）；
四件套全绿；零模型额度、零发信。

### Commit 轨迹

| Commit | 内容 |
| --- | --- |
| `29e0011` | 本计划落盘 |
| `2eba7b7` | T1 routeCommand 四裁决纯函数（13 测试：2×3 组合、原序透传、term-null-matches-非空的确定性行为） |
| `102db4c` | T2 migration 004 + SessionStore（+9 测试：往返/首写四分支/UNIQUE fail-closed/序/updated_at 变异杀手；三个既有测试文件 tip 断言机械跟进） |
| 本提交 | T3 收尾：FK pragma 断言（审查 Minor-1）、threat-model C8、architecture 表、完成记录 |

### 审查结论

**✅ APPROVED，零 Critical/Important，3 Minor 全为移交素材。** 审查员抽验
实现者宣称的 7 轮变异 **7/7 属实**（会话优先级弱化 / 唯一命中放宽 ≥1 /
candidates 重排 / 幂等改 no-op / 首写改覆盖写 / ORDER BY 反转 / 索引抹除，
每轮精确击杀对应用例），另自行跑 2×3 穷举矩阵（分布逐格一致）、
Object.freeze 无变异探针、verdict 引用同一性实验。三个既有测试文件的
每处改动逐条裁定为"意图保全的机械跟进"，无一处把该红断言改绿。

### Minor 处置

1. FK 无外键仅 doc 落地 → 本提交补 `PRAGMA foreign_key_list(agent_sessions)`
   为空的运行时断言，设计钉死。
2. 计划句「002/003 子阶梯用例不动」的假设不精确：003 块基线按 ladder tip=3
   写，migration 004 落地后必然要钉 `version <= 3`（断言值一字未改，
   e41e664 先例同构）。记录为计划措辞教训：「子阶梯用例不动」应表述为
   「子阶梯断言意图不动」。
3. verdict 载荷为输入对象的透传引用（candidates 两侧 readonly 编译期封死；
   RoutingSessionView/RoutingCandidate 字段级 readonly 是未来加固候选，
   属计划变更需新决策，不在本批）。

### 移交说明

1. **词抽取与邮件格式**：routeCommand 只收「已抽取的 term」；从邮件主题/
   正文抽取 term 的规则、澄清邮件的候选展示格式，等真机走查（spec 213 行）
   后另批锁定。
2. **dispatch 接线归下批**：lookup（projectIndex.exactLookup）→ routeCommand
   → 按裁决分派（DISPATCH_NEW ⇒ intent + worktree + driver；CONTINUE_SESSION
   ⇒ resume；CLARIFY_* ⇒ 澄清流程）。`recordDriverSessionId` 的调用时机 =
   dispatch 管线观察到 thread.started 之后（sessionStore 模块 doc 已写）。
3. **CLARIFY_NO_MATCH 的候选组装**（"列出全部项目供选"）归澄清邮件组装批次
   ——routeCommand 结构上拿不到全量索引，这是防模糊匹配的设计而非疏漏。
4. **EXPIRED 扫描 / 索引重建时机**归 daemon 批次；识别网关接线仍等 ADR-0003。

---

## Self-review notes

- spec 覆盖：§3 路由「project/session candidate scoring」的确定性半边 +
  §6「低置信永远澄清而不猜测」直接成为 D-P4B7-1 的锁定不变量；C8 的
  thread↔session 映射持久化落地。
- 类型一致性：RoutingCandidate 与 ProjectEntry 字段子集对齐（name/path）；
  store 先例 D-P2-2；四状态机/绑定判定的纯函数风格延续。
- 与真机走查解耦：函数收抽取后值；与 ADR-0003 解耦：不触识别网关；
  与红线 5 解耦：不跑 codex。
- 无占位符：每测试点具体。
