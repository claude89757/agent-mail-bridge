# Phase 5 批次十三：产品化收尾（日志轮转 + 服务安装产物 + 审查残余）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 兑现批次十二移交四项中的三项（assembleDaemon 五 sink spy、
Minor-3 可中断 sleep、Minor-4 退出码统一）+ spec Phase 5 剩余两块：
脱敏日志文件轮转、launchd/systemd 安装产物（`amb install`/`uninstall`）。
**零真实运行**：绝不执行 `launchctl`/`systemctl`，测试绝不触碰真实
`~/Library/LaunchAgents` 或 `~/.config/systemd`（homedir 全注入）。

**Architecture:** sleep seam 升级为 AbortSignal 形态（shell 内部每轮新建
controller，信号即 abort——不改循环结构）；文件日志是 console.error 之外的
tee sink（收到的文本已 scrub，轮转 shift 式）；服务安装 = 纯字符串生成器 +
只写文件 + 打印激活命令（激活动作永远归操作者）。

**Tech Stack:** TypeScript strict + ESM、vitest。零新依赖。

**范围裁定（明确排除）：** IDLE watch（poll 已满足 P95<60s）；识别网关
（ADR-0003 待用户）；澄清正式流（真机走查）；logout/keychain（开放问题 1，
留占位）；README/CHANGELOG/版本号（发布预备批）；真实 E2E（红线 5 已请批
待复）；批次十一移交 #5 ACK 异步（v0.1 同步派发不接）与 #6 QUEUED_WINDOW
复活（默认无时间窗不可达）——两者维持现状，不做代码变更。

---

## 锁定决策

### D-P5B13-1 可中断 sleep（Minor-3）

```ts
// ShellDeps.sleep 形态升级（shell.ts + start.ts + 全部假件同步）：
sleep(ms: number, abort: AbortSignal): Promise<void>;
// 契约：永不 reject；abort 触发时提前 resolve（已 abort 传入 ⇒ 立即 resolve）。
```

- shell 内部：`onShutdownSignal` 回调里 `stopping = true; controller.abort()`；
  每次进 sleep 前新建 `AbortController` 存入 `let controller`，睡醒后循环顶
  的 `stopping` 检查照旧退出——**循环结构与两处 stopping 检查不动**，只加
  abort 管线；
- 生产绑定（start.ts）：`setTimeout` + `abort` 监听里 `clearTimeout` 并
  resolve（timer 必须真清掉——不留悬挂 handle，也不用 `unref()` 这种会让
  事件循环在正常 sleep 中提前退出的招）；监听用 `{ once: true }` 并在正常
  超时路径 `removeEventListener`，不泄漏；
- 模块 doc 同步：删掉「sleep 期信号最长等一个 poll 间隔」的诚实声明，换成
  「sleep 期信号立即唤醒，当前轮完成后退出」；
- 测试：①信号在 sleep 期到达 ⇒ 假 sleep（永不自行 resolve，只随 abort
  resolve）下 shell 及时返回 `{reason:'signal'}`（无 abort 管线该测试会
  挂死——用 `vi.waitFor`/promise race 断言及时性）；②已 stopping 再进
  sleep 前的 TOCTOU：signal 恰在 tick 后 sleep 前 ⇒ 不再睡直接退（现测试
  已覆盖则保留）；③start.ts 生产 sleep：abort 后 timer 被清（`vi.useFakeTimers`
  + `getTimerCount()` 归零断言）、正常超时路径 resolve。

### D-P5B13-2 用法错误退出码统一为 2（Minor-4）

- 约定：**参数/用法错误 = 2**（沿 `runStart` 现行），**运行期失败 = 1**；
- `src/cli/setup.ts` 仅改 parse 失败处（现 178 行 `exitCode: 1` → `2`）；
  其余 runtime 失败位（权限位不符、readCredentials 缺键等）**保持 1 不动**；
- 同步更新 pin 死该值的测试（tests/unit/cli-setup.test.ts）；`dispatch.ts`
  的 unknown-command/help 路径退出码现状核对：若用法类 ≠2 则一并统一并改测试，
  若已是 2 则只在本 plan 完成记录里记一句核对结论。

### D-P5B13-3 assembleDaemon 五 sink spy（批次十二复核残余）

