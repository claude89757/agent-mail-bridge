# Phase 4 批次九：结果回信组装 + C9 scrub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 C9 的渲染半边（批次六/八连续两批置顶的**不可选义务**）：
把 `DispatchOutcome` 变成**已脱敏**的 `OutboundMail`（`subjectRedacted`/
`bodyRedacted` 字段名即契约）——事件文本按设计携带真实 worktree 路径，
进邮件正文前必须 scrub + 限大小 + secret 启发式遮盖，全部纯函数零 IO
零发信。

**Architecture:** `src/domain/replyComposition.ts` 纯组装（domain 零 IO 红线；
scrub 上下文由调用方注入，测试用夹具值）；产物直接是 `OutboundMail`
（transport seam 现成入参）；spec §2 继承资产「结果回信：限大小 +
secret/路径/diff 脱敏；固定收件人为 self」中收件人锁定已由 C9 传输半边
机械完成，本批补渲染半边。**结果回信不受真机走查 gate**（spec 开放问题 2
只锁澄清邮件的候选展示格式）。

**Tech Stack:** TypeScript strict + ESM、vitest。零新依赖。

**范围裁定（明确排除）：** 澄清邮件组装 + 澄清记录/token（真机走查 +
outbox 事务同批设计）；实际发送与 outbox 入队接线（daemon 批次）；
In-Reply-To 线程头（SmtpMessage 六键是 C9 机械锁，扩键是传输层的
显式 schema 决策，另批）；词抽取/邮件格式解析（走查后）；识别网关
（ADR-0003）。

---

## 锁定决策

### D-P4B9-1 scrub 纯函数（同文件内先定义，组装器只准经它输出）

```ts
export interface ScrubContext {
  /** 会话 worktree 绝对路径；无（如 dispatch-failed 早期失败）传 null。 */
  worktreePath: string | null;
  /** 调用方注入 os.homedir()；domain 不碰 node:os（零 IO 红线）。 */
  homeDir: string;
}
export function scrubText(text: string, ctx: ScrubContext): string;
```

- 路径遮盖：worktreePath 先、homeDir 后（driver 先例——worktree 常在
  home 下，反序会把 worktree 路径撕成 `<home>/...` 残片）；占位符沿用
  driver 字面量 **`<cwd>`/`<home>`**（跨层一致，用户在邮件与日志里看到
  同一词汇）；空串/单字符 needle 不替换（needle 长度 ≥ 2 守卫，driver
  先例）；worktreePath null 时只做 home 遮盖；
- secret 启发式（**诚实定位：启发式地板，非担保**，doc 原话写明）：
  1. 关键词行遮值：`/(api[_-]?key|token|secret|password|passwd|credential)([^\S\n]*[:=][^\S\n]*)(\S+)/gi`
     → 保留关键词与分隔符，值替换为 `<redacted>`；
  2. 长 token 遮盖：连续 `[A-Za-z0-9+/=_-]{48,}` → `<redacted:${len}ch>`
     （48 阈值让 40-hex 的 git commit sha 与 UUID 存活——结果回信里
     sha 是有用信息；阈值与取舍 doc 写明）；
- 处理次序固定并测试钉住：**路径遮盖 → 关键词遮值 → 长 token**（路径
  先行，避免路径串被长 token 规则撕碎后残留可拼回的片段）；
- scrubText 幂等（对已 scrub 输出再跑一遍结果不变——占位符不含触发
  模式；测试钉住）。

### D-P4B9-2 大小上限（常量导出，daemon/测试共用）

```ts
export const EVENT_TEXT_CAP = 2_000;      // 单事件文本上限（字符）
export const BODY_TOTAL_CAP = 16_000;     // 正文总上限（字符）
```

- 单事件超限：截断 + ` …[truncated ${dropped}ch]`（大 diff 的脱敏由
  此上限机械覆盖——doc 写明这是 spec「大 diff 脱敏」的 v0.1 实现路径：
  截断策略对 diff 与散文一视同仁，不做 diff 语法识别）；
- 正文总装配超限：**保头保尾**——头部（状态行/元信息区）永不截，事件
  区从最旧开始丢整条，丢弃处插一行 `[${n} earlier events omitted]`；
  终态事件永不丢（结果是回信的存在意义）；
- 截断发生在 scrub **之后**（先脱敏再截断，绝不让截断把遮盖动作截没
  ——driver 的 scrub-before-truncate 先例，测试用"秘密横跨截断线"
  夹具钉住）。

### D-P4B9-3 组装器（输入形状与产物）

