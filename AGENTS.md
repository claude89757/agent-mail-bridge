# Agent 参与规则（AGENTS.md）

> 本文件对**任何**参与本仓库工作的 AI agent（Codex、Claude Code 及其他）生效。
> English note: this file defines mandatory rules for AI agents working in this
> repository. An English version will be provided when the project opens up for
> external contributions; until then the Chinese text is authoritative.

## 唯一权威规格

- 设计与路线图的唯一权威文档：
  [`docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md`](docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md)
  （8 阶段路线图 + 决策表 D1-D10 + MVP 验收标准）。
- 背景细节参考 [`docs/research/gmail-codex-bridge-handoff.md`](docs/research/gmail-codex-bridge-handoff.md)，
  凡与 spec 冲突处一律以 spec 为准。
- 架构性决策记录在 [`docs/adr/`](docs/adr/)，推翻既有决策必须新增 ADR，不得默改。

## 安全红线（违反任何一条立即停止并报告）

1. 只操作 `~/.secrets/amb-test.env` 指向的专用测试邮箱，绝不读写用户的主邮箱；
2. 凭据、token、真实邮箱地址、真实本地路径绝不写入 git、日志或回复文本；
3. 每类"向邮箱发送邮件"的新动作，首次执行前先向用户确认；
4. npm publish、GitHub Release、修改仓库设置等对外发布动作一律不执行，
   到点整理好产物提请用户手动操作；
5. 消耗模型额度的真实 E2E 测试（驱动 codex 实跑任务），先报预估再等用户确认；
6. 外部接口行为与 spec 假设不符时：fail closed、写 ADR、停下来问用户，
   不得为绕过阻塞而降低安全设计。

## 测试凭据约定

- 专用测试 Gmail 账户凭据存放于 `~/.secrets/amb-test.env`
  （`AMB_TEST_IMAP_USER` / `AMB_TEST_IMAP_PASS`，目录 0700、文件 0600）；
- 只在运行时读取；凭据不进入 git、日志、对话与任务提示词；
- 本仓库是 public 仓库：任何示例、文档、测试夹具一律使用占位地址
  （如 `bridge-user@example.com`），不出现真实邮箱。

## 工程约定

- TypeScript strict + ESM + Node ≥ 22；包管理器 pnpm；单包结构（预留 monorepo 演进）；
- 写实现代码前先写失败测试（TDD）；宣称"完成/通过"之前必须附运行证据；
- 模块边界见 spec §3.1：`domain/`（纯逻辑，无 IO）、`transports/`、`drivers/`、
  `application/`、`store/`、`daemon/`、`cli/`；
- 本机 codex CLI 是被测外部系统，通过 `codex exec --json` 子进程驱动；
  禁止 `danger-full-access` 与 `--dangerously-bypass-*`。

## Git 约定

- 小步提交，直接提交 main；
- commit message 用简体中文，标题聚焦"为什么"而非"做了什么"；
  专有名词、标识符、命令、文件名保留原文；
- 保留工具默认追加的 `Co-Authored-By` 行。

## 需要用户介入的时点

- P0-3 需用户从另一邮箱发送伪造对照邮件；
- Phase 3 起需用户手机真机走查；
- Phase 6 的发布动作（npm publish、GitHub Release）由用户执行。

到点用一段话说清楚：需要什么、为什么、用户要做的具体步骤，然后暂停等待。
