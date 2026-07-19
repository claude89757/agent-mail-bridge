# Phase 5 批次十二：daemon shell + CLI 接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ticks 接成长驻 daemon：config 扩展、生产装配根、启动序 +
轮询循环 + 优雅停机、`amb start` 真实现与 `status/pause/resume` 脱占位。
兑现批次十一移交清单 1–4 与三条审查 Minor。**零真实运行**（全假件测试；
真跑 = E2E，收尾时按红线 5 报预估请批）。

**Architecture:** `src/daemon/assembly.ts`（组合根，builder 全注入可测）+
`src/daemon/shell.ts`（启动序/循环/信号，timer 与 signal 经注入 seam）；
pause 走 DB meta 旗标（循环每轮读，CLI 写——无 IPC）；config 加法扩展
（version 仍 1，新字段全可选带默认）。

**Tech Stack:** TypeScript strict + ESM、vitest。零新依赖。

**范围裁定（明确排除）：** IDLE watch（follow-up 批次，poll 已满足 P95
<60s：默认 30s 轮询）；识别网关（ADR-0003）；澄清正式流（真机走查）；
ACK 异步语义（v0.1 同步派发不接，组装器已备）；QUEUED_WINDOW 复活
（默认无时间窗不可达）；keychain/logout（开放问题 1）；真实 E2E 运行
（红线 5 请批后另行）。

---

## 锁定决策

### D-P5B12-1 config 加法扩展（version 仍 1，全可选默认）

```ts
// BridgeConfig 新增（validateConfig 同步扩展，缺省值在注释钉死）：
readonly projects: { readonly roots: readonly string[];
                     readonly aliases?: Readonly<Record<string, string>> };
                     // 缺省 { roots: [] }（空索引：一切命令走 no-match stopgap）
readonly worktreesRoot: string;   // 缺省 resolveDefaultWorktreesRoot()
                                  // （paths.ts 新增，沿 resolveDefaultDbPath
                                  //   同族：dbPath 同目录下 worktrees/）
readonly baseRef: string;         // 缺省 'HEAD'（派单时目标仓库的当前头）
readonly pollIntervalSeconds: number;  // 缺省 30；validate: 5..3600 整数
```

- 校验风格沿 validateConfig 现有逐字段先例（越界/类型错 = 拒绝并报字段
  路径）；roots 元素须非空字符串（realpath/存在性校验归 buildProjectIndex
  运行时，config 层只做形状——doc 注明分工）。

### D-P5B12-2 pause 旗标 + SENDING 清扫

- `MetaStore` 增 `getPaused(): boolean` / `setPaused(v: boolean, now)`（meta
  KV 现表新键，无 migration——核对 meta 表布局后按现存 KV 机制实现；若
  meta 是固定列表而非 KV，则 migration 006 加列，实现者按实际选择并汇报）；
- `sweepStrandedSending(deps {outboxStore, clock}): {swept: string[]}`（新
  tick，ticks.ts 并入）：`findByStatus('SENDING')` 逐行
  `transition('UNCERTAIN')`——register 后崩溃残留归入对账轨道（批次十一
  移交 #1；echo 到达即 SENT，未到达则永久 UNCERTAIN 待人工——doc 诚实）；
- 三条审查 Minor 兑现：①alreadyTold 双检直达测试（绕过 orphan 预检直调
  dispatch 胶水两次，断言第二次零发信）；②ingest-pipeline 集成测试改用
  真 `buildRegisterOutbox`（删 `?? receipt.messageId` 分叉）。

### D-P5B12-3 shell（src/daemon/shell.ts）

```ts
export interface ShellDeps {
  ticks: { recover; sweepStranded; mailTick; orphanTick; sweepExpired };  // 函数注入
  metaStore: MetaStore;
  sleep(ms: number): Promise<void>;         // 注入（生产 setTimeout）
  onShutdownSignal(fn: () => void): () => void;  // 注入（生产 SIGINT/SIGTERM）
  log(line: string): void;                  // 注入（生产 console.error——CLI 目录
                                            //   no-console 豁免面；文本须已 scrub）
  pollIntervalMs: number;
}
export async function runDaemonShell(deps: ShellDeps): Promise<{ reason: 'signal' | 'fatal'; error?: unknown }>;
```

- **启动序（normative，批次十一移交 #4）**：recover → sweepStranded →
  循环 [paused? 跳过 : (mailTick → orphanTick → sweepExpired)] → sleep →
  重复；
- 信号到达：置停止位，当前 tick 跑完后退出（优雅：不打断进行中的派发；
  第二次信号不加速——v0.1 简单化 doc）；返回 {reason:'signal'}；
- **tick 错误政策**：单轮 tick 抛错 ⇒ log（scrub 后）+ 连续失败计数；
  连续 ≥3 轮全败 ⇒ 返回 {reason:'fatal', error}（fail closed 交给进程
  退出非零，外层重启策略是操作者的——doc）；成功一轮清零计数；
