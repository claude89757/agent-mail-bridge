# Phase 6 批次十五：CLI 收边杂项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 兑现批次十四移交的两件代码收边：①`setup` 成功输出的过期文案
（install 已存在仍说 "arrives with the full Phase 5 release"）；②四个无
flag 命令（doctor/status/pause/resume）拒绝多余参数统一退 2——随后删掉
README 退出码段为此留的限定语。微型批：两件事一个 commit 可完成。

**Architecture:** 参数拒绝在 `dispatch.ts` 路由层做（四命令共享一个
"expects no arguments" 前置检查），不touching 各命令实现；文案改
`setup.ts` 一处 + pin 测试同步。

**Tech Stack:** TypeScript strict + ESM、vitest。零新依赖。

**范围裁定（明确排除）：** `logout` 保持占位（keychain 开放问题）；
`claude-code` keyword 恢复（v0.2）；交互式 setup 向导（follow-up）；
IDLE watch（follow-up）。

---

## 锁定决策

### D-P6B15-1 无 flag 命令拒绝多余参数（退 2）

- `dispatch.ts` 路由层：`doctor`/`status`/`pause`/`resume` 四路由前加
  统一检查——`rest.length > 0` ⇒ 打印
  `amb <cmd>: takes no arguments (usage: amb <cmd>)` 到 err、退 2；
- 与现有 unknown-command/logout 占位的退 2 约定对齐（D-P5B13-2：用法
  错误 = 2）；
- 测试：四命令各一条 `['<cmd>', '--bogus']` → exit 2 + 消息含
  "takes no arguments"；四命令零参数路径现测试保持全绿（行为不变）；
- README 退出码段删掉 "(the flagless commands currently ignore extra
  arguments)" 限定语，改为四命令点名 "reject extra arguments"。

### D-P6B15-2 setup 成功文案更新

- `setup.ts` 成功消息里 "background daemon install arrives with the
  full Phase 5 release" 改为指向现实命令序列（如 "next: amb doctor,
  then amb start (foreground) or amb install (background service)"）；
- pin 该消息的测试同步（先跑失败证明 pin 存在，再改）；
- 措辞与 README Quickstart 步骤顺序一致（doctor → start → install）。

### D-P6B15-3 验证

四件套全绿；mutation 自证：①拒参检查移除 ⇒ 四条新测试红；②文案改回
旧串 ⇒ pin 测试红。README 改动与 CLI 行为经 `node dist/cli/main.js
status --bogus` 冒烟对齐（exit 2）。

---

## 任务列表

### Task 1: 两件收边 + README 限定语删除

**Files:** Modify `src/cli/dispatch.ts`、`src/cli/setup.ts`、`README.md`、
`tests/unit/cli-dispatch.test.ts`（或现命令路由测试所在文件）、
`tests/unit/cli-setup.test.ts`。

- [x] RED → GREEN → mutation 自证 → commit。

### Task 2: 批次收尾（编排者）

- [x] 审查（轻量：diff 走查 + mutation 重放）→ 完成记录 → commit + push。

---

## Self-review notes

- spec 覆盖：无新 spec 面——纯兑现批次十四移交 1/2 两项；README 与
  行为同步是批次十四「事实源纪律」的延续。
- 红线：无涉（本地 CLI 行为，零发信零运行零发布）。
- 一致性：退 2 沿 D-P5B13-2；文案与 README Quickstart 对齐。
- 无占位符：两件事各自的改动位、测试点、mutation 自证已具体。

---

## 完成记录（2026-07-19，批次十五收尾）

| commit | 内容 |
| --- | --- |
| `8a8bb5b` | 本 plan 落盘 |
| `19bc879` | T1：dispatch.ts 路由层 NO_ARGUMENT_COMMANDS 共享 gate（rest 非空 ⇒ stderr "takes no arguments" + 退 2，handler 零触碰）+ setup 成功文案按 Quickstart 顺序指路（doctor → start → install）+ README 退出码段限定语删除；新增 4 拒参测试 + 1 文案 pin 测试 |
| 本提交 | T2 收尾：编排者轻量审查 + 本记录 |

测试 838 → **843**（+5），四件套全绿。

**轻量审查（编排者，per plan Task 2）**：diff 走查通过（gate 位于
help/version/无参处理之后、四命令路由之前；README 措辞由妥协句变事实句；
setup 模块注释第 6 步同步——实现者偏离 2 属同向清障，APPROVED）；两条
mutation 在 exp15 副本独立重放：移除 gate ⇒ 恰 4 红、文案回退 ⇒ 恰
1 红。实现者偏离 1（旧文案本无 pin，改为新增 pin 并以旧串先红证明）
APPROVED——与 plan 意图（防漂移）一致。

**行为面记录**：`amb status --help` 现退 2（"takes no arguments"）——与
带 flag 命令对 `--help` 报用法错误的现状一致（全局 `amb --help` 仍是
帮助出口，exit 0）；如未来给子命令加 `--help`，四命令 gate 需同步放行，
属那时的一并决策。

**批次十四移交清偿**：#1 setup 文案 ✓、#2 无 flag 命令拒参 ✓；#3
（claude-code keyword）留 v0.2。至此**自主可推进项全部完成**，剩余
工作全部等待用户（ADR-0003 / E2E / 真机走查 / 发布五步）。
