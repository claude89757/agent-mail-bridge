# Phase 3 前置批次二：imap 读路径 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不触碰两个外部阻塞（红线 3 发信确认、codex CLI 决策）的前提下，落地
`MailTransport` 的真实 IMAP 读路径（fetchSince / markProcessed / close），并用
专用测试邮箱做一次只读 live 验证——红线 1 明确允许对该邮箱的读取。

**Architecture:** imapflow 1.4.7（P0-1 spike 已实测）实现 `ImapReadTransport`，
与 `tests/helpers/fakeTransport.ts` 面向同一 `MailTransport` seam；imapflow 客户端
经构造注入的工厂隔离，单元测试用脚本化 fake 客户端覆盖全部错误路径；live 集成
测试凭据缺失时显式 skip（CI 无凭据自动跳过，本地跑出证据）。

**Tech Stack:** TypeScript strict + ESM + nodenext、imapflow（devDep → dep）、
vitest、既有 `src/domain/uid.ts` `filterNewUids`。

**范围裁定（明确排除）：** SMTP `send`（等红线 3——live 验证发信不可先行）；
IDLE `watch` 长连接循环（daemon 批次——P0-1 已证 IDLE 可行，接线是 daemon 的
事件循环设计）；config 塑形（transport 收构造参数，host/port 由 daemon 批次接
config）；`markProcessed` 的 live 验证（本批次 live 一律零邮箱变更，flag 写入
只走单元 fake；live 变更验证并入 daemon 批次）。ADR-0002 维持 DRAFT（等发信半边）。

---

## 锁定决策

### D-P3B2-1 IncomingMail.headers 改多值映射（先行，独立成任务）

```ts
// src/transports/types.ts 内 IncomingMail 唯一改动：
headers: ReadonlyMap<string, readonly string[]>; // 头名小写；同名多实例按出现顺序
```

- 动机：`Authentication-Results` 合法地每转发跳一个实例；`parseAllAuthenticationResults`
  收 `readonly string[]`，单值 Map 会丢证据（身份门 C2 的原料）。pre-1.0 内部 seam，
  直改不留兼容层；两字段并存（headers + headersAll）的漂移风险大于一次性改动成本。
- 波及面（全部枚举，实现者验证）：`tests/helpers/fakeTransport.ts` 的构造/断言、
  `src/application/ingest.ts` 读 `X-AMB-Outbox-ID` 处（取首实例：`headers.get(k)?.[0]`，
  多实例回声判定语义不变——任一匹配即 echo？否：首实例即可，bridge 自发信只写一个；
  doc comment 说明）、既有测试中构造 IncomingMail 的每一处。断言语义不得变。

### D-P3B2-2 ImapReadTransport 形状与注入

```ts
// src/transports/imapRead.ts
export interface ImapClientFactory {
  connect(): Promise<ImapClientLike>; // 每次调用返回已 connect 的客户端
}
export interface ImapClientLike {
  // imapflow 表面的最小投影——只声明本模块真正调用的成员
  getMailboxLock(path: string, opts: { readOnly: boolean }): Promise<{ release(): void }>;
  mailbox: { uidValidity: bigint; uidNext: number } | false;
  search(query: { uid: string }, opts: { uid: true }): Promise<number[] | false>;
  fetchOne(uid: string | number, query: object, opts: { uid: true }): Promise<FetchedMessage | false>;
  logout(): Promise<void>;
}
export function createImapReadTransport(opts: { factory: ImapClientFactory }): MailTransport;
export function buildImapflowFactory(opts: {
  host: string; port: number; user: string; pass: string;
}): ImapClientFactory; // 生产接线：new ImapFlow({... logger: false}) —— logger 必须 false，红线 2（imapflow 默认 logger 会打印协议流，含地址）
```

- 连接策略 v0.1：每次 `fetchSince` 独立 connect→lock(readOnly)→操作→release→logout
  （无连接池/长连接——那是 IDLE/daemon 批次的事；正确性优先，P0-1 实测 connect≈2.5s 可接受）。
- `send`/未实现能力：`send` 抛 `Error('ImapReadTransport: send not implemented — awaits red-line-3 confirmation (SMTP batch)')`
  ——fail loud，绝不静默吞。接口要求四方法齐全，读传输显式拒绝写方法。
