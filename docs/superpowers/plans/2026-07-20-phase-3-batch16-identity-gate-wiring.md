# Phase 3/4 批次十六：识别网关接线（ADR-0003 极性反转）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ADR-0003（已接受，2026-07-20）的极性反转身份因子接进 ingest
门链：一封声称 `From==To==self` 的邮件若携带任何 `Authentication-Results`
头 ⇒ 它走过 MTA 认证管线 ⇒ 不可能是合法内部自发 ⇒ 隔离
（`AUTH_RESULTS_PRESENT`）；无该头 ⇒ 该因子放行。兑现 MVP 验收标准
「伪造 From … 0 触发（DKIM + echo gate）」的 DKIM 半边。**零真实运行**
（全合成夹具，真跑归 E2E 批次）。

**Architecture:** 新纯函数 `checkSelfSubmissionAuthFactor`
（`src/domain/authResults.ts`，复用现有 `parseAllAuthenticationResults`）
+ ingest 门链在 C1 之后、时间窗之前插入一道门。**presence-only 主判据**
（ADR-0003 accepted 实现 note）：AR 头存在即拒，比 pinned-authservId 过滤
更严格、不依赖魔法串、且极性反转下"多一条 AR 只会更倾向拒"故对注入天然
免疫；`authservId` 仅作 reject evidence（哪个 MTA stamp），不作放行过滤器。

**Tech Stack:** TypeScript strict + ESM、vitest。零新依赖、零 migration
（复用 `commands.status_reason` 存新 UPPER_SNAKE 值）。

**范围裁定（明确排除）：** 方案 B 真实伪造 From 对照件（用户未批，见
[[redline3-class-a-approved]]；本批用合成夹具验证攻击侧形态，8/8 外部样本
已在 ADR 佐证机制）；`checkDkimFactor` pass-requiring 形态（保留给未来
non-self-mail，本批不删不用）；config 新增 pinned-authservId 字段
（presence-only 不需要）；真实 E2E（红线 5，下一批）；IDLE watch。

---

## 锁定决策

### D-P3B16-1 极性反转因子（新纯函数）

`src/domain/authResults.ts` 追加（照 `checkDkimFactor` 风格；复用
`parseAllAuthenticationResults`；无 IO、不 throw）：

```ts
/** Reject reason for the inverted self-submission auth factor (ADR-0003).
 *  A single value today; kept as a named type mirroring IdentityReason so
 *  ingest's status_reason vocabulary stays greppable. */
export type SelfSubmissionAuthReason = 'AUTH_RESULTS_PRESENT';

/**
 * ADR-0003 (accepted) inverted-polarity factor for From==To==self mail.
 * PRESENCE is the trigger: any Authentication-Results header at all ⇒ the
 * mail traversed an MTA auth pipeline ⇒ external origin ⇒ reject. No header
 * ⇒ consistent with authenticated internal self-submission ⇒ pass. The
 * authservId (topmost parseable one, else null) rides along as reject
 * EVIDENCE — which MTA stamped it — never as an accept/ignore filter
 * (see the ADR's implementation note on why presence-only is strictly more
 * conservative than an authserv-id allowlist).
 */
export function checkSelfSubmissionAuthFactor(
  rawAuthResultsHeaders: readonly string[],
):
  | { ok: true }
  | { ok: false; reason: SelfSubmissionAuthReason; authservId: string | null };
```

- 实现：`length === 0 ⇒ { ok: true }`；否则
  `parseAllAuthenticationResults(rawAuthResultsHeaders)`，取第一个
  `authservId !== null` 的作 evidence（全 null 则 `authservId: null`），
  返回 `{ ok: false, reason: 'AUTH_RESULTS_PRESENT', authservId }`；
- **presence 基于原始头存在性**（`rawAuthResultsHeaders.length`），非 parse
  后内容——一条畸形/空 AR 头（`['']`）仍算 present（说明走过 MTA），仍拒。
  合法内部自发邮件 `headers.get('authentication-results')` 为 undefined ⇒
  调用点传 `[]` ⇒ pass。