- 抽 `tests/helpers/stdioSpy.ts`：`withStdioSpy(fn) → { result, captured }`，
  五 sink（console.log/error/warn + process.stdout.write + process.stderr.write）
  spy + 恢复，形态照抄 tests/unit/cli-start.test.ts 现有守卫（该文件同步
  重构为用 helper——行为不变，断言不减）；
- tests/unit/daemon-assembly.test.ts：任一走真 `readCredentials` 的装配
  用例套 `withStdioSpy`，断言 SENTINEL user/pass 值（低熵占位，如
  `sentinel-user@example.com` / `Aa-Aa-Tok-9001`）在五 sink 捕获中**全部
  缺席**——复核报告指明的 raw-write 通道（assembleDaemon 体内、
  readCredentials 返回后）从此有测试兜底。

### D-P5B13-4 脱敏日志文件轮转

- `src/cli/paths.ts` 增 `resolveDefaultLogDir(env, homedir)`：
  `$XDG_STATE_HOME/agent-mail-bridge/logs`，缺省
  `<homedir>/.local/state/agent-mail-bridge/logs`（XDG：日志归 STATE；
  db/worktrees 在 DATA 不动）；
- 新 `src/cli/logSink.ts`：

```ts
export const LOG_FILE = 'amb.log';
export const LOG_MAX_BYTES = 1 * 1024 * 1024;  // 轮转阈值（v0.1 常量，YAGNI）
export const LOG_KEEP = 3;                     // amb.log.1..3，再旧即删
export interface FileLogSink { write(line: string): void; close(): void; }
export interface LogFsOps { /* mkdir/append/stat/rename/unlink 同步族，全可注入 */ }
export function buildFileLogSink(dir: string, fs?: LogFsOps): FileLogSink;
```

  - 追加前检查 `size + line > LOG_MAX_BYTES` ⇒ shift：`.2→.3`（旧 `.3` 删）、
    `.1→.2`、`amb.log→.1`，新开文件；同步 fs（每轮一行的量级，简单且崩溃
    安全）；
  - **fail-open**：目录建不起 / 写失败 ⇒ 降级 console-only，首次失败经
    console.error 报一行（此后静默，不刷屏）——日志是辅助面，daemon 绝不
    因日志死（doc 钉死：与红线无关，因为**到达 sink 的文本已全部 scrub**，
    文件面与 console 面同边界）；
  - start.ts：log 绑定改 tee（console.error + sink.write），sink 用
    resolveDefaultLogDir 建，shell 退出后 `close()`；
- 测试（真 fs 走 tmpdir，沿 cli-setup 先例；失败注入用假 LogFsOps）：追加
  换行落盘；跨阈值触发 shift 且 `.3` 被删（keep 边界）；写失败降级仅报一次；
  close 幂等；start.ts 接线测试断言 tee 两路都收到（假 sink 注入）。

### D-P5B13-5 launchd/systemd 安装产物（`amb install`/`amb uninstall`）

- 新 `src/cli/service.ts`，纯字符串生成器 + 命令实现：

```ts
export const SERVICE_LABEL = 'com.agent-mail-bridge.daemon';
export function renderLaunchdPlist(a: { nodePath: string; entryPath: string;
  logDir: string }): string;   // ProgramArguments [node, entry, 'start'],
                               // RunAtLoad+KeepAlive true，StandardOut/ErrorPath
                               // 指向 logDir/launchd.{out,err}.log
export function renderSystemdUnit(a: { nodePath: string; entryPath: string }):
  string;                      // ExecStart，Restart=on-failure，
                               // WantedBy=default.target
```

- `amb install`（io 注入 `platform: 'darwin' | 'linux'`、`nodePath`、
  `entryPath`、homedir、fs）：darwin 写
  `~/Library/LaunchAgents/<LABEL>.plist`，linux 写
  `~/.config/systemd/user/agent-mail-bridge.service`；文件已存在 ⇒ 拒绝
  （exit 1）除非 `--force`；写完**打印**激活命令（darwin:
  `launchctl load -w ~/Library/LaunchAgents/<LABEL>.plist`；linux:
  `systemctl --user daemon-reload && systemctl --user enable --now
  agent-mail-bridge`）——**绝不执行**；其余平台 ⇒ exit 1 说明不支持；
