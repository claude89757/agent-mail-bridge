# Phase 4 批次六：CodexDriver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 D-P3P-3 锁定的 `AgentDriver` seam 上落地真实 `codex exec --json`
驱动器（ADR-0004 的全部实测契约），**零模型额度**：单测全走脚本化子进程假件；
真跑 E2E 按红线 5 另行预估请批。

**Architecture:** 子进程注入面（`SpawnCodex` 最小接口 + `buildDefaultSpawnCodex`
生产接线，argv 数组、无 shell、stdin 关闭）；JSONL 行解析按 ADR-0004 词汇表映射
到 `DriverEvent` 四类联合；终态合成走 seam 模块 doc 的崩溃契约原文。

**Tech Stack:** TypeScript strict + ESM、node:child_process（仅经注入面）、vitest。

**范围裁定（明确排除）：** 真实 codex 进程调用（E2E 等红线 5 预估+用户确认）；
与 intentStore/router/worktreeManager 的接线（dispatch 用例批次）；重试/超时/并发
策略（daemon 批次——driver 只暴露 close 终止手段）；模型/额度配置透传（daemon
批次接 config 时定）。

---

## 锁定决策

### D-P4B6-1 注入形状（src/drivers/codexDriver.ts 新建）

```ts
/** 最小子进程面——生产为 child_process.spawn 包装，测试为脚本化假件。 */
export interface SpawnedCodex {
  /** JSONL stdout 行流（假件直接喂字符串行；生产按换行切分）。 */
  stdout: AsyncIterable<string>;
  /** stderr 聚合文本（终态合成 failed 时作 errorText 素材，脱敏后）。 */
  stderr: Promise<string>;
  /** 进程退出：{ code }（信号终止时 code 为 null）。 */
  exited: Promise<{ code: number | null }>;
  kill(): void;
}
export type SpawnCodex = (argv: readonly string[], opts: { cwd: string }) => SpawnedCodex;
export function buildDefaultSpawnCodex(): SpawnCodex;
// spawn('codex', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
// stdin 'ignore'（ADR-0004：非 TTY 时 codex 会宣布读 stdin）；无 shell。
export function createCodexDriver(deps: { spawnCodex: SpawnCodex }): AgentDriver;
```

### D-P4B6-2 argv 构造（call-shape 逐元素全等断言，worktreeManager 先例）

- startTask：`['exec', '--json', '--sandbox', 'workspace-write', '-C', input.cwd, input.prompt]`
  （C6 天花板；cwd 为 bridge-owned worktree 真 git 仓库，无需 --skip-git-repo-check；
  prompt 是单一 argv 元素，不过 shell）；
- resumeTask：`['exec', 'resume', sessionId, '--json', input.prompt]`
  （ADR-0004 选项面不对称：resume 无 --sandbox，沙箱随会话创建时设定）；
  sessionId 先过 `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`
  小写 UUID 校验再入 argv（argv 注入防线，COMMIT_SHA_PATTERN 先例）——不合形状
  直接抛，绝不 spawn；
- **禁 `--dangerously-*`、`danger-full-access`、`--ephemeral`**（前两者 AGENTS.md
  红线；--ephemeral 不落盘会话即不可 resume，ADR-0004 明令 daemon 派发禁用）——
  测试对 argv 做逐元素全等断言，任何多余旗标即红；
- dryRun=true ⇒ startTask/resumeTask **抛错不 spawn**（fail closed：dry-run 语义由
  application 层 intent 的 SKIPPED_DRY_RUN 承担，请求到达 driver 即是上游 bug，
  doc comment 写明）。

### D-P4B6-3 JSONL 解析与事件映射（ADR-0004 词汇表）

- `thread.started {thread_id}` ⇒ 捕获 sessionId（handle.sessionId；startTask 在
  收到该事件或进程早退时才 resolve）；
- `item.completed` 且 `item.type === 'agent_message'` ⇒ 缓存文本，同时产出
  `{ kind: 'agent-message', text }`；
- `item.completed` 且 `item.type === 'error'` ⇒ `{ kind: 'tool-activity',
  summary: 'codex diagnostic: ' + message }`（ADR-0004：配置噪声非终态，
  绝不据此判 failed）；其他 item.type（如 command_execution 等未来类型）⇒
  `tool-activity`，summary 取 type 名 + 可得的简短字段，未知结构容忍；
- `turn.completed` ⇒ 终态 `{ kind: 'completed', resultText: 最后一条
  agent_message 文本（无则空串） }`；
- 未知顶层 type ⇒ 跳过（前向兼容，ADR-0004 Consequences）；坏 JSON 行 ⇒
  跳过计数（fail closed 不崩）；
- **终态合成（seam 崩溃契约原文）**：进程退出且未见 `turn.completed` ⇒ 合成
  `{ kind: 'failed', errorText }`，errorText 取 exit code + stderr 摘要，
  **摘要须过滤真实本地路径**（红线 2：把 `input.cwd` 与 `homedir()` 前缀替换为
  占位符后再入 errorText——bogus-id 实测 stderr 含 "no rollout found" 类信息，
  但通用兜底不能假设 stderr 永远干净）；
- streamEvents 语义：事件全量缓冲，**每次调用从头重放**（读 fakeAgentDriver 的
  replay pin 测试并保持同语义）；close() 后已有 handle 的 streamEvents 仍可用
  （close-does-not-invalidate pin 同步遵守），close() 对仍在跑的子进程 kill()。

### D-P4B6-4 capabilities 与杂项