### D-P3B16-2 ingest 门链接线

`src/application/ingest.ts`，在 C1（`checkIdentityC1`）**之后**、时间窗
（`isWithinWindow`）**之前**插入：

```ts
const authFactor = checkSelfSubmissionAuthFactor(
  mail.headers.get('authentication-results') ?? [],
);
if (!authFactor.ok) {
  return reject(authFactor.reason);
}
```

- 门链最终序：`insert → NO_MESSAGE_ID → echo → readyAt(BEFORE_READY) →
  C1(IDENTITY_*) → AUTH(AUTH_RESULTS_PRESENT) → window(QUEUED_WINDOW) →
  intent`；
- 顺序理由（doc 注释钉死）：**echo 必须先于 AUTH**——bridge 自己的回信是
  排障/对账的合法系统邮件，即便某路径给它盖了 AR 也应归 echo 而非隔离；
  **C1 必须先于 AUTH**——AUTH 因子的语义前提是"这封邮件声称自发"
  （From==To==self），非自发邮件先在 C1 以 `IDENTITY_*` 拒，不进入 AUTH
  判断（也不泄漏 AR 判据）；**AUTH 先于 window**——身份未过关的邮件不该
  仅因"在时间窗内"就 QUEUED_WINDOW 占位；
- `header name` 大小写：imapRead 已 `.toLowerCase()` 所有头名
  （`src/transports/imapRead.ts:227`），故键用小写 `'authentication-results'`
  ——与 echo gate 的 `'x-amb-outbox-id'` 同惯例；测试 pin 一条大小写混合
  输入头仍命中（走 IncomingMail 契约，key 已规范化）。
- `authservId` evidence：v0.1 **不落库**（`reject(reason)` 只写
  `status_reason`；`AUTH_RESULTS_PRESENT` 已足够定位）；evidence 由纯函数
  返回供测试断言与未来使用，ingest 层不额外记日志（ingest 无 log seam）。

### D-P3B16-3 文档状态同步（从 pending/blocked 改 wired）

- `docs/threat-model.md` C2：把"blocked on user accepting ADR-0003"段改为
  **已接线**——presence-only 极性反转落地、门链位置、伪造 From 合成夹具
  0-intent 证据；`checkDkimFactor` 保留说明；引用 ADR-0003 accepted；
- `docs/architecture.md`：identity-gate 那一行从 not-started/blocked 移入
  done（auth 因子接线，presence-only）；mermaid 管线图 identity 节点的
  "DKIM factor built, wiring pends ADR-0003" 注记改为 "wired (ADR-0003)"；
- `README.md`：Status「Not yet」段删掉 identity-gate wiring 一条（或移到
  已完成表述）；Security first Highlights 的 "DKIM factor is built and
  awaits wiring" 改为如实的已接线表述并保留 ADR-0003 链接；
- 三处措辞以**接线后的真实行为**为准（presence-only，非 dkim=pass 对齐）。

### D-P3B16-4 测试清单

**domain（`tests/unit/domain-auth-results.test.ts` 追加）**：
- 空数组 ⇒ `{ ok: true }`；
- 单条真实 gmail AR（`mx.google.com; dkim=pass header.d=...`）⇒ reject +
  `authservId === 'mx.google.com'`；
- 伪造场景：`mx.google.com; dkim=fail`（外部伪造 From:self 的典型形）⇒
  reject（presence 即拒，与 verdict 无关）；
- 空串头 `['']` ⇒ reject + `authservId === null`（presence-only 边界）；
- 多条 AR 头（转发链）⇒ reject，evidence 取第一个非 null authservId；
- 畸形头（无 `;`、乱字符）⇒ reject（不 throw）。