- `amb uninstall`：①打印去激活命令（unload / disable --now，不执行）；
  ②删除服务文件（本命令唯一删除动作；不存在则如实说）；③打印剩余产物
  清单与手动清理顺序（config、db、worktrees、logs、credentials 文件）——
  **全部路径用 `~/` 波浪线形态打印**，绝不展开真实 homedir（红线 2 的
  显示面纪律；测试断言输出 `not.toContain(fakeHomedir)`）；
- `main.ts`/`dispatch.ts` 接线：生产 `nodePath = process.execPath`、
  `entryPath = process.argv[1]` 于 main.ts 单点读取注入；
- 测试：plist/unit 内容断言（ProgramArguments 顺序、KeepAlive、ExecStart、
  Restart）；install 平台分派/拒绝已存在/--force 覆写/激活命令打印且
  **无 launchctl 子进程调用**（代码中这些字符串只存在于打印文本——grep
  级断言可写为 service.ts 不 import child_process）；uninstall 删文件 +
  顺序打印 + 波浪线纪律；homedir 全假注入，真实 LaunchAgents 目录零接触。

### D-P5B13-6 测试清单汇总

T1：可中断 sleep 三测 + 退出码矩阵改 pin + stdioSpy helper 重构不减断言 +
assembleDaemon spy 用例。T2：logSink 轮转/降级/幂等 + paths 新函数 XDG
矩阵 + start tee 接线。T3：渲染器内容 pin、install/uninstall 全分支、
波浪线纪律、无 child_process 断言。

---

## 任务列表

### Task 1: 审查残余三件（spy helper + 可中断 sleep + 退出码）

**Files:** Create `tests/helpers/stdioSpy.ts`; Modify `src/daemon/shell.ts`、
`src/cli/start.ts`、`src/cli/setup.ts`、`tests/unit/daemon-shell.test.ts`、
`tests/unit/cli-start.test.ts`、`tests/unit/cli-setup.test.ts`、
`tests/unit/daemon-assembly.test.ts`。

- [x] RED → GREEN → commit。

### Task 2: 脱敏日志文件轮转

**Files:** Create `src/cli/logSink.ts`、`tests/unit/cli-log-sink.test.ts`;
Modify `src/cli/paths.ts`、`src/cli/start.ts`、`tests/unit/cli-paths.test.ts`、
`tests/unit/cli-start.test.ts`。

- [x] RED → GREEN → commit。

### Task 3: launchd/systemd 安装产物

**Files:** Create `src/cli/service.ts`、`tests/unit/cli-service.test.ts`;
Modify `src/cli/dispatch.ts`、`src/cli/main.ts` + dispatch 测试。

- [x] RED → GREEN → commit。

### Task 4: 批次收尾（编排者）

- [x] 四件套全绿；threat-model（C10 文件日志面 + assembleDaemon 残余闭合）
  /architecture 刷新；完成记录 + 移交；
- [x] commit + push。

---

## Self-review notes

- spec 覆盖：Phase 5 剩余三项中两项（launchd/systemd 安装、脱敏日志轮转）
  落地；卸载清理顺序落 `amb uninstall`；「README 从零到首封结果邮件
  ≤10 分钟」出口指标待发布预备批（README）+ E2E 后验证。
- 红线：零 launchctl/systemctl 执行；测试 homedir 全注入零真实系统目录
  接触；日志文件面与 console 同一 scrub 边界；uninstall/install 打印面
  波浪线纪律（红线 2 显示面）。
- 一致性：sleep seam 形态改动同步 shell/start/全部假件；stdioSpy helper
  重构不减少 cli-start 现有断言；夹具 SENTINEL 低熵。
- 无占位符：每测试点具体。

---

## 完成记录（2026-07-19，批次十三收尾）

### 提交清单