- `markProcessed`：`\\Seen` via `messageFlagsAdd`（`ImapClientLike` 增补该成员）；
  幂等（重复标记无害）；单元 fake 覆盖，live 不跑（零变更裁定）。
- `close()`：v0.1 每操作自管连接 → close 为 no-op（doc 说明为何）。

### D-P3B2-3 fetchSince 语义（正确性核心）

顺序固定，每步有测试：

1. connect；`getMailboxLock(mailbox, { readOnly: true })`——读路径永远只读打开；
2. **UIDVALIDITY 守卫（fail closed）**：`String(client.mailbox.uidValidity) !== uidValidity`
   → release/logout 后抛 `UidValidityChangedError`（typed，携带 `{ expected, actual }`）
   ——有界重扫是 application 层政策（spec §3.2 表），transport 只报告不擅动；
3. `search({ uid: \`${sinceUid + 1}:*\` }, { uid: true })`——RFC 3501 `n:*` 区间反转
   陷阱（P0-1 实测：无新邮件时仍返回 1 个 uid）由 **`filterNewUids(uids, sinceUid)`
   复用**兜住（src/domain/uid.ts，Task 7 已钉住），transport 不重新实现该逻辑；
4. 逐 uid `fetchOne`（envelope + internalDate + headers source + flags 按需）映射
   `IncomingMail`；fetch 返回 `false`（消息已 expunge 竞态）→ 跳过该 uid 不抛
   （at-least-once 语义，下轮补收；doc 说明）；
5. 结果按 uid 升序返回；finally 保证 release + logout（即使映射抛错）。

映射规则（每条一测）：
- `messageId`：envelope.messageId 原样（不去尖括号——Phase 2 store 存 raw；`null` 缺失）；
- `headers`：解析 RFC 5322 header 源文本（fetchOne 带 `headers: true` 取全部头），
  展开折叠行（CRLF/LF + WSP 续行），头名小写，同名按出现顺序聚成数组；解析器手写
  单遍扫描（与 authResults 同一 ReDoS 姿态：唯一容许正则为无嵌套量词的简单式），
  破损行丢弃不抛；
- `from`/`to`/`cc`：envelope 的 address 列表取 addr-spec（`mailbox@host` 拼接，
  display name 丢弃；缺失字段 → 空数组）；**不做** RFC 5322 完整解析——envelope
  是 IMAP 服务器已解析产物，信任其结构（doc 记录该信任边界）；
- `internalDate`：`.toISOString()`（Phase 2 备忘：readyAt 栅栏是字典序比较，
  必须此形状——测试钉住恰为该格式）；
- `uid` number、`uidValidity` `String(bigint)`、`mailbox` 回传入参。

### D-P3B2-4 live 只读集成测试（红线 1 允许的读取）

- `tests/live/imap-read-live.test.ts`（新目录 `tests/live/`，vitest include 已含
  `tests/**` 则无需配置改动——实现者验证）；
- 凭据探测：`tests/helpers/liveCreds.ts` 读 `~/.secrets/amb-test.env`
  （`AMB_TEST_IMAP_USER`/`AMB_TEST_IMAP_PASS`；文件缺失/键缺失 → `null`）；
  **值绝不打印/断言内容/进错误消息**（红线 2）；helper 有单元测试（临时目录夹具，
  占位值，绝不读真实路径——真实路径只在 live 测试运行时触达）；
- `describe.skipIf(creds === null)`：CI 无凭据显式 skip（vitest 报告 skipped，
  不伪装绿）；本地有凭据实跑；
