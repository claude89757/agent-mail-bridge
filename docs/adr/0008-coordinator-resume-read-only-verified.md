# ADR-0008: 协调器多轮 resume 的只读墙已实测钉死 —— 开启 allowResume

- Status: accepted (spike-verified, 2026-07-22;红线 5 已获用户批准、红线 6 gap 关闭)
- Deciders: 用户(产品负责人)+ bridge maintainers
- Refines(细化,不推翻):[ADR-0006](0006-conversational-coordination-layer.md)
  第 52 行「多轮协调对话 = `codex exec resume <thread_id>`」。批次 E-d 出于红线 6
  暂把 `allowResume` **钉死为 OFF**(每轮都跑全新只读轮、丢多轮上下文),本 ADR 用实测
  证据关闭那道 gap 并**开启** resume。安全内核(身份门、执行隔离、脱敏)不动。
- Related:
  - AGENTS.md 安全红线 5(额度:实跑 codex 先报预估等批)、红线 6(外部行为与 spec
    假设不符 → fail closed;**本 ADR 是它的正向收束**:实测证明假设成立才放行);
  - [ADR-0004](0004-p0-2-codex-exec-session-semantics.md)(`exec resume` 的 argv
    不对称:接受 `--json` 不接受 `--sandbox`);
  - [ADR-0007](0007-coordinator-context-prompt-injection-not-mcp.md)(只读载体);
  - `src/drivers/coordinatorDriver.ts`(`COORDINATOR_RESUME_SANDBOX_ARGS`)、
    `src/cli/start.ts`(`buildCoordinatorRuntime` 开 `allowResume`)、
    `src/daemon/ticks.ts`(`runCoordinatorForCommand` 的 resume gate)。

## Context

ADR-0006 把多轮协调定义为 `codex exec resume`:mail thread ↔ 协调器 codex thread ↔
执行 session 三层映射,下一封同线程邮件 resume **同一** 协调器对话,codex 服务端保上下文。

但批次 E-d 接线时撞上一道红线 6 疑虑:codex 0.144.6 的 `exec resume` **不接受
`--sandbox`**(ADR-0004 的 argv 不对称)。新轮靠 `--sandbox read-only` 正面立起只读墙
(ADR-0006 三墙之一),resume 轮却没法用同一个 flag。若 resume 轮的沙箱不是只读,协调器
在多轮里就可能获得写权限——那等于**降级只读墙**,红线 6 明禁「为绕过阻塞而降低安全设计」。

当时无实测证据,只能 fail closed:`allowResume` 钉死 OFF,每轮跑全新 `--sandbox
read-only` 轮(安全但丢多轮上下文,会话式澄清无法跨邮件续接)。钉死处留了活口:
`coordinator_sessions` 照常 upsert,实测证明 resume 只读成立后翻开即恢复,无需数据迁移。

用户在本轮明确要「补协调器活体覆盖」以开启多轮。按红线 5 报预估、获批「跑」后,做下述 spike。

## Decision

**开启 `allowResume`**(生产 `buildCoordinatorRuntime` 默认 ON);协调器 resume 轮的只读墙
改为**驱动层不变式**,不再依赖任何外部/wiring 环节记得传:

1. **resume 只读墙 = `COORDINATOR_RESUME_SANDBOX_ARGS`**(`-c sandbox_mode="read-only"`),
   在 `coordinatorDriver.buildArgv` 的 resume 分支**正面发出**,位置在 `extraArgs`
   **之前**(调用方任何 extraArgs 都盖不住它)。这是新轮 `--sandbox read-only` 的 resume 孪生:
   一个安全不变式,不是 wiring 层的可选项。
2. **`allowResume` 保留为可注入旗**(非 config 字段)。生产恒 ON;单测可翻 false 验证
   fresh-only 路径。config schema **不暴露** `allowResume`——resume 是已验证的驱动不变式,
   不是给运维翻的开关(strict 校验仍拒未知 `coordinator.allowResume` 键)。
