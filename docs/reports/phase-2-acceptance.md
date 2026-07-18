# Phase 2 验收报告 — 可靠事件核心

- 日期：2026-07-18
- 范围：spec §5 Phase 2（`docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md`）
- 实施计划：`docs/superpowers/plans/2026-07-17-phase-2-event-core.md`（Tasks 1–11，锁定决策 D-P2-1..11）
- 流程：每任务由独立实现者完成（严格 TDD），随后两阶段审查（spec 合规 → 代码质量）；审查发现的 Important 问题全部修复并复核后才推进下一任务。
- 验收 HEAD：`9ffaade`

## 1. 门禁四件套（在 `9ffaade` 上 fresh 运行）

| 检查 | 结果 |
| --- | --- |
| `pnpm lint`（eslint .） | ✅ 无输出，exit 0 |
| `pnpm typecheck`（tsc --noEmit） | ✅ 无输出，exit 0 |
| `pnpm build`（tsc -p tsconfig.build.json） | ✅ exit 0 |
| `pnpm test`（vitest run） | ✅ **Test Files 14 passed (14)，Tests 182 passed (182)** |

## 2. Phase 2 出口标准 → 证据映射

**出口原文**：模拟 IMAP 下，重复投递/乱序/崩溃重启均不产生重复命令；自发系统回信 100% 被识别为 echo。

| 出口/范围条目 | 证据（测试文件 / 用例） | 备注 |
| --- | --- | --- |
| 重复投递不产生重复命令 | `tests/integration/ingest-pipeline.test.ts` 用例一：50 封 ×3 重复共 150 次投递 ⇒ 恰 50 commands / 50 intents（结局账目 50 ready + 100 duplicate 精确断言）；`tests/unit/ingest.test.ts` duplicate 用例；`commands.message_id UNIQUE` | 传输层按 at-least-once 建模，去重责任在 store |
| 乱序投递 | 同用例一：文件内 LCG + Fisher-Yates 确定性洗牌（无 Math.random / Date.now）；spec 审查独立重放洗牌确认真乱序（uid=1 的三次出现散布在位置 97/125/130） | |
| 崩溃重启不产生重复命令 | `tests/integration/crash-recovery.test.ts`：(a) 事务中崩溃 ⇒ 全回滚（0 commands / 0 intents / watermark 回退到调用前值）后重试成功；(b) commit 后、transport ack 前崩溃 ⇒ 重投收敛 `duplicate`；(c) 文件库进程重启 ⇒ command/intent/watermark/readyAt 持久值逐项核对 + 重投 `duplicate` | (a) 经 `intentIdFactory` 注入 seam 实现，seam 向后兼容 |
| 自发回信 100% 识别为 echo | `ingest-pipeline` 用例二：20 发 20 反射 ⇒ `echoCount === 20`（严格相等，非 ≥）、0 新 intent、`SYSTEM_ECHO` ×20；unit 层双通道（`x-amb-outbox-id` 头 / 已知 outbox Message-ID）各有用例 | 对应 MVP「loop guard 100%」 |
| SQLite 状态机 | `src/domain/commandState.ts` + `outboxState.ts`（迁移映射即数据，状态数组由映射派生防漂移）+ `src/store` 写前二次校验；25 对 / 16 对全矩阵扫描测试 | 非法迁移一律 `IllegalTransitionError`，fail closed |
| 事务 outbox | `outbox` 表（D-P2-9）+ D-P2-3 状态机：PENDING→SENDING→{SENT, UNCERTAIN}，UNCERTAIN 唯一出路为 SENT | 无盲重发：PENDING→UNCERTAIN 直达被测试钉为非法 |
| 时间窗策略 | `src/domain/timeWindow.ts`（hourCycle h23、跨午夜、DST 回拨、排除日）+ ingest queued-window 用例（QUEUED_WINDOW、0 intent、reason `outside-hours`） | |
| dry-run 模式 | ingest 用例：`config.dryRun` ⇒ intent `dry_run = 1`（读回断言） | Phase 3 dispatcher 依此跳过真实执行 |
| 每个事务边界注入崩溃 | crash-recovery (a)/(b)/(c) 三个边界 + 附加：intent-id 碰撞 fail-closed 守卫测试（常量工厂制造碰撞，第二封整体回滚、第一封无损） | |
| MailTransport(imap-smtp) | 接口 `src/transports/types.ts`（D-P2-11）+ 内存 `FakeMailTransport`（at-least-once、uid 碰撞防护、registerOutbox 先于 resolve） | 真实 imap-smtp 实现按计划 self-review 裁定随 Phase 3 live loop 落地；P0-1 只读证据已收集（IDLE 25min×3 零掉线、UIDVALIDITY 稳定、push 实时） |

## 3. §6 MVP 验收标准中 Phase 2 可证条目

