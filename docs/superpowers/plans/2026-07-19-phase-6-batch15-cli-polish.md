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

- [ ] RED → GREEN → mutation 自证 → commit。

### Task 2: 批次收尾（编排者）

- [ ] 审查（轻量：diff 走查 + mutation 重放）→ 完成记录 → commit + push。

---

## Self-review notes

- spec 覆盖：无新 spec 面——纯兑现批次十四移交 1/2 两项；README 与
  行为同步是批次十四「事实源纪律」的延续。
- 红线：无涉（本地 CLI 行为，零发信零运行零发布）。
- 一致性：退 2 沿 D-P5B13-2；文案与 README Quickstart 对齐。
- 无占位符：两件事各自的改动位、测试点、mutation 自证已具体。