```ts
export interface ReplyContext {
  /** 原命令邮件主题；null ⇒ 回退主题。组装内同样过 scrub。 */
  originalSubject: string | null;
  commandId: number;
  intentId: string;
  /** 展示用项目名（index 的 name，非路径）；无则 null。 */
  projectName: string | null;
  scrub: ScrubContext;
}
export function composeResultReply(ctx: ReplyContext, outcome: {
  verdict: 'DISPATCH_NEW' | 'CONTINUE_SESSION';
  terminal: { kind: 'completed'; resultText: string } | { kind: 'failed'; errorText: string };
  events: readonly DriverEvent[];
}): OutboundMail;   // terminal completed ⇒ kind 'RESULT'；failed ⇒ 'ERROR'
export function composeDispatchFailedReply(ctx: ReplyContext, failure: {
  stage: 'SESSION_STATE' | 'WORKTREE' | 'DRIVER_START';
  reason: string;
}): OutboundMail;   // kind 'ERROR'
export function composeDryRunReply(ctx: ReplyContext, verdict: RouteVerdict): OutboundMail;
                    // kind 'RESULT'（dry-run 的产物就是"本会发生什么"报告）
export function composeAckReply(ctx: ReplyContext, info: {
  verdict: 'DISPATCH_NEW' | 'CONTINUE_SESSION';
}): OutboundMail;   // kind 'ACK'（是否发送由 daemon 配置决定，本批只提供组装）
```

- 主题：`originalSubject` 非 null ⇒ 已有 `re:` 前缀（大小写不敏感、
  容忍多重）则原样，否则加 `Re: `；null ⇒ `amb: task update`；主题同样
  过 scrubText + 单行化（CRLF→空格；nodemailer 折叠是传输层背书，
  语义单行是组装层责任）+ 上限 200 字符截断；
- 正文结构（固定骨架，测试断言分区存在与次序）：
  1. 状态行：`✅ completed` / `❌ failed` / `❌ dispatch failed (<stage>)` /
     `🔍 dry-run`（+ verdict 种类）；
  2. 元信息区：project（projectName ?? '(unknown)'）、intent id、
     verdict；**绝不含路径**（projectName 是索引名不是路径；
     worktree 路径即使想展示也必须是 `<cwd>` 占位后的——正文里任何
     路径都只能以占位符形态存在）；
  3. 事件区（result/ack 之外的组装器可为空）：每事件一行
    `[agent] <text>` / `[tool] <summary>`，逐条 scrub + 单事件 cap；
  4. 终态区：completed ⇒ resultText（scrub 后）；failed ⇒ errorText
     （scrub 后；driver 合成 errorText 已 scrub 过 cwd/home，此处对
     agent 产生的 failed 文本再兜一层——幂等性让双 scrub 无害）；
- `commandId` 透传入 OutboundMail；kind 映射如签名注释；
- dry-run 正文含四种 verdict 的人话（CONTINUE/DISPATCH_NEW/两种 CLARIFY
  ——dispatch 层澄清短路不产回信，但 dry-run 的"本会澄清"报告合法，
  doc 注明差别）；CLARIFY 候选列表逐项 `name` 展示（**不展示 path**）。

### D-P4B9-4 测试（tests/unit/reply-composition.test.ts 新建）

- 泄漏金丝雀（本批灵魂，全部变异验证）：夹具事件文本嵌入
  `/tmp/fixtures/wt-a/deep/file.ts`（=worktreePath 下）、`/tmp/fixtures/home-x/.ssh/id_rsa`
  （=homeDir 下）、`Api_Key: Aa-Aa-Tok-0001`、64 字符低熵长串（如 64×'a'）
  → 断言产物 subject+body 中：原始路径零出现（`<cwd>`/`<home>` 在）、
  关键词值变 `<redacted>`、长串变 `<redacted:64ch>`；
- scrub 单元：次序（路径先于长 token——构造 48+ 字符路径夹具证明反序
  会撕碎）、幂等、needle ≥2 守卫、null worktreePath、40-hex sha 与 UUID
  存活断言；
- cap：单事件截断尾标、总量保头保尾（终态在、最旧事件被丢、omitted 行
  计数对）、秘密横跨截断线（scrub 先于截断的证明夹具）；
- 组装器：四组装器各 happy 一例 + 分区次序断言；主题 Re: 逻辑三例
  （无前缀/已有 re:/null 回退）+ 主题截断 + 主题里嵌路径被 scrub；
  ERROR 的 stage 前缀（`WORKTREE: ` 等，批次八逐字先例）原样进正文；
  dry-run 四 verdict 各一例（CLARIFY 候选只见 name 不见 path 断言）；
