# Phase 5 提前骨架（CLI / config / doctor / setup 最小版）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 3/4 被外部依赖（红线 3 发信确认、codex CLI 版本）阻塞期间，提前落地 Phase 5 中纯本地、可完整测试的部分：配置层、doctor 检查引擎与本地检查项、CLI 入口骨架、setup 最小版（readyAt 首装写入）。

**范围裁定（orchestrator ruling，对照 spec §5 Phase 5）**：本计划只覆盖不依赖 daemon 与真实邮箱往来的子集。launchd/systemd 安装、status/pause/resume/logout 的真实语义、日志轮转、5 分钟硬指标与"10 分钟出口"验收全部留在 Phase 5 正式阶段（Phase 3/4 之后）。本计划完成 ≠ Phase 5 完成；验收报告仍按 spec 顺序在正式 Phase 5 出口时撰写。

**Architecture:** config 加载/校验为纯函数模块（IO 注入）；doctor = 可扩展检查项注册表（每项检查纯函数返回结构化结果，渲染与检查分离）；CLI 用 Node 内置 `util.parseArgs` 零新依赖；setup 最小版复用 store 层 `openDatabase` + `metaStore.setReadyAtIfUnset`，把 first-install fence 产品化。

**Tech Stack:** TypeScript strict + ESM + nodenext、Node ≥22（`util.parseArgs`、`fs`）、vitest、better-sqlite3（仅经由 src/store）。零新增运行时依赖。

---

## 锁定决策

### D-P5S-1 参数解析

`node:util` 的 `parseArgs`（Node 18.3+ 稳定，Node 22 无 flag）。不引入 commander/yargs：命令面小（6 个子命令）、零依赖符合安装体积与供应链目标。子命令分发手写：`argv[2]` 为子命令名，其余交 parseArgs。

### D-P5S-2 配置文件与路径

- 路径：`$XDG_CONFIG_HOME/agent-mail-bridge/config.json`，`XDG_CONFIG_HOME` 未设时回退 `~/.config`。路径解析函数接受注入的 `env` 与 `homedir`（可测）。
- Schema v1（手写校验器，零依赖；每个错误给出字段路径 + 期望）：

```ts
interface BridgeConfig {
  version: 1;
  selfAddress: string;          // 非空、含 @；进一步校验复用 domain/identity 的约束口径
  credentialsEnvFile: string;   // 指向凭据 env 文件的路径（如 ~/.secrets/amb-test.env）；凭据本身绝不入 config
  dbPath: string;               // SQLite 文件路径；默认 $XDG_DATA_HOME/agent-mail-bridge/bridge.db（XDG_DATA_HOME 未设回退 ~/.local/share）
  mailbox: string;              // 默认 "INBOX"
  timeWindow?: TimeWindowConfig; // 复用 src/domain/timeWindow.ts 的类型
  dryRun: boolean;              // 默认 false
}
```

- 加载器：`loadConfig(path, io)` 返回 `{ ok: true, config } | { ok: false, errors: string[] }`——不 throw，让 doctor 能把配置错误渲染为检查失败（fail closed：任何未知字段报错，不静默忽略）。
- `~` 展开：`credentialsEnvFile`/`dbPath` 支持前导 `~/` 展开为注入的 homedir；其余相对路径拒绝（必须绝对或 `~/` 开头），防 cwd 依赖。

### D-P5S-3 凭据卫生检查（不读内容）

doctor 与 setup 对 `credentialsEnvFile` 只做 `stat`：文件存在、是常规文件、权限恰为 `0600`、父目录权限恰为 `0700`。**永不读取文件内容**（读取只发生在未来 daemon/transport 运行时）。权限过宽 = fail（含修复提示 `chmod 600 …`），不是 warn——与红线 2 的凭据卫生态度一致。

### D-P5S-4 DoctorCheck 接口

```ts
// src/cli/doctor.ts
export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckResult { status: CheckStatus; message: string; hint?: string }
export interface DoctorCheck { id: string; title: string; run(ctx: DoctorContext): CheckResult }
export interface DoctorContext { configPath: string; config: BridgeConfig | null; configErrors: string[]; io: DoctorIo }
// DoctorIo: { statSync-like, nodeVersion, openDatabase 注入 } —— 全部可注入以便测试
export function runDoctor(checks: DoctorCheck[], ctx: DoctorContext): { results: …[]; exitCode: 0 | 1 }
```

v1 检查项（顺序即输出顺序）：`node-version`（≥22）、`config`（存在 + schema 通过）、`credentials-file`（D-P5S-3）、`database`（可打开 + migrations 到最新版本；用 `openDatabase` 后立即 close）、`ready-at`（已设置 = pass 并显示值；未设置 = warn "run setup"——不是 fail，因为 doctor 应在 setup 前也可用）。渲染（✓/!/✗ + hint 缩进）与检查分离：`renderDoctorReport(results): string`。exitCode：任何 fail → 1，否则 0（warn 不影响）。

### D-P5S-5 CLI 骨架与命令面