3. **三层映射照 ADR-0006 落地**:成功协调轮 upsert `coordinator_sessions`
   (thread_key → 协调器 codex thread_id,last-write-wins);下一封同线程邮件
   `runCoordinatorForCommand` 把它当 `resumeSessionId` 传回。

## Spike(2026-07-22,codex-cli 0.144.6,红线 5 已批;文件系统为准,不信 codex 自述)

探针一律「让 codex 尝试写一个文件、再看文件到底有没有落盘」。全部在 `os.tmpdir()` 下的
抛弃 scratch 目录,占位路径,不碰真实项目/邮箱/凭据。**5 次 codex 调用**(硬上限 8)。

| 调用 | argv 要点 | 写探针结果 | 结论 |
| --- | --- | --- | --- |
| A 新轮 | `exec --sandbox read-only …` | **ABSENT**(被拦) | 新轮只读墙成立(探针法自证) |
| B resume·无 key | `exec resume <id>`(仅 `--ignore-user-config`,即生产旧形) | **ABSENT**(被拦) | **resume 默认即只读**:继承创建时的只读沙箱(ADR-0004「沙箱创建时固定、随 resume 带走」实测确认) |
| C resume·带 key | `exec resume <id> -c sandbox_mode="read-only"` | **ABSENT**(被拦) | 显式 key 与只读兼容 |
| D 新轮·可写 | `exec --sandbox workspace-write …` | **WROTE**(成功) | 对照:创建沙箱可写、探针法能区分成功/被拦 |
| E resume·带 key(接 D 的可写会话) | `exec resume <D-id> -c sandbox_mode="read-only"` | **ABSENT**(被拦) | **决定性**:显式 key **覆盖**了创建时的 `workspace-write`,把 resume 轮压回只读 |

**判决(红线 6 正向收束)**:resume 轮的只读墙**双重保障**——
(a) 默认继承创建时的只读沙箱(B),且协调器新轮恒以 `--sandbox read-only` 建会话;
(b) 显式 `-c sandbox_mode="read-only"` **独立生效**,即便创建时是 workspace-write 也能覆盖回只读(E)。
codex 自述与文件系统一致(A/B/C/E「BLOCKED」,D「SUCCEEDED」)。

argv value 形状:spike 经 bash 送达的是去引号的 `sandbox_mode=read-only`;生产用带引号的
`sandbox_mode="read-only"`(与既有 `approval_policy="never"` 一致)。二者按 codex 文档的
`-c` 契约(「value 按 TOML 解析,解析失败则当字面串」)都归一到 sandbox_mode 字符串
`read-only`——即 spike 验证生效的那个值。活体 resume E2E 再跑一遍生产的**带引号**确切 argv。

## Consequences

**正面**

- 多轮协调恢复(ADR-0006 核心):会话式澄清/追问跨邮件续接,codex 服务端保上下文。
- 只读墙从「依赖 wiring 传 extraArgs」升级为**驱动不变式**+单测钉死(`extra` 之前发出,
  盖不掉),比钉死前的设计更硬。
- 红线 6 是正向收束,不是绕过:实测证明假设成立才放行,`--dangerously-bypass-*` /
  `workspace-write` 从未出现。

**代价 / 负面**

- 依赖 codex 0.144.6 的两条实测行为(创建沙箱随 resume 继承;`sandbox_mode` key 在
  resume 上覆盖生效)。二者都被本 spike 双向验证,并由驱动层单测 + 活体 resume E2E 守住;
  codex 大版本升级后应重跑本 spike(见回归条件)。
- 多轮 resume 的额度略升(每封同线程邮件一轮),ADR-0006 已接受协调层的额度成本。

## 回归条件(何时重跑本 spike)

- 升级 codex CLI 大/中版本;
- 或 `codex exec resume --help` 的 sandbox/config 相关表面变化(尤其 `-c sandbox_mode`
  语义或 `--ignore-user-config` 默认沙箱)。
- 若重跑发现 resume 不再只读:立即 fail closed(驱动不变式已在,但须回本 ADR 记录并
  评估是否翻回 `allowResume` OFF),按红线 6 停下问用户。
