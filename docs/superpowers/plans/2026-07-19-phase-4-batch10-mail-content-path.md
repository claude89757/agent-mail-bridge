# Phase 4 批次十：邮件正文通路 + 抽取 + daemon 前置查询面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 daemon 派发所缺的三样：① `IncomingMail` 增加解码后正文
（transport 下载 + MIME 解析注入面）；② 抽取纯函数（threadKey / term /
prompt——命令邮件的最小确定性格式在此锁定）；③ daemon ticks 需要而
store 尚缺的查询面。全部零发信（live 验证只读）。

**Architecture:** pre-1.0 内部 seam 直接改形状（D-P3B2-1 先例，不做兼容
垫片）：`IncomingMail.bodyText: string | null`；MIME 解析经注入面
`ParseMime`（生产 = mailparser `simpleParser` 包装，测试 = 脚本假件）；
抽取在 `src/domain/mailContent.ts` 纯函数零 IO；store 扩展沿各自先例。

**Tech Stack:** TypeScript strict + ESM、imapflow（既有）、**mailparser
（新增生产依赖）** + @types/mailparser（dev）、vitest。

**范围裁定（明确排除）：** daemon ticks 编排与回信发送接线（下批）；
澄清邮件组装/记录/token（真机走查）；识别网关（ADR-0003）；IDLE watch
（daemon shell 批次）；In-Reply-To 发信扩键（显式传输层决策，另批）；
E2E（红线 5）。

---

## 锁定决策

### D-P4B10-1 IncomingMail.bodyText + ParseMime 注入面

```ts
// transports/types.ts：IncomingMail 增字段（直接改形状，D-P3B2-1 先例）
/** 解码后的纯文本正文（text/plain 优先，无则 html 转文本的 mailparser
 *  缺省行为）；下载或解析失败 ⇒ null（fail open 到"无正文"而非抛：
 *  正文缺失由消费方兜底，抓取失败不该毒死整个 fetch 批）。 */
bodyText: string | null;
```

```ts
// transports/imapRead.ts：注入面
export type ParseMime = (source: Uint8Array) => Promise<{ text: string | null }>;
export function buildDefaultParseMime(): ParseMime;  // mailparser simpleParser 包装
```

- `fetchSince` 的 imapflow fetch 增拉 `source: true`（整封原文），逐封过
  `parseMime`；单封解析抛错 ⇒ 该封 `bodyText: null` 并继续（fail open
  语义 doc 写明——正文是增强信息，头部/uid 才是管线骨架）；
- `ImapReadTransportDeps` 增 `parseMime?: ParseMime`（缺省
  `buildDefaultParseMime()`）；测试假客户端脚本喂 source 字节；
- `tests/helpers/fakeTransport.ts` 与全部既有夹具机械补 `bodyText`
  （既有用例断言意图不动）；
- live 只读测试（既有 AMB_LIVE_TEST 单 gate 文件并入）：取邮箱既有邮件
  一封，断言 `bodyText` 非空且为字符串——**只打印布尔/长度，绝不打印
  正文内容**（红线 2：正文可能含真实路径）；
- mailparser 供应链注记：与 nodemailer 同作者生态（batch-5 先例），
  pnpm lockfile 钉版本。

### D-P4B10-2 抽取纯函数（src/domain/mailContent.ts，零 IO）

```ts
export interface ExtractedCommand {
  /** 线程锚：References 首 id ?? In-Reply-To ?? 本封规范化 Message-ID。
   *  三者皆缺 ⇒ null（上游 ingest 已拒 NO_MESSAGE_ID，实际不可达）。 */
  threadKey: string | null;
  /** 项目词：主题剥 re:/fwd: 链后的首个空白分隔 token，trim+lowercase；
   *  空 ⇒ null。 */
  term: string | null;
  /** 任务文本：正文 trim 非空 ⇒ 正文；否则主题剥链后全文；再空 ⇒ null。 */
  prompt: string | null;
}
export function extractCommand(input: {
  subjectRaw: string | null;        // headers 'subject' 首实例，无则 null
  bodyText: string | null;
  messageIdNormalized: string | null;
  references: readonly string[];    // headers 'references' 全实例透传
  inReplyTo: string | null;         // headers 'in-reply-to' 首实例
}): ExtractedCommand;
```

- **v0.1 命令格式最小论**（doc 锁定 + 真机使用后可廉价调整——纯函数）：
  主题首词 = 项目词，正文 = 任务文本；回复既有线程即「继续」（threadKey
  → session 映射已由路由裁决承担，term 在 CONTINUE 路径不参与）；