- `src/cli/main.ts` 为 bin 入口；`package.json` 增加 `"bin": { "agent-mail-bridge": "dist/cli/main.js", "amb": "dist/cli/main.js" }`（D10）。入口首行 shebang `#!/usr/bin/env node`；build 保持 tsc（无 bundler）。
- v1 实现 `doctor`、`setup`、`--version`、`--help`；`status`/`pause`/`resume`/`logout` 注册在 help 中但执行时输出「随 Phase 5 正式阶段提供（需要 daemon）」并 exit 2——命令面提前占位（继承自 handoff 的命令面设计），行为诚实。
- cli/ 目录 eslint 豁免 no-console（Phase 0 已配置，核实即可）；所有用户输出走 stdout，错误走 stderr。
- main.ts 里只做参数解析与装配（真实 io 注入），逻辑全部在可测模块——测试直接调用 handler，不起子进程。

### D-P5S-6 setup 最小版（非交互）

`amb setup --self <addr> --credentials-env-file <path> [--db-path <p>] [--mailbox <m>] [--dry-run] [--force-config]`：

1. 组装配置对象 → schema 校验（失败即列全部错误退出 1）；
2. 凭据文件卫生检查（D-P5S-3；失败退出 1，给 chmod 提示）；
3. 写 config.json（已存在且未 `--force-config` 时拒绝覆盖并提示，退出 1——不静默改动既有配置）；目录 `mkdir -p`，config 文件写后 `chmod 0600`；
4. `openDatabase(dbPath)` 跑 migrations；
5. `metaStore.setReadyAtIfUnset(now.toISOString())`——首装 fence 的产品化入口；重复 setup 不会改动既有 readyAt（store 语义已钉）；输出生效值并明确说明「早于此刻的邮件永不执行」；
6. 输出 next steps（当前指向 doctor；Phase 5 正式阶段接 daemon 安装）。

交互式向导（问答收集参数）与 IMAP 连通性验证留待 Phase 5 正式阶段（后者依赖 Phase 3 的真实 transport）；本版 `now` 由入口传入（`new Date()` 仅出现在 main.ts 装配层，业务函数保持可测）。

### D-P5S-7 测试与文件边界