- paused 每轮读 DB（CLI 写即下一轮生效，无 IPC——doc 注明延迟上限 =
  pollInterval）。

### D-P5B12-4 assembly（src/daemon/assembly.ts，组合根）

```ts
export interface AssemblyBuilders {  // 全部可注入，测试替身
  openDb; buildTransport; buildDriver; buildIndex; homedir(): string;
  readCredentials(envFilePath: string): { user: string; pass: string };
  clock(): string;
}
export async function assembleDaemon(config: BridgeConfig, b: AssemblyBuilders):
  Promise<{ shellDeps: ShellDeps 除注入件; close(): Promise<void> }>;
```

- readCredentials：读 credentialsEnvFile（AMB_TEST_IMAP_USER/PASS 或
  AMB_IMAP_USER/PASS 两族键名——**核对 tests/live 的 loadLiveCreds 现行
  键名并沿用**；缺键抛错 fail closed；值绝不入日志——红线 1/2）；
- close 逆序释放（driver.close → transport.close → db.close）；
- 装配测试：注入假 builder，断言接线拓扑（config 字段流向、close 逆序、
  creds 只进 transport builder 不外泄）；不开真连接。

### D-P5B12-5 CLI（dispatch.ts 路由 + 新 src/cli/start.ts 等）

- `amb start`：loadConfig → assembleDaemon（生产 builders）→
  runDaemonShell；退出码 signal=0 / fatal=1；`--dry-run` 透传 config
  覆写（intent 全 SKIPPED_DRY_RUN 的全链彩排——零 codex 零额度）；
- `amb status`：**诚实定位 doc**——不探测进程存活（无 IPC），报 DB 视角：
  readyAt、paused、各表计数（commands by status / intents by status /
  UNCERTAIN outbox / PENDING clarifications）、水位；
- `amb pause` / `amb resume`：setPaused(true/false) + 打印生效延迟说明；
- PLACEHOLDER_COMMANDS 集合缩至 `['logout']`；帮助文本同步；
- CLI 测试沿 cli-doctor/setup 先例（io 注入）。

### D-P5B12-6 测试清单

shell：启动序次序 pin（调用日志）；paused 跳过三 tick 仍 sleep；信号
优雅停（tick 中途信号 ⇒ 当前轮完成后退出）；连续 3 败 fatal / 2 败后
成功清零；tick 错误 log 过 scrub。assembly：拓扑/close 逆序/creds 流向。
CLI：start 接线（假 assembly）；status 各计数与 paused 显示；pause/resume
写读往返；dry-run 覆写。sweepStrandedSending：SENDING→UNCERTAIN、SENT
不动。config：新字段默认/越界拒绝矩阵。Minor 兑现两条。

---

## 任务列表

### Task 1: config 扩展 + pause 旗标 + SENDING 清扫 + Minor 兑现

**Files:** Modify `src/cli/config.ts`、`src/cli/paths.ts`、
`src/store/metaStore.ts`、`src/daemon/ticks.ts`、
`tests/integration/ingest-pipeline.test.ts`（真 registerer）; Test 并入既有
+ alreadyTold 直达例。

- [x] RED → GREEN → commit。

### Task 2: shell + assembly

**Files:** Create `src/daemon/shell.ts`、`src/daemon/assembly.ts`; Test
`tests/unit/daemon-shell.test.ts`、`tests/unit/daemon-assembly.test.ts`。

- [x] RED → GREEN → commit。

### Task 3: CLI 接线

**Files:** Create `src/cli/start.ts`、`src/cli/statusCmd.ts`（或并入现有
组织风格）; Modify `src/cli/dispatch.ts`、`src/cli/main.ts`; Test 沿 CLI
测试先例。

- [x] RED → GREEN → commit。

### Task 4: 批次收尾（编排者）

- [x] 四件套全绿；threat-model/architecture 刷新；完成记录 + 移交；
  **E2E 请批文案**（红线 5：全链路真跑预估，模板沿批次六）落入最终报告；
- [x] commit + push。

---

## Self-review notes

- spec 覆盖：D2 可靠性模型的循环半边（轮询 30s 满足 P95<60s；IDLE 为
  follow-up 优化）；`setup/doctor/status/pause/resume` 命令面（D 表）
  全部脱占位（logout 留守 keychain 开放问题）；崩溃恢复启动序落 shell。
- 一致性：ticks/replySender/assembly 形状与批次十一现行导出核对；config
  校验先例；CLI io 注入先例。
- 红线：零真实连接零发信零额度（全假件）；creds 不入日志断言；status
  不打印地址（selfAddress 不回显——doc 注明红线 2 的显示面约束）。
- 无占位符：每测试点具体。

---

## 完成记录（2026-07-19，批次十二收尾）

### 提交清单