| commit | 内容 |
| --- | --- |
| `96a945e` | 本 plan 落盘 |
| `bde43f4` | T1：sleep seam 升级 `(ms, abort: AbortSignal)`（shell 每轮新建 controller、生产绑定 clearTimeout + `{once:true}` 双向不泄漏）+ `tests/helpers/stdioSpy.ts` 抽出（cli-start 守卫重构断言零减）+ assembleDaemon spy 用例 + setup parse 退出码 1→2（runtime 位全留 1） |
| `299739c` | T2：`src/cli/logSink.ts`（1 MiB shift 轮转 `.1..3`、fail-open 永久降级仅报一次）+ `resolveDefaultLogDir`（XDG_STATE_HOME）+ start.ts tee（console + 文件同批已 scrub 文本） |
| `bc84223` | T3：`src/cli/service.ts` 渲染器（plist escapeXml / systemd 引号护路径）+ `amb install`（拒绝已存在/--force/打印激活命令绝不执行/entryPath 空 fail closed/预建日志目录）+ `amb uninstall`（去激活→删服务文件→手动清理清单全波浪线形态） |
| 本提交 | T4 收尾：四条审查 Minor 全兑现（见下）+ threat-model C10 残余闭合与文件日志面 + architecture 行 + 本记录 |

测试 797 → **838**（+41），四件套全绿，全程零真实连接、零发信、零 codex
额度、零 launchctl/systemctl 执行。

### 审查故事（组合审查，钉 96a945e..bc84223）

- **APPROVED，零 Important**。9 条实现者 mutation 宣称全部在副本重放属实
  （含 ⑤ 的行为等价变异形态辨析）；审查者另注入 4 根自选探针：P1
  （buildTransport 后 stdout.write）被捕获、P3（install 输出改真实路径）
  被 4 测捕获、P4（escapeXml 恒等化）被捕获、**P2（close 闭包内
  stderr.write）存活**——spy 窗口不含 `close()` 而凭据被闭包词法俘获。
- **批次十二残余闭合实证**：上批原位探针（assembleDaemon 体内、
  readCredentials 返回后 raw stderr.write）重放**恰 1 红**且正是新 spy
  用例——跨批移交项完成闭环。
- 审查附带发现：批次十二版守卫在 `vi.restoreAllMocks()` **之后**读
  `mock.calls`（restore 含 reset 语义，缺席断言当时实为真空）；本批
  helper 显式先 capture 后 restore，属实质加固而非纯重构。
- 四条 Minor 由编排者按批次十收尾先例在本提交直接兑现：
  1. spy 窗口扩到含 `close()`（P2 修法）——收尾后在副本重放 P2，
     **恰 1 红**（1 failed | 9 passed），闭合实证；
  2. logSink 三边界补测：恰好等于阈值不轮转（`>` 语义 pin）、单行超
     阈值仍落盘且下一写轮转、rotate 内 rename 失败与 append 失败同款
     降级（仅报一次 + 此后零 fs 触碰）；
  3. uninstall unlink 失败分支补测（exit 1 + fs 错误消息 tilde 化，
     `not.toContain(fakeHomedir)`）；
  4. doc 措辞收紧：escapeXml 不覆盖 XML 1.0 无法表示的控制字符、
     systemd 引号假设点名 `"`/`\`、shell.ts controller 注释改为
     「最近一次 sleep 的 controller（完成后 linger 至下轮替换）」。

### 实现者偏离五条（审查全部裁定合理）

report seam 注入（降级告警可 scrub，红线 2 需要）；escapeXml 实现取向
（含 `&`→`&amp;` 测试）；install 预建日志目录（launchd spawn 即打开
Standard*Path）；`ServiceCommandResult.exitCode` 含 2（D-P5B13-2 对齐）；
uninstall 清单附「自定义路径以 config.json 为准」附注。

### 移交清单（后续批次）

1. **launchctl 激活文案语法**：`load -w` 在新版 macOS 属 legacy（仍工作）；
   Phase 6 真机走查时观察，如换 `bootstrap gui/$UID` 属文案级改动；
2. **logSink 永久降级不自动恢复**：doc 已钉死；若未来要重试需新决策；
3. 批次十一移交 #5（ACK 异步）/#6（QUEUED_WINDOW 复活）维持批次十三
   范围裁定：v0.1 不做；
4. IDLE watch 维持 follow-up 定位（poll 已满足 P95<60s）。

### 经验沉淀

- **spy/guard 的作用域窗口本身是测试面**：守卫测试"包住哪段执行"决定
  它兜住哪些通道——闭包俘获的秘密在窗口外调用时照样泄漏（P2）；写
  资源守卫时把"释放路径"（close/dispose）一并纳入窗口；
- **`mockRestore` 后读 `mock.calls` 是真空断言**：capture 必须先于
  restore——上批守卫的缺席断言曾因此短暂真空（幸有 mutation 实证兜底）。