- re:/fwd: 剥链大小写不敏感、容忍多重与空白（`re: re: fix` → term
  `fix`）；References 取**首** id（线程根锚定——Gmail References 首项
  是根，spec 可靠性模型的 thread 锚定语义）；
- References/In-Reply-To 的 message-id 提取复用 `domain/identity.ts` 的
  规范化函数（有则复用，无则在本模块实现 `<...>` 提取 + trim+lowercase
  ——与 ingest 的 Message-ID 规范化**同款**，doc 写明同款依据）。

### D-P4B10-3 store 查询面扩展（各沿先例，均带测试）

1. `IntentStore`：`IntentSummary` 增 `commandId: number`（SELECT 列增
   `command_id`；既有 toEqual 夹具机械补字段）——daemon 的 PENDING feed
   要从 intent 找回 command；
2. `CommandStore.getById(id): CommandRecord | undefined`（uid/uidValidity
   在行上——重启恢复按 uid 重取邮件的入口）；
3. `OutboxStore.findByStatus(status): OutboxSummary[]`（按 id 序；新增
   `OutboxSummary` 映射既有行形状）——UNCERTAIN 对账的输入；
4. `ClarificationStore.findPendingExpiredBefore(now): ClarificationSummary[]`
   （`status='PENDING' AND expires_at <= ?`，按 id 序；`<=` 与
   `checkClarificationBinding` 的 `now >= expiresAt` 拒绝语义**同边界**，
   doc 交叉引用）——EXPIRED 扫描的输入。

### D-P4B10-4 测试

- transport：脚本假件喂 multipart source ⇒ bodyText 解出；解析抛错 ⇒
  null + 其余邮件不受影响（fail open 钉住）；既有用例机械跟进逐条
  意图不变；live 只读 1 例（gate 内，零内容打印）；
- 抽取：threadKey 三级回退各一例 + 全缺 null；re: 链剥离（多重/大小写/
  fwd）；term 空主题/纯空白 null；prompt 正文优先/回退主题/双空 null；
  规范化与 ingest 同款断言（同输入同输出对拍一例）；
- store：四扩展各自 round-trip + 序 + 边界（`<=` 含等号例）+ 既有夹具
  机械跟进；
- 红线：live 零发信零内容打印；夹具全合成。

---

## 任务列表

### Task 1: transport 正文通路

**Files:** Modify `src/transports/types.ts`、`src/transports/imapRead.ts`、
`tests/helpers/fakeTransport.ts`、`tests/unit/imap-read-transport.test.ts`、
`tests/live/imap-live.test.ts`（并入 1 只读例）、`package.json`（mailparser）;
其余既有夹具机械跟进。

- [ ] 失败测试先行 → RED → 实现 → GREEN → commit。

### Task 2: 抽取纯函数

**Files:** Create `src/domain/mailContent.ts`; Test `tests/unit/mail-content.test.ts`。

- [ ] 失败测试先行 → RED → 实现 → GREEN → commit。

### Task 3: store 查询面

**Files:** Modify `src/store/intentStore.ts`、`src/store/commandStore.ts`、
`src/store/outboxStore.ts`、`src/store/clarificationStore.ts`; Test 并入
既有 store 测试文件。

- [ ] 失败测试先行 → RED → 实现 → GREEN → commit。

### Task 4: 批次收尾

- [ ] 四件套全绿；live 只读证据；architecture 表行；threat-model 无新
  控制面（正文进入管线的 scrub 义务已由批次九漏斗承接，C9 补一句
  bodyText 是新泄漏源头且已有漏斗）；完成记录（移交：daemon ticks 接
  extractCommand + 查询面、格式最小论真机后可调、mailparser 供应链注记）；
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：§3 管线"自然语言邮件"的内容通路；命令格式最小论是本批
  显式设计裁定（doc 锁定、纯函数可廉价调整），不越真机走查 gate（该
  gate 只锁澄清候选展示格式——批次九已澄清）；可靠性模型的 thread 锚定。
- 类型一致性：IncomingMail 直改（D-P3B2-1 先例）；ParseMime 与 SpawnCodex/
  SmtpSend 注入面同构；store 扩展沿 D-P2-10。
- 红线：live 只读（AMB_LIVE_TEST 单 gate 即可，无发信）；正文内容绝不
  打印；mailparser 版本钉死。
- 无占位符：每测试点具体。