| commit | 内容 |
| --- | --- |
| `8571c81` | 本 plan 落盘 |
| `e93b7ee` | T1：config 扩展（projects/worktreesRoot/baseRef/pollIntervalSeconds 5..3600 默认 30）+ pause 旗标（meta 纯 KV，无 migration）+ `sweepStrandedSending`（SENDING→UNCERTAIN，SENT 不动）+ Minor 兑现（alreadyTold 直达双检测试、ingest 集成改真 `buildRegisterOutbox` 删分叉） |
| `a8f08f5` | T2：`src/daemon/shell.ts`（启动序 recover→sweepStranded→循环、paused 跳过、信号优雅停、连续 3 败 fatal/成功清零、log 过 scrub）+ `src/daemon/assembly.ts`（组合根全注入、readCredentialsFile fail-closed 只报键名、close 逆序 driver→transport→db） |
| `580fcc8` | T3：`amb start`（生产 builders + `--dry-run` 覆写、signal=0/fatal=1）、`amb status` 诚实 DB 视角（readyAt/paused/各表计数/水位，不回显地址）、`pause`/`resume`、PLACEHOLDER_COMMANDS 缩至 `['logout']` |
| `afe90a2` | 修复轮：凭据 stdio 五 sink 守卫测试（Important-1）+ start.ts 自产日志过 scrub（Minor-1）+ getPausedChangedAt 显示（Minor-2）+ `IntentStore.countByStatus` 零填充（Minor-5） |
| 本提交 | T4 收尾：threat-model C3 收口（stranded SENDING 启动清扫落地）+ C10 补 stdio 守卫证据、architecture 状态行、本记录 |

测试 726 → **797**（+71），四件套全绿，全程零真实连接、零发信、零 codex 额度。

### 审查故事（组合审查，钉在 8571c81..580fcc8 + 修复轮 580fcc8..afe90a2）

- 首轮 **1 Important + 5 Minor**。Important-1（红线 2 机器可验缺口）：审查者在
  exp 副本注入两根泄漏探针——`console.error(pass)` 于 src/cli/**（no-console
  豁免区，lint 拦不住）与 `process.stderr.write(pass)`（任何目录 lint 都不拦）——
  全套测试**零红存活**。修复 `afe90a2` 落五 sink spy 守卫（console.log/error/warn
  + stdout/stderr.write），走真 `readCredentials` + 生产 `buildTransport`
  （imapflow 文件级 hoisted mock，零连接；顺带钉死 `logger===false`、无
  `debug`、`secure:true`、creds 只入 `auth`）。
- 复核 **APPROVED**：双探针重放各**恰 1 红**且正是新守卫测试（1 failed |
  791 passed）；改动面 7 文件与宣称吻合；主仓 792 passed + 5 skipped。
- 复核记录的轻残余（不阻塞）：探针在 `assembleDaemon` 体内原位（readCredentials
  返回后 raw `stderr.write`）仍存活——该位置 console.* 已被 no-console 拦，
  残余仅剩 raw stream 一条非常规通道；修法一行（daemon-assembly.test.ts 任一
  用例套同款五 sink spy 断言 SENTINEL 缺席），归下批。

### 兑现的批次十一移交（七项中四项）

#1 SENDING 清扫 ✓（T1）；#2 alreadyTold 直达测试 ✓（T1）；#3 集成测试真
registerer ✓（T1）；#4 启动接线序 ✓（shell normative 序 + 测试 pin）。
剩余：#5 ACK 异步语义（v0.1 同步派发不接，组装器已备）、#6 QUEUED_WINDOW
复活（默认无时间窗不可达）、#7 真实 E2E（红线 5，收尾报告已附请批文案）。

### 移交清单（后续批次）

1. **assembleDaemon 五 sink spy 一行补测**（复核残余，见上）；
2. **Minor-3 可中断 sleep**：生产 sleep 纯 setTimeout，SIGINT 在 sleep 中
   到达最长等一个 poll 间隔（可配至 3600s）才退；模块 doc 已诚实声明 +
   kill -9 兜底，v0.1 可受；
3. **Minor-4 用法错误退出码统一**：`runStart` 非法参数退 2、`runSetup` 退 1
   （测试 pin 死），同类错误两约定，建议统一为一（改 setup 侧需同步改测试）;
4. **IDLE watch**（范围裁定明确排除项）：poll 30s 已满足 P95<60s，IDLE 是
   延迟优化非正确性需求。

### 经验沉淀

- **lint 围栏不是泄漏证明**：no-console 有豁免区（src/cli/**），raw
  `process.*.write` 任何区都不拦——红线 2 这类"绝不"性质的约束必须有
  机器可验测试兜底，审查注入探针是检验"兜底是否真兜"的有效手段；
- meta 表本就是纯 KV，pause 旗标零 migration 落地——动 schema 前先核对
  现表机制（沿批次十一"outbox.message_id 本就 UNIQUE"同款教训）。