**ingest 集成（`tests/integration/ingest-pipeline.test.ts` 或
`tests/unit/ingest.test.ts` 沿现有组织）**：
- **无 AR 的合法自发** → `ready`（过 AUTH 门到 intent）；
- **带 AR 的伪造 From==To==self**（合成夹具：from/to 均 self + 一条
  `Authentication-Results`）→ `rejected` + reason `AUTH_RESULTS_PRESENT` +
  0 intent（**直接对应 MVP 验收「伪造 From 0 触发」**）；
- **门顺序 pin**：
  - echo 邮件即便带 AR ⇒ 仍 `echo`（echo 先于 AUTH，不被隔离）；
  - C1 失败（多收件人/CC/plus-tag/From≠self）即便带 AR ⇒ reason 仍是
    对应 `IDENTITY_*`（C1 先于 AUTH，AUTH 不抢跑）；
  - BEFORE_READY 邮件即便带 AR ⇒ reason 仍 `BEFORE_READY`；
  - 无 AR 但在时间窗外 ⇒ `QUEUED_WINDOW`（AUTH 先于 window：AUTH 过了
    才轮到 window 判断——用一封无 AR + 窗外邮件验证 AUTH 放行后走到
    window）。

**mutation 自证（实现者，≥2 条）**：
- 移除 ingest 的 AUTH 门 ⇒ 「带 AR 伪造邮件」测试红；
- AUTH 门错位到 C1 之前 ⇒ 「C1 失败带 AR ⇒ IDENTITY_*」顺序测试红
  （错位后会先报 AUTH_RESULTS_PRESENT）。

---

## 任务列表

### Task 1: 极性反转因子（纯函数 + 单测）

**Files:** Modify `src/domain/authResults.ts`、
`tests/unit/domain-auth-results.test.ts`。

- [x] RED → GREEN → mutation 自证 → commit。

### Task 2: ingest 门链接线 + 集成测试

**Files:** Modify `src/application/ingest.ts`、
`tests/integration/ingest-pipeline.test.ts`（+ `tests/unit/ingest.test.ts`
如现有门测试在此）。

- [x] RED → GREEN → mutation 自证 → commit。

### Task 3: 批次收尾（编排者）

- [x] 四件套全绿；threat-model C2 / architecture / README 三处状态同步；
  完成记录 + 移交；
- [x] commit + push。

---

## Self-review notes

- spec 覆盖：Phase 3 identity gate 的 provider-authentication 因子（C2）
  接线完成；MVP 验收「伪造 From 0 触发」的 DKIM 半边由合成夹具 0-intent
  测试兑现（真实伪造对照件=方案 B，未批，非阻塞）。
- 红线：6（外部行为不符 spec ⇒ 已按 ADR-0003 fail-closed 反转，用户已接受）；
  presence-only 是**收紧**非降级（符合红线 6"不得为绕过阻塞降低安全"）；
  零真实运行零发信。
- 一致性：门链序 echo→readyAt→C1→AUTH→window 有 doc + 顺序 pin 测试；
  reason 命名 UPPER_SNAKE 沿 IdentityReason/DkimFactorReason 惯例；header
  键小写沿 echo gate 惯例。
- 安全关键复核点（审查者重点挑战）：presence-only 主判据的 fail-closed
  论证是否成立（尤其"echo 先于 AUTH 会不会给攻击者可乘之机"——echo 需
  匹配已记录 outboxId，攻击者无法伪造；AUTH 隔离所有带 AR 邮件）。
- 无占位符：函数签名、门链位置、测试点、mutation 自证已具体。

---

## 完成记录（2026-07-20，批次十六收尾）

### 提交清单

