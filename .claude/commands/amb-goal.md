---
description: 推进 Agent Mail Bridge 到下一个 Phase 出口（可重入 goal 任务）
---

# Agent Mail Bridge 全流程开发 Goal（可重入）

## 总目标

把本仓库从设计文档推进为公开发布的 v0.1.0 开源项目。唯一权威规格：`docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md`（8 阶段路线图 + 决策表 D1-D10 + MVP 验收标准）。背景细节参考 `gmail-codex-bridge-handoff.md`（Phase 0 归档后位于 `docs/research/`），凡与 spec 冲突处一律以 spec 为准。

## 启动自检（每次触发都执行）

1. 确认当前在主仓库根目录（不在 `.claude/worktrees/` 下）且 git 状态干净；执行 `git pull`；
2. 重读 spec 与 `docs/adr/`，对照路线图判断当前所处 Phase；
3. 用一段话报告：当前 Phase、上次停在哪、本次计划推进到哪个出口；然后开工。

## 工作方式（Claude Code 专属）

- 优先使用已安装的 superpowers 技能族：写实现代码前用 test-driven-development；排障用 systematic-debugging；宣称任何"完成/通过"之前用 verification-before-completion，必须附运行证据；
- 相互独立的纯调研/生成类子任务可派 subagent 并行；但涉及**测试邮箱实机收发**与**本机 codex 实跑**的操作保持串行，避免资源互相干扰；
- 上下文管理：一次会话最多推进一个 Phase 出口即停；下一 Phase 由用户在新会话重新 `/amb-goal` 触发。

## 推进规则

- 严格按 spec §5 的 Phase 顺序；达到出口标准后停下，输出验收报告（做了什么、出口标准逐条对照的证据、ADR 链接），等用户人工验收后才允许进入下一 Phase；
- Phase 0 需额外完成三件仓库整理事项：① 创建 LICENSE（MIT，`Copyright (c) 2026 claude89757`）；② 把 `gmail-codex-bridge-handoff.md` 归档到 `docs/research/` 并在文首标注"部分决策已被 spec 取代，以 spec 为准"；③ 创建 `CLAUDE.md` 与 `AGENTS.md`，把本文安全红线固化为项目级规则（对任何后续参与的 agent 生效）；
- 每个 P0 spike 产出一份 ADR（`docs/adr/`），Go/No-Go 结论附可复现步骤；P0-4（Connector 储备实验）timebox 3 个工作日，到期以现有证据出 ADR 收束；
- Git：小步提交，直接提交 main；commit message 用简体中文、标题聚焦"为什么"。

## 环境事实（已就绪，勿重复搭建）

- macOS + Node 24 + pnpm 10 + codex-cli ≥0.140 + Docker；gh 已登录；
- npm 包名 `agent-mail-bridge`（已查证可用），bin 主名同名 + `amb` 短别名；
- 专用测试 Gmail 凭据在 `~/.secrets/amb-test.env`（`AMB_TEST_IMAP_USER` / `AMB_TEST_IMAP_PASS`，0600），只在运行时读取；
- 本机 codex CLI 是 P0-2 与 CodexDriver 的**被测外部系统**，通过 `codex exec --json` 子进程驱动。

## 安全红线（违反任何一条立即停止并报告）

1. 只操作 `~/.secrets/amb-test.env` 指向的专用测试邮箱，绝不读写用户的主邮箱；
2. 凭据、token、真实邮箱地址、真实本地路径绝不写入 git、日志或回复文本；
3. 每类"向邮箱发送邮件"的新动作，首次执行前先向用户确认；
4. npm publish、GitHub Release、修改仓库设置等对外发布动作一律不执行，到点整理好产物提请用户手动操作；
5. 消耗模型额度的真实 E2E 测试（驱动 codex 实跑任务），先报预估再等用户确认；
6. 外部接口行为与 spec 假设不符时：fail closed、写 ADR、停下来问用户，不得为绕过阻塞而降低安全设计。

## 需要用户介入的预期时点

P0-3 需用户从另一邮箱发送伪造对照邮件；Phase 3 起需用户手机真机走查；Phase 6 发布动作由用户执行。到点用一段话说清楚：需要什么、为什么、用户要做的具体步骤，然后暂停等待。

## 完成定义

spec §6 全部验收标准通过 + v0.1.0 发布产物就绪（`npm pack` 校验通过、README/docs 完整、CI 全绿），由用户执行最终发布。
