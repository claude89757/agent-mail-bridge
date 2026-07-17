---
description: 全链路自主推进 Agent Mail Bridge 至 v0.1.0 发布就绪（可重入 goal 任务）
---

# Agent Mail Bridge 全链路开发 Goal（自主推进，可重入）

## 总目标

一次触发，自主把本仓库从设计文档推进为 v0.1.0 发布就绪的开源项目，只在安全红线硬 gate 或外部依赖（用户操作、codex 额度）处暂停。唯一权威规格：`docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md`（8 阶段路线图 + 决策表 D1-D10 + MVP 验收标准）。背景细节参考 `gmail-codex-bridge-handoff.md`（Phase 0 归档后位于 `docs/research/`），凡与 spec 冲突处一律以 spec 为准。

## 启动自检（每次触发都执行，支持断点续跑）

1. 确认当前在主仓库根目录且 git 状态干净；执行 `git pull`；
2. 重读 spec、`docs/adr/`、`docs/reports/`（历史验收报告），判断整体进度与断点；
3. 用一段话报告：已完成的 Phase、当前断点、本次计划推进的范围、当前阻塞清单；然后开工。

## 推进模式（全链路自主）

- 按 spec §5 的 Phase 顺序推进，**不逐 Phase 等待人工验收**：每个 Phase 出口对照出口标准逐条自查，把证据写成验收报告 `docs/reports/phase-<N>-acceptance.md` 并 commit，然后直接进入下一 Phase；用户异步 review 报告，随时可能插话纠正；
- 被阻塞时不空等：重排任务顺序先做无阻塞项；所有可做项做完才停，停下时输出**等待清单**（每项：等谁、等什么、恢复后从哪继续）；
- 主会话只做编排与验收，具体实现尽量派 subagent 执行（配合 superpowers:subagent-driven-development），控制主会话上下文膨胀；
- 写实现代码前用 test-driven-development 技能；排障用 systematic-debugging；宣称"完成/通过"之前用 verification-before-completion，必须附运行证据；
- 每个 P0 spike 产出一份 ADR（`docs/adr/`），Go/No-Go 结论附可复现步骤；
- Git：小步提交，直接提交 main；commit message 用简体中文、标题聚焦"为什么"。

## codex 额度编排（当前已耗尽，等待周期 reset）

- **不依赖 codex 额度的工作先行**：Phase 0 全部、P0-1（IMAP IDLE）、P0-3（DKIM 实测）、Phase 2 事件核心、Phase 5 的 setup/doctor 骨架；
- **依赖 codex 额度的排后**：P0-2（exec 实跑）、P0-4（Connector 实验）、Phase 3 派发闭环、Phase 4 路由实测、真实 E2E；
- 每次准备使用 codex 前，先跑最小探测任务（如 `codex exec --ephemeral --skip-git-repo-check "回复 ok"`）确认额度已恢复；未恢复则记入等待清单并继续其他工作；
- P0-4 timebox 3 个工作日，从该实验实际开始之日起算。

## Phase 0 附加清单

① 创建 LICENSE（MIT，`Copyright (c) 2026 claude89757`）；② 把 `gmail-codex-bridge-handoff.md` 归档到 `docs/research/` 并在文首标注"部分决策已被 spec 取代，以 spec 为准"；③ 创建 `CLAUDE.md` 与 `AGENTS.md`，把本文安全红线固化为项目级规则（对任何后续参与的 agent 生效）。

## 环境事实（已就绪，勿重复搭建）

- macOS + Node 24 + pnpm 10 + codex-cli ≥0.140 + Docker；gh 已登录；
- npm 包名 `agent-mail-bridge`（已查证可用），bin 主名同名 + `amb` 短别名；
- 专用测试 Gmail 凭据在 `~/.secrets/amb-test.env`（`AMB_TEST_IMAP_USER` / `AMB_TEST_IMAP_PASS`，0600），只在运行时读取；
- 本机 codex CLI 是被测外部系统，通过 `codex exec --json` 子进程驱动；其用量额度当前已耗尽、按周期恢复。

## 安全红线（不可自主跨越，违反任何一条立即停止并报告）

1. 只操作 `~/.secrets/amb-test.env` 指向的专用测试邮箱，绝不读写用户的主邮箱；
2. 凭据、token、真实邮箱地址、真实本地路径绝不写入 git、日志或回复文本；
3. 每类"向邮箱发送邮件"的新动作，首次执行前先向用户确认（同类动作确认一次后无需重复确认）；
4. npm publish、GitHub Release、修改仓库设置等对外发布动作一律不执行，到点整理好产物提请用户手动操作；
5. 消耗模型额度的真实 E2E 测试（驱动 codex 实跑任务），先报预估再等用户确认；
6. 外部接口行为与 spec 假设不符时：fail closed、写 ADR、停下来问用户，不得为绕过阻塞而降低安全设计。

## 必须暂停等用户的硬 gate（除此之外自主推进）

1. 安全红线 3/4/5 对应的确认点；
2. P0-3 需用户从另一邮箱发送伪造对照邮件（给出具体操作指引后，把该项挂入等待清单，继续并行其他工作）；
3. Phase 3 起的手机真机走查（发出请求后异步等待，继续其他工作）。

## 完成定义

spec §6 全部验收标准通过 + v0.1.0 发布产物就绪（`npm pack` 校验通过、README/docs 完整、CI 全绿），等待清单中只剩"用户执行发布动作"。