- `capabilities()` ⇒ `{ supportsResume: true, agentName: 'codex' }`；
- startTask 在 thread.started 前进程早退 ⇒ startTask 仍 resolve
  （`sessionId: null`，seam doc 允许），streamEvents 产出合成 failed——
  错误全部经事件流交付，seam 消费者只依赖终态事件；
- 分层红线：drivers/ 不 import application//store//transports/；
  node:child_process 仅出现在 buildDefaultSpawnCodex。

### D-P4B6-5 测试（tests/unit/codex-driver.test.ts 新建，全走假件）

argv 全等（start/resume/多余旗标不存在）；非法 sessionId 拒绝且零 spawn；
dryRun 拒绝且零 spawn；thread_id 捕获;
agent_message → agent-message 事件 + completed.resultText 取末条；error-item →
tool-activity 且不判 failed；未知 item.type / 未知顶层 type / 坏 JSON 行容忍；
无 turn.completed 早退（code 0 与非 0 各一）⇒ 合成 failed 恰一条且为末事件；
errorText 的 cwd/homedir 占位替换；thread.started 前早退 ⇒ sessionId null +
合成 failed；streamEvents 重放语义；close() kill 在跑进程且不失效既有 handle；
capabilities 形状。夹具 JSONL 行手写字符串，thread_id 用低熵占位
（`00000000-0000-4000-8000-000000000001` 类），零真实路径。

---

## 任务列表

### Task 1: CodexDriver 实现 + 单测

**Files:** Create `src/drivers/codexDriver.ts`; Test `tests/unit/codex-driver.test.ts`。

- [x] 失败测试先行（D-P4B6-5 全清单）。
- [x] RED → 实现 → GREEN → commit。

### Task 2: 批次收尾

- [x] 四件套全绿；threat-model C6 补 *Evidence (partial)*（argv 天花板 +
  禁旗标测试钉住）；architecture 表 CodexDriver 翻 done（E2E 标注等红线 5）；
  本计划完成记录（移交说明：dispatch 接线归下批、E2E 预估请批模板、
  超时/重试归 daemon）；
- [x] commit + push。

---

## Self-review notes

- spec 覆盖：§3.1 扩展轴 2（driver 不触 core）+ C6 执行天花板（workspace-write
  argv + 禁旗标测试）+ D6 seam 契约逐条映射；ADR-0004 全部实测契约
  （词汇表/不对称/合成 failed/stdin/--ephemeral 禁用）逐条落地。
- 类型一致性：AgentDriver/DriverEvent/AgentTaskInput/AgentTaskHandle 用既有
  seam 定义零改动；SpawnCodex 一次定义。
- 红线：零额度（假件）；红线 2 的 errorText 路径过滤；C6 禁旗标；
  argv 注入防线有先例。
- 无占位符：每测试点具体。

---

## 完成记录（2026-07-19）

两任务闭环。测试基线 28 文件 / 522 → **29 文件 / 553**（+31，549 通过 +
4 live 默认 skip）；四件套全绿；全程零模型额度。

### Commit 轨迹

| Commit | 内容 |
| --- | --- |
| `2b483cc` | 本计划落盘 |
| `8dcadb9` | T1 CodexDriver（574 行 + 27 测试：argv 全等/禁旗标缺席/UUID 白名单零 spawn/dryRun 同步拒/单终态合成/scrub 链/并发重放追赶/close 语义/capabilities） |
| `40d5713` | 审查后续 4 pin + 假件旧注释刷新（latest-wins、scrub 双次序、close 不冻结——每个 pin 经变异对照证明"能红"；驱动源码与受审版本逐字节一致零改动） |
| 本提交 | T2 收尾：threat-model C6 证据 + C9 渲染义务移交、architecture 表、完成记录 |

### 审查结论

**✅ 零 Critical/Important（对本批而言）**。审查员四组穿透实验全部通过：
① 300 轮随机化并发 + 变异对照（把 check→park 拆出宏任务窗口的变异体如预测
悬挂，真实实现同编排完成——无锁 check-park 论证被证"有牙齿"）；② 双索引
latest-wins 行为实证；③ close 解卡 pending startTask、幂等、不冻结；
④ scrub 探针（嵌套路径、跨截断线、误序对照）。单追加点 `pushEvent` 把
单终态契约做成结构性不变量获亮点评价。

### 移交说明

1. **【不可选】渲染层 scrub 义务（审查 Important 前向项）**：driver 只对
   合成 failed 的 errorText 做 cwd/home 占位过滤；`agent-message` 文本与
   `tool-activity` 摘要**按设计原样携带真实 worktree 路径**流经事件流。
   回信组装批次把任何事件文本写进邮件正文之前，必须做同款 scrub 并配测试
   ——否则红线 2 在第一封状态回信就静默失守。已同步写入 threat-model C9。
2. **dispatch 接线归下批**：driver ↔ intentStore/worktreeManager/router 的
   组装（含 thread_id 持久化到 thread↔session 映射）。
3. **超时/重试/并发上限归 daemon 批次**：driver 只暴露 close/kill；事件
   缓冲不驱逐（长驻进程的缓冲上限也是 daemon 的设计点）。
4. **E2E 请批模板（红线 5，到点报给用户）**：最小真跑 = 1–2 次
   `codex exec` 微任务（在 bridge-owned worktree 里做一句话改动）+ 1 次
   resume 续跑。按 ADR-0004 探针实测（琐碎任务 ~7–36k input 多为缓存命中、
   输出 <100 token），预估总消耗 **< 500k input（大头缓存）/ < 5k output
   token**；请批时附当次任务文本与次数上限。