| commit | 内容 |
| --- | --- |
| `3ca18ee` | ADR-0003 → accepted（含 presence-only 实现 note）+ 本 plan 落盘 |
| `e2e0b0c` | T1：`checkSelfSubmissionAuthFactor` 纯函数（presence-only，authservId 作 evidence）+ 8 单测；843→850 |
| `cc210d4` | T2：ingest 门链接线（C1→AUTH→window，doc 钉三条顺序理由）+ 集成 MVP「伪造 From 0 intent」+ 顺序 pin；850→859 |
| 本提交 | T3 收尾：threat-model C2 + :317 开放问题表、architecture mermaid 节点 + 状态表拆 done 行、README Status/Highlights/built 三处，全部 pending/blocked→wired；本记录 |

测试 843 → **859**（+16），四件套全绿，全程零真实运行零发信零 codex 额度。

### 审查故事（安全关键，钉 3ca18ee..cc210d4）

- **STATUS: APPROVED，零 Important**。审查者按本批安全等级做了三层核验：
  - **A 最终字节正确性**（因实现者报告过一次复原误操作）：独立逐行读
    committed `checkSelfSubmissionAuthFactor` 与 ingest 接线，确认 GREEN
    函数完整、无残留死代码/半改/极性反转，`e2e0b0c` 纯加法、
    `checkDkimFactor` 与 parser 字节未动。
  - **B presence-only fail-closed 挑战**：三根渗透探针全部被现有测试挡住
    ——P1（presence 改判 parse 后 `dkim.length`）在 `['']`/畸形头 fail-open
    但被 2 测抓；P2（AUTH 移到 echo 前）撞 echo/C1/readyAt 顺序 pin 3 红；
    P3（重新引入 `dkim=pass ⇒ accept` verdict-trust，即 ADR 警告的 fail-open）
    被 5 个 dkim=pass 夹具测试抓。构造不出「带 AR 却放行」的邮件。
  - **C mutation 重放**：4 条实现者宣称 + 3 条自选探针全部精确重放。
- 唯一 follow-up 即本 T3 文档同步（审查范围钉在两个实现 commit，文档同步
  本就 plan 划归 Task 3），已在本提交落地。

### 过程透明（实现者自报 + 审查独立核验）

T1 首次 mutation 复原一度误用「实现前」备份把 GREEN 函数抹掉，实现者经
`grep -c`（0 命中）当场发现、按对话原文重贴，并改用「实现后」`*.green.ts.bak`
备份供后续复原。审查 A 项独立读最终代码确认字节正确无净损失——这正是
「实现者自证 + 审查独立验证」双层防线起作用的实例：**mutation 复原只用
post-GREEN 备份 + diff 字节比对**这条纪律的价值再次被验证。

### spec / MVP 兑现

- MVP 验收「伪造 From、外部发件人、多收件人、系统回信：0 触发（DKIM +
  echo gate）」的 **DKIM 半边**落地：集成测试断言「From==To==self + AR 头
  → rejected `AUTH_RESULTS_PRESENT` + `intent count === 0`」端到端。
- 门链序 `echo → readyAt → C1 → AUTH → window` 是安全属性，有 doc + 顺序
  pin 测试双护。

### 移交清单

1. 真实伪造 From 对照件（方案 B）：用户未批、非阻塞（8/8 外部样本已佐证
   机制）；若未来要经验性钉死攻击侧形态再请批；
2. `authservId` evidence v0.1 不落库；未来取证定位需要时再评估落库；
3. E2E 真跑（红线 5，已批准）：下一步，含识别网关的完整链路。

### 经验沉淀

- **安全关键批的审查要「信任但独立验证」**：实现者报告复原误操作后，审查
  不满足于「实现者说已验证」，而是独立逐行读最终代码 + 重放全部 mutation
  ——这一层在本批直接确认了字节正确性，是安全批不可省的一环。
- **fail-closed 收紧优于忠实照抄**：ADR 原文勾了 pinned-authservId 过滤，
  实现选了更严的 presence-only 并在 ADR accepted note 记录理由；审查用 P1/P3
  探针反向确认「更严」不是空话（松回 verdict-trust 会 fail-open 且被测试抓）。