- live 断言（全部只读，host 硬编码 imap.gmail.com:993——测试文件常量，非源码）：
  1. `fetchSince('INBOX', <live uidValidity>, <uidNext-1 附近>)` 返回数组；每封
     `internalDate` 匹配 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`、
     `uid > sinceUid`、headers 键全小写、`from`/`to` 元素形如 `x@y`；
  2. 错误 uidValidity（`'999999999'`）→ `UidValidityChangedError`（实测 fail closed）；
  3. `sinceUid = uidNext`（无新邮件）→ `[]`（n:* 反转陷阱端到端验证）；
  4. 断言只涉及形状/计数，**绝不**把地址、主题、正文写进断言消息或快照。
- live 运行由编排者本人执行并把输出贴完成记录（红线 1 边界内的读取，无需新确认；
  发信类动作一概不在本批次）。

### D-P3B2-5 依赖与工程位

- `imapflow` devDependencies → dependencies（transport 是发布产物）；nodemailer 维持
  devDep 不动（send 批次再动）；
- 分层红线不变：imapflow import 只出现在 `src/transports/**`；`domain/` 零 IO 不变；
- eslint no-console 全域有效（transport 无日志——imapflow logger:false）；
- 新增 typed error `UidValidityChangedError` 放 `src/transports/errors.ts`
  （transport 层错误，不进 domain/errors.ts——那里是状态机错误）。

---

## 任务列表

依赖：T1 先行（seam 改动波及全仓）；T2 依赖 T1；T3 依赖 T2（live 测试驱动真实现）；
T4 收尾。写者串行，审查并行（P5S/批次一模式）。

### Task 1: IncomingMail.headers 多值化

**Files:** Modify `src/transports/types.ts`、`tests/helpers/fakeTransport.ts`、
`src/application/ingest.ts`（`X-AMB-Outbox-ID` 读取处）、全部构造 IncomingMail 的测试。

- [ ] 失败测试：fakeTransport 构造多实例头（两个 `Authentication-Results`）→
  `headers.get('authentication-results')` 返回长度 2 数组按序；ingest 回声判定在
  headers 新形状下既有断言语义全绿；`X-AMB-Outbox-ID` 取首实例的行为有 doc + 测试钉住。
- [ ] RED → 实现 → GREEN → commit（枚举每处既有测试改动 + 一行理由）。

### Task 2: ImapReadTransport（fake 客户端单元测试）

**Files:** Create `src/transports/imapRead.ts`、`src/transports/errors.ts`;
Test `tests/unit/imap-read-transport.test.ts`。

- [ ] 失败测试（脚本化 fake ImapClientLike，记录调用序列）：happy path 映射全字段
  （含折叠头展开、同名头聚合、addr-spec 拼接、internalDate ISO 形状）；UIDVALIDITY
  不匹配 → typed error 且 release+logout 已调用；`n:*` 反转（search 返回 `[sinceUid]`）
  → `[]`；fetchOne 返回 false → 跳过不抛；映射中途抛错 → finally 仍 release+logout；
  send → 显式拒绝错误；markProcessed → messageFlagsAdd(['\\Seen']) 调用断言；
  close no-op；header 解析器破损行丢弃、无 ReDoS 正则（审查口径同 authResults）。
- [ ] RED → 实现 → GREEN → commit。

### Task 3: live 只读集成测试 + liveCreds helper

**Files:** Create `tests/helpers/liveCreds.ts`、`tests/live/imap-read-live.test.ts`;
Test `tests/unit/live-creds.test.ts`。

- [ ] 失败测试（helper 单元）：临时目录夹具解析两键；缺文件/缺键 → null；值不出现在
  任何错误消息。live 测试文件按 D-P3B2-4 全套断言编写，无凭据环境 skip 路径本地
  可先验证（临时 HOME 指向空目录跑一遍确认 skipped）。
- [ ] RED → 实现 → GREEN → commit（live 实跑由编排者执行，输出贴完成记录）。

### Task 4: 批次收尾

- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` 全绿 + live 运行证据；
- [ ] 本计划追加完成记录（commit 轨迹、测试计数、live 输出摘要、移交说明）；
- [ ] architecture 实现状态表拆行更新（imap 读路径 done；send/IDLE/daemon 仍 not started）；
  threat-model 若有新增证据点则补指针；
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：§3.2 可靠性映射中 `UID SEARCH` 补收、UIDVALIDITY 有界重扫的 transport
  半边（守卫报告）✓ T2；§3.1 MailTransport seam 不破坏 ✓（send fail-loud 占位）；
  多值 headers 缺口是 C2 接线的前置 ✓ T1。
- 类型一致性：`ImapClientLike` 最小投影在 T2 内一次定义；`UidValidityChangedError`
  T2 定义 T3 复用；`filterNewUids` 复用不重实现。
- 红线自查：零发信（send 显式拒绝）；live 只读 + skip 语义显式；凭据只在运行时读、
  值不进断言/日志/git；imapflow logger:false 钉住。
- 无占位符：每任务失败测试具体到断言；live 断言形状化、不含真实内容。