- 新增 `src/cli/{paths,config,doctor,setup,main}.ts`；除 main.ts（装配）外全部纯函数/注入 io。
- 测试 `tests/unit/cli-{paths,config,doctor,setup}.test.ts`：临时目录 + 注入 env/homedir；权限检查用 `fs.chmodSync` 真实构造 0600/0644 情形；database 检查用真实 `openDatabase`（临时文件）。不测 main.ts 的 argv 细节（薄装配层），但 parseArgs 的子命令分发函数要测（未知命令 → help + exit 2）。
- 只有 src/store/** 可 import better-sqlite3 的边界不变（cli 经由 openDatabase/MetaStore）。

---

## 任务列表

Task 1 → 2/3/4 有依赖（config 类型先行）；Task 3 依赖 2（doctor 引擎）；Task 5 收尾。每任务严格 TDD（失败测试 → RED → 最小实现 → GREEN → `pnpm lint && pnpm typecheck && pnpm test` → commit）。

### Task 1: cli 路径解析 + config schema/loader

**Files:** Create `src/cli/paths.ts`（`resolveConfigPath(env, homedir)`、`resolveDefaultDbPath(env, homedir)`、`expandTilde(p, homedir)`）、`src/cli/config.ts`（`BridgeConfig`、`validateConfig(raw): ok/errors`、`loadConfig(path, io)`）；Test `tests/unit/cli-paths.test.ts`、`tests/unit/cli-config.test.ts`。

- [ ] 失败测试：XDG_CONFIG_HOME 设/未设两分支；`~/` 展开、相对路径拒绝；合法 config 全字段解析（含默认值 mailbox/dryRun/dbPath）；每类字段错误（缺 version、selfAddress 无 @、未知字段、timeWindow 形状错）各给出含字段路径的错误；文件不存在/JSON 语法错 → `ok:false` 不 throw。
- [ ] RED → 实现 → GREEN → commit。

### Task 2: doctor 引擎 + 五个检查项 + 渲染

**Files:** Create `src/cli/doctor.ts`（D-P5S-4 全部接口 + `buildDefaultChecks()` 五项 + `renderDoctorReport`）；Test `tests/unit/cli-doctor.test.ts`。

- [ ] 失败测试：node-version pass/fail 边界（22.0.0 pass、20.x fail）；config 错误 → fail 且 message 含首条 schema 错误；credentials 文件缺失/0644/目录 0755 → fail 带 chmod hint，0600+0700 → pass；database 检查真实打开临时库 → pass、路径不可写 → fail；ready-at 未设 → warn 提示 setup、已设 → pass 显示值；exitCode：全 pass=0、含 warn=0、任一 fail=1；渲染快照式断言（✓/!/✗ 与 hint 缩进）。
- [ ] RED → 实现 → GREEN → commit。

### Task 3: CLI 入口 + 子命令分发 + bin 注册

**Files:** Create `src/cli/main.ts`（shebang、装配、`dispatch(argv): {command, args} | help/unknown`）；Modify `package.json`（bin 字段）；Test `tests/unit/cli-dispatch.test.ts`。

- [ ] 失败测试：`doctor`/`setup` 正确路由；`--version` 输出 package version；`--help` 列出全部命令面（含占位命令）；`status` 等占位命令 → 提示 Phase 5 正式阶段 + exit 2；未知命令 → help + exit 2。
- [ ] RED → 实现 → GREEN → `pnpm build` 后 `node dist/cli/main.js --help` 冒烟验证（证据入 commit message 或报告）→ commit。

### Task 4: setup 最小版

**Files:** Create `src/cli/setup.ts`（`runSetup(args, io, now): { exitCode, messages }` 按 D-P5S-6 六步）；Modify `src/cli/main.ts`（接线）；Test `tests/unit/cli-setup.test.ts`。

- [ ] 失败测试：全新目录成功路径（config 写入 + 0600、db 建库、readyAt 写入并回显）；重复 setup 不改 readyAt（先 setup、改时钟再 setup，readyAt 保持第一次）；已有 config 无 --force-config 拒绝；凭据文件 0644 → 退出 1 含 chmod hint；schema 错误聚合输出；dry-run/mailbox/db-path 参数落到 config。
- [ ] RED → 实现 → GREEN → commit。

### Task 5: 骨架收尾自检

**Files:** Modify `docs/reports/phase-2-acceptance.md` 不动；Create 无。收尾动作：

- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` 全绿；`node dist/cli/main.js doctor` 在测试机真实跑一遍（配置缺失场景，预期 fail 但渲染正常，退出码 1）——输出贴报告。
- [ ] 在本计划文件末尾追加「完成记录」段：commit 列表 + 测试计数 + 与 Phase 5 全量的差距清单（launchd/systemd、真实 status/pause/resume/logout、交互向导、IMAP 连通检查、日志轮转、10 分钟出口验收）。
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：D10 bin 双名 ✓（Task 3）；§3.3 控制 4（readyAt 首装）产品化 ✓（Task 4）；开放问题 1（凭据存储）不在本计划内扩大——只做权限检查，Keychain/加密文件决策留 Phase 5 正式阶段出 ADR。
- 占位命令 exit 2 与未知命令 exit 2 一致（都是"无法执行所请求命令"），doctor 的健康失败用 exit 1——语义分离。
- 类型一致性：TimeWindowConfig 复用 domain；BridgeConfig 在 Task 1 定义后 Task 2/4 只 import。
- 无占位符：每任务失败测试均为具体断言；代码级细节在锁定接口内交给 TDD。

---

## 完成记录（2026-07-18，Task 5 收尾）

**提交轨迹**（每任务两阶段审查闭环，审查修复即时跟进）：

```
a8ebd9d 落地 Phase 5 CLI 配置层,堵住相对路径的 cwd 依赖坑        (Task 1)
789efc2 落地 doctor 检查引擎,五项本地检查前置到 setup 之前可用     (Task 2)
301d9b5 堵住 25:99 穿透双层校验致时间窗静默判错的缺口             (Task 1 审查修复)
d6d6c41 落地 CLI 入口分发,doctor 得以经 amb 命令实际触达          (Task 3)
9c83934 补齐 credentials-file 权限位掩码,堵住 setuid 误判        (Task 3 折入 Task 2 审查项)
1b5e6e5 落地 setup 最小版,把 readyAt 首装围栏产品化到命令行       (Task 4)
bca5782 兜住 setup 步骤 4/5 的抛出与重试陷阱,不再违背 never-throwing 契约 (Task 4 审查修复)
```

**门禁四件套**（bca5782 上 fresh 运行）：lint/typecheck/build 全部 exit 0；`pnpm test` → **18 files / 281 tests 全过**（本计划净增 +4 文件 / +99 测试）。

**真机冒烟**（收尾验证，隔离 HOME，零副作用）：`node dist/cli/main.js doctor` 在无配置场景正确渲染五项检查（1 pass + 4 fail）、exit 1、不崩溃、不产生文件；Task 4 审查另在隔离目录完成 setup→doctor 五项全 pass→重复拒绝→`--force-config` 下 readyAt 稳定的端到端走查。

**与 Phase 5 正式阶段的差距清单**（本计划刻意不覆盖，正式阶段验收前必须补齐）：

1. launchd（macOS LaunchAgent）/ systemd user unit 模板与安装流（依赖 daemon 存在，Phase 3+）；
2. `status` / `pause` / `resume` / `logout` 的真实语义（当前为诚实占位，exit 2）；
3. setup 交互式向导（问答式收集参数；当前仅非交互 flag 模式）；
4. doctor 的 IMAP 连通性检查项（依赖 Phase 3 真实 transport；DoctorCheck 接口已留扩展位）；
5. 脱敏日志轮转（依赖 daemon 产日志）；
6. 卸载清理顺序；
7. 「干净机器 README 从零到首封结果邮件 ≤10 分钟」出口验收（依赖全链路）；
8. 凭据存储升级决策（macOS Keychain / Linux libsecret vs 0600 文件降级）——spec 开放问题 1，正式阶段出 ADR。