| MVP 条目 | 证据 | 状态 |
| --- | --- | --- |
| 无效邮件与窗口外邮件模型调用数为 0 | 构造性成立：整条 ingest 链为纯确定性代码，仓库无任何模型 SDK 依赖 | ✅（Phase 2 范围） |
| 伪造 From / 外部发件人 / 多收件人 / 系统回信：0 触发 | C1 五类违规逐一用例 + 优先级组合用例；混合流 5 封伪造全拒（`IDENTITY_FROM === 5`）；echo 20/20 | ✅（DKIM 因子属 Phase 3） |
| 每封控制邮件恰好一个持久 dispatch intent | `deriveIntentId` 确定性（di- + SHA-256 前 16 hex）+ `dispatch_intents.command_id UNIQUE` + 集成 50/50 + 碰撞守卫 fail-closed throw | ✅ |
| 崩溃/重启/重复投递不产生重复派发 | crash-recovery 三场景 + duplicate 收敛用例 | ✅ |
| 首次安装不执行历史邮件 | readyAt fence：`BEFORE_READY` 拒收用例 + `getReadyAt() === null` 时 `NO_READY_AT` fail closed | ✅ |
| 发送结果不确定时隔离对账、不盲目重发 | outbox 状态机：UNCERTAIN 唯一合法出路 SENT，SENT 终态 | ✅（真实 SMTP 对账随 Phase 3） |
| 仓库无任何真实凭据/邮箱/路径；CI 含 secret scanning | 每任务审查含 grep 核查（真实域名/本地路径零命中，仅 example.com/example.net 占位）；CI gitleaks | ✅ |

其余 MVP 条目（P95 < 60s、DKIM、澄清流绑定、10 分钟安装等）属 Phase 3–5 范围。

## 4. 质量流程证据（超出常规断言的验证）

- **mutation testing ×3**：(i) 质量审查在隔离 worktree 中改 `now = updated_at` 映射，证明该已裁决偏离无测试保护，随后补钉；(ii) Task 8 实现者对调 readyAt 与 C1 两 gate，仅链序测试失败且错误值符合预期，证明顺序测试有牙；(iii) Task 6 补测试时临时移除 UNCERTAIN→SENT 边，观察到目标 RED。
- **RED 独立重建**：Task 7 spec 审查在一次性 worktree 中只拷贝测试文件，重放 module-not-found RED，证明测试真实接线。
- **洗牌独立重放**：Task 9 spec 审查独立运行 LCG + Fisher-Yates，核实输出为真排列且重复项散布。
- 全部任务两阶段审查闭环；审查发现的 Important 问题（状态机注释误导、fakeTransport uid 碰撞陷阱、outbox 和解分支覆盖缺口）均已修复并复核。

## 5. 提交轨迹（Phase 2 主线，`17cb866..9ffaade`）

```
17cb866 ADR-0001 终选 better-sqlite3,Phase 2 事件核心计划定稿
77e404d store 层接入 better-sqlite3,跑通 schema v1 的 open + migrations
11da8fb 首开竞态与超前 schema 补上 fail-closed 防线
74716f4 补齐 Message-ID 幂等键与回声闸门,为 ingest 管线打地基
d40836b 收紧 Message-ID 校验并加类型品牌,防退化键吞掉合法命令
360c451 补齐身份闸门 C1,拦住伪造发件人与多收件人邮件
ce3c040 封住空 selfAddress 的 fail-open,配置校验先于邮件形状检查
a2f7079 补上时间窗策略,按本地时钟决定来信立即派发还是排队
3c69f88 改用 hourCycle h23 堵住 CLDR h24 午夜误判隐患
4317375 补上命令与 outbox 双状态机,非法迁移一律 fail closed
a75d8dc 补上四个持久化 store,为 ingestMail 打底
22ce620 修正状态机注释误导并让状态数组不再手工同步
8e46825 补齐 outbox 和解分支的 store 级测试覆盖
ae52772 补上传输层接口和内存假传输,堵住 P0-1 的 UID 范围反转坑
780300c 钉住 now=updated_at 契约并收敛 intent 摘要类型
353507d 落地 ingestMail 单事务用例,五种结局收敛到一条锁定链路
8fd1ce8 堵住假传输 uid 撞车陷阱,并钉住 send 失败契约
49421cf 补齐全链路集成测试,钉住重复乱序收敛与 echo 100% 识别
456496c 补齐崩溃恢复集成测试,钉住 ingestMail 三处事务边界
9ffaade 落实 Task 8 评审的四处小补丁,堵住幽灵 intent 与断言盲区
```

## 6. 遗留与前向备忘

- 真实 imap-smtp transport → Phase 3（P0-1 只读证据已备；自发信可见性测试待红线 3 用户确认后补齐，ADR-0002 草稿已就绪）。
- internalDate 契约：Phase 3 的真实 IMAP driver 必须产出 `.toISOString()` 形状的字符串（readyAt fence 的字典序比较依赖两侧格式一致）——Task 8 质量审查备忘，届时在 `src/transports/types.ts` 补一行契约说明。
- 意图生命周期（dispatch_intents.status 的状态机）与 QUEUED_WINDOW 唤醒机制按计划留待 Phase 3 定义。