- 夹具纪律：全合成路径（/tmp/fixtures/*）、低熵 token 占位、零真实值。

---

## 任务列表

### Task 1: scrub + cap 半边

**Files:** Create `src/domain/replyComposition.ts`（scrubText/常量/内部截断
helpers）; Test `tests/unit/reply-composition.test.ts`（scrub/cap 部分）。

- [x] 失败测试先行（D-P4B9-4 前三组）。
- [x] RED → 实现 → GREEN → commit。

### Task 2: 四组装器

**Files:** Modify `src/domain/replyComposition.ts`; Test 同文件追加。

- [x] 失败测试先行（D-P4B9-4 组装器组）。
- [x] RED → 实现 → GREEN → commit。

### Task 3: 批次收尾

- [x] 四件套全绿；threat-model C9 渲染半边翻证据（金丝雀 + 双层防御
  描述）；architecture 表新增回信组装行、not-started 行刷新；完成记录
  （移交说明：daemon 接线 outcome→compose→transport.send 与 ACK 开关、
  In-Reply-To 扩键是显式传输层决策、澄清组装等走查）；
- [x] commit + push。

---

## 完成记录（2026-07-19）

三任务 + 一轮审查修复闭环。测试基线 31 文件 / 605 → **32 文件 / 649**
（+44：T1 scrub/cap 21、T2 组装器 20、审查修复 +3；645 通过 + 4 live
默认 skip）；四件套全绿；零 IO、零发信、零新依赖。批次六/八连续置顶的
C9 渲染 scrub 义务就此闭环。

### Commit 轨迹

| Commit | 内容 |
| --- | --- |
| `f15969a` | 本计划落盘 |
| `be0c82c` | T1 scrubText + caps（路径占位 → 关键词遮值 → 长 token 固定次序；scrub 先于截断；幂等） |
| `7e028fc` | T2 四组装器（RESULT/ERROR/dry-run/ACK → 已脱敏 OutboundMail；CLARIFY 候选只渲染 name） |
| `d9265ff` | 审查修复：主题**先单行化再 scrub**（I-1）+ needle 尾斜杠归一（M-1）+ verdictKind 类型收窄（M-2） |
| 本提交 | T3 收尾：threat-model C9 渲染半边翻证据 + 残余说明、architecture 表、完成记录 |

### 审查结论

初审 **NEEDS_FIXES（1 Important + 4 Minor）**，修复后按审查员明示免复审。
审查规模为九批之最：44 组对抗探针（尾斜杠/大小写/路径嵌长 token/主题
换行胶合攻击/越权候选 path/漏斗逐条）、20k 种子幂等 fuzz、ReDoS 计时
（1MB < 250ms）、正则 lastIndex 状态检查、编译钉三连实证（TS2741/TS2322
+ narrow 方向）、5/5 变异抽验击杀。

**I-1（计划级缺口，教训归档）**：计划 D-P4B9-3 原文的「过 scrubText +
单行化」次序放行了换行胶合攻击——`password:\n值` 形主题在 scrub 时因
关键词规则的换行守卫不咬，随后单行化把键值胶合回一行进入
`subjectRedacted`。修复把单行化挪到 scrub 前（严格更安全：胶合只多咬
不漏咬，空格拼不出路径 needle），回归测试经 M13 次序变异精确击杀
（1 failed | 43 passed）。**漏斗次序普适教训：归一化必须先于遮盖**——
后续任何脱敏漏斗（澄清邮件组装等）沿用此序。

### Minor 处置

- M-1 needle 尾斜杠归一：已修（含 `///` 退化为空被守卫弃用的测试）；
- M-2 metaLines verdictKind 收窄为 `RouteVerdict['kind'] | null`：已修
  （类型系统而非运行时 scrub 是这条线的防线，doc 注明）；
- M-3 大小写变体路径存活：**接受**——事件路径源自 bridge 自己传入的
  cwd（字节一致），刻意变体属对抗规避，超出启发式地板定位；残余说明
  已写入 threat-model C9；
- M-4 结构钉抓不到 OutboundMail 删字段（结构子类型允许多余属性）：
  良性方向，记录在案。

### 移交说明

1. **daemon 接线**：outcome→compose→`transport.send` 的编排 +
   `ScrubContext` 构造（worktreePath 取 session 行持久值、homeDir 注入
   `os.homedir()`——needle 尾斜杠已归一但仍应传规范形）+ ACK 是否发送
   的配置开关（组装器已备好，发不发是 daemon 的策略位）。
2. **In-Reply-To 线程头**：SmtpMessage 六键是 C9 机械锁，扩键（线程化
   回信，ADR-0002 已实测 X-GM-THRID 语义）是传输层显式 schema 决策，
   需专门批次带测试解锁，勿顺手加。
3. **澄清邮件组装**（含 CLARIFY_NO_MATCH 的"列全部项目"候选组装 +
   token/记录随 outbox 事务）仍等真机走查；届时脱敏漏斗沿用本模块
   scrubText 与「归一化先于遮盖」次序。
4. **kind='CLARIFICATION' 的组装器**不存在是刻意的（ComposedReplyKind
   窄集不含它）——澄清批次新增时同步扩集。

---

## Self-review notes

- spec 覆盖：§2 继承资产「结果回信：限大小 + secret/路径/diff 脱敏」
  逐项落地（路径=占位符、secret=双启发式、diff=cap 机械覆盖并 doc 定位）；
  C9 渲染义务（批次六移交 #1、批次八移交 #1）闭环；ACK/完成回信
  （Phase 3 出口件）组装侧齐备。
- 类型一致性：OutboundMail/OutboxKind/DriverEvent/RouteVerdict 全部
  现行导出零改动；DispatchOutcome 的消费形状与批次八产物逐字段对上。
- 纯性：domain 零 IO——homeDir 注入而非 os.homedir()；无日期、无随机。
- 诚实性：secret 启发式定位为地板非担保（doc 原话）；大 diff 走 cap 的
  实现路径 doc 写明。
- 无占位符：每测试点具体。
