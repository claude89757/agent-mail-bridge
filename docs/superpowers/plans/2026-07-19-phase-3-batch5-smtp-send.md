# Phase 3 批次五：SMTP 发送半边 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `ImapReadTransport` 补上真实 `send()`（nodemailer + Gmail SMTP 465），
按 ADR-0002 的实测证据落地 C3 回环防护（自铸 Message-ID + `X-AMB-Outbox-ID`）与
C9 的"收件人=自己"机械不可能性；活体验证走红线 3 已批 A 类动作（认证自发自收）。

**Architecture:** io 注入 + `buildDefault*` 先例（`smtpSend` 最小面注入，生产接线
`buildDefaultSmtpSend` 包 nodemailer）；发送顺序钉死 fakeTransport 已文档化的真实
顺序：铸 id → **await registerOutbox（落库先于提交）** → SMTP 提交 → resolve。

**Tech Stack:** TypeScript strict + ESM、nodemailer（本批次 devDeps → dependencies，
transport 是发布产物，照批次二 imapflow 先例）、vitest。

**范围裁定（明确排除）：** outbox 泵/重试/backoff（daemon 批次）；正文脱敏规则
（C9 内容批次——本批次收 `subjectRedacted`/`bodyRedacted` 原样用）；回信内容组装
（Phase 4）；selfAddress/凭据的 config 接线（daemon 批次，本批次构造参数注入）；
identity gate 极性反转接线（等 ADR-0003 用户裁决）。

---

## 锁定决策

### D-P3B5-1 注入形状（src/transports/imapRead.ts 扩展）

```ts
/** 最小 SMTP 提交面——生产为 nodemailer 包装，测试为捕获式 fake。 */
export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  headers: Record<string, string>;   // 恰好一个键：'X-AMB-Outbox-ID'
}
export type SmtpSend = (message: SmtpMessage) => Promise<void>;
export function buildDefaultSmtpSend(auth: { user: string; pass: string }): SmtpSend;
// nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth })
// 每次 send 复用同一 transport 实例；不设 logger/debug（红线 2）。

/** ImapReadTransport 构造参数扩展（原有读侧参数不动）： */
export interface ImapReadTransportSendDeps {
  selfAddress: string;               // to === from === selfAddress，唯一收件人来源
  smtpSend: SmtpSend;
  registerOutbox: (receipt: SendReceipt, mail: OutboundMail) => Promise<void>;
  mintOutboxId?: () => string;       // 默认 crypto.randomUUID；测试注入定值
}
```

- send 未配置（读侧单独构造，如现有测试/只读场景）时保持现状：抛
  `not implemented` 同款 loud 失败——**读侧构造零行为变化**。

### D-P3B5-2 send() 契约（每条一测）

1. **顺序不变量（C3 承重）**：铸 `outboxId = mintOutboxId()` →
   `messageId = '<amb-' + outboxId + '@agent-mail-bridge.invalid>'` →
   `await registerOutbox({outboxId, messageId}, mail)` → `await smtpSend(...)` →
   resolve receipt。register 抛出 ⇒ send 整体 reject 且 **smtpSend 绝不被调**
  （宁可不发也不发无记录的信）；smtpSend 抛出 ⇒ reject 原样上抛（行已落库，
   对账走 outbox UNCERTAIN 路径，daemon 批次接）。
2. **收件人机械锁死（C9）**：`to === from === selfAddress`；`OutboundMail`
   本就无收件人字段；测试对 fake 捕获的 message 对象做**键集合全等断言**
  （恰好 `from,to,subject,text,messageId,headers` 六键）——cc/bcc/replyTo
   等键出现即红，防未来"顺手"加字段。
3. **回环标记**：headers 恰好 `{'X-AMB-Outbox-ID': outboxId}`；
   `messageId` 与 receipt.messageId 全等；`@agent-mail-bridge.invalid` 域
  （RFC 2606 保留，doc 注明与 ADR-0002 的 Message-ID 保留证据）。
4. **内容原样**：subject/text 取 `subjectRedacted`/`bodyRedacted` 逐字节，
   不加前后缀（脱敏上游负责，transport 不二次加工）。
5. selfAddress 空串/全空白 ⇒ 构造时抛（identity.ts 空白守卫先例）。

### D-P3B5-3 测试

- 单测并入 `tests/unit/imap-read-transport.test.ts`：捕获式 fake `smtpSend` +
  事件日志（`register`/`smtp` 顺序钉住）+ 上述每条；mintOutboxId 注入定值
  断言 receipt 与 header 一致性；未配置 send 深构造仍抛 not-implemented。
- 活体 `tests/live/smtp-send-live.test.ts`：**双闸门**
  `describe.skipIf(!(AMB_LIVE_TEST==='1' && AMB_LIVE_SEND==='1') || creds===null)`
  ——既有 AMB_LIVE_TEST 只读运行**绝不**因本批次开始发信；夹具照批次二
  泄漏纪律（地址断言只打 true/false，失败路径只打构造名）。用例：真发 1 封
  （A 类动作，计入小量）→ `fetchSince` 读回 → 断言 `x-amb-outbox-id` 首实例
  === outboxId、Message-ID 往返全等、INTERNALDATE ≥ 发送前时刻。执行者为
  主会话（同批次二惯例），subagent 只写文件不跑活体。

### D-P3B5-4 nodemailer 依赖转正

`nodemailer` devDependencies → dependencies（`@types/nodemailer` 留 dev）；
照批次二 imapflow 先例，commit 与 T1 同笔。

---

## 任务列表

### Task 1: send() 实现 + 单测

**Files:** Modify `src/transports/imapRead.ts`、`package.json`（依赖转正）;
Test 并入 `tests/unit/imap-read-transport.test.ts`。

- [ ] 失败测试先行（D-P3B5-2 全五条 + 顺序事件日志 + 键集合全等 + receipt
  一致性 + not-implemented 现状保持）。
- [ ] RED → 实现 → GREEN → commit。

### Task 2: 活体发送验证测试文件

**Files:** Create `tests/live/smtp-send-live.test.ts`（复用 `tests/helpers/liveCreds.ts`）。

- [ ] 双闸门 + 泄漏纪律照批次二；写完后主会话亲自执行
  `AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 pnpm vitest run tests/live/smtp-send-live.test.ts`
  取证（1 封，A 类）。
- [ ] GREEN（活体 1/1）→ commit。

### Task 3: 批次收尾

- [ ] 四件套全绿；threat-model C3/C9 补 live 证据半句；architecture 表
  send 行翻 done；本计划完成记录（含移交说明：outbox 泵与 UNCERTAIN 对账归
  daemon、脱敏归 C9 批次、selfAddress config 接线归 daemon）；
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：§3 SMTP sender（固定收件人=self、自铸 Message-ID、X-AMB 头）
  逐要素映射；C3 顺序不变量与 Phase 2 fake 文档化顺序逐字对齐；C9 键集合
  全等断言把"机械不可能"落到测试。
- 类型一致性：`SendReceipt`/`OutboundMail` 用既有 seam 定义不改动；
  `SmtpMessage` 一次定义；注入模式与 buildDefault*Io 先例一致。
- 红线：活体测试双闸门 + 主会话执行；无新发信类别（仍是已批 A 类）；
  依赖转正有先例。
- 无占位符：每测试点具体。
