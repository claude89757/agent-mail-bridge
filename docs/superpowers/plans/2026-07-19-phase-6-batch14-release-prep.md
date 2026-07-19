# Phase 6 批次十四：v0.1.0 发布预备产物 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v0.1.0 的发布材料备齐到「用户只剩按红线 4 手动执行 npm
publish + GitHub Release」：README 从 Phase-0 横幅升级为真实用法文档、
root `SECURITY.md` 披露流程、`CHANGELOG.md`、package.json 版本与元数据
终检。**纯文档 + 元数据批**：零代码行为变更、零真实运行。

**Architecture:** 文档必须与 CLI 实际行为逐字对齐（命令、флаг、退出码、
路径均以 `src/cli/**` 现实现为准，写前核对）；诚实定位——E2E 未跑、
识别网关未接线、澄清流未落地的事实在 status 区如实陈述，不许为「好看」
超前宣称。

**Tech Stack:** Markdown。零依赖变更。

**范围裁定（明确排除）：** demo GIF（需真实运行，E2E 后）；VitePress
docs 站（spec Phase 6 项，v0.1.0 tag 后可补，不阻塞发布）；npm publish、
git tag、GitHub Release（红线 4，用户执行）；AGENTS.md 英文版（spec 说
开放外部贡献时再做）。

---

## 锁定决策

### D-P6B14-1 README 重写（保留现有 Why email?/Security first 骨架）

结构（英文，与现 README 一致）：

1. 头部横幅/一句话/badges **不动**；
2. **Status 区更新**：Phase 0 横幅换成如实清单——core pipeline built &
   tested (ingest → route → dispatch → redacted reply → daemon loop,
   800+ tests, all seams faked)；live-verified pieces（IMAP read、SMTP
   send round-trip）；**not yet**: identity-gate wiring (ADR-0003
   pending)、clarification mail flow (real-device walkthrough pending)、
   full end-to-end run。措辞诚实但不自贬；
3. **Quickstart**（from-source，npm 包未发布前唯一路径）：
   `git clone` → `pnpm install && pnpm build` → `node dist/cli/main.js
   setup --self bridge-user@example.com --credentials-env-file
   ~/.secrets/amb.env`（env 文件格式示例：`AMB_IMAP_USER=` /
   `AMB_IMAP_PASS=`，占位值、说明 Gmail 应用专用密码 + 0700/0600 权限）
   → `amb doctor` → `amb start`（前台试跑）→ `amb install`（launchd/
   systemd 常驻，打印的激活命令用户自己执行）；
4. **Command reference 表**：setup / doctor / start (--dry-run) / status /
   pause / resume / install (--force) / uninstall / logout(placeholder)，
   一行一命令 + 退出码约定一句（0 成功 / 1 运行期失败 / 2 用法错误）；
5. **Configuration**：config.json 路径（XDG）+ 字段表（selfAddress、
   credentialsEnvFile、dbPath、projects.roots/aliases、worktreesRoot、
   baseRef、pollIntervalSeconds 5..3600 默认 30）；
6. **How it works** 一段 + 指向 docs/architecture.md 管线图；
7. **Security model 摘要区不动**，核对链接有效。

纪律：所有邮箱一律 `bridge-user@example.com` 族占位；所有路径 `~/` 波浪
线形态；不出现任何真实值；**每条命令行照抄前先在源码里核对该 flag/行为
存在**（写错的 README 比没有 README 差）。

### D-P6B14-2 root SECURITY.md

- Reporting: GitHub private vulnerability reporting（Security Advisories）
  为唯一渠道，不设邮箱（避免占位邮箱被当真实联系方式）；response
  target: acknowledge ≤ 7 days；
- Supported versions 表：0.1.x = supported（唯一行）；
- Scope 提示：本项目威胁模型见 docs/threat-model.md，欢迎按模型逐条
  挑战；out-of-scope: 用户自己邮箱账户的安全、codex CLI 自身漏洞
  （上游报告）；
- docs/security.md 头部 skeleton 状态行同步改为指向 root SECURITY.md。

### D-P6B14-3 CHANGELOG.md + 版本

- Keep a Changelog 格式，`## [0.1.0] - Unreleased`（tag 日期由用户打 tag
  时补）；分组 Added/Security，从 8 个已闭环批次的完成记录提炼 12±4 条
  用户可感知条目（不写内部批次编号，写能力：如 "IMAP ingest with
  crash-safe idempotency"、"redaction funnel on every outbound reply"）；
- package.json `version` 0.0.0 → `0.1.0`；`files` 白名单核对（dist/
  LICENSE/README.md 已有——SECURITY.md 与 CHANGELOG.md 是否入包：入，
  加进 files）；`description`/`keywords` 终检（keywords 缺则补 5-8 个）；
- 发布位交接文案（完成记录里给用户）：`npm publish --dry-run` 先看打包
  清单 → `npm publish` → `git tag v0.1.0 && git push --tags` → GitHub
  Release 正文可引 CHANGELOG 段落。全部用户执行。

### D-P6B14-4 测试与验证

- 纯文档批不加测试；验证 = ①四件套照常全绿（package.json 改动过
  typecheck/build 无影响性核对）；②README 里每条命令在 `node
  dist/cli/main.js <cmd> --help`/源码里逐条核对存在且语义一致，核对
  记录写进实现汇报；③`npm pack --dry-run` 跑一次核对 files 清单
  （只读打包预览，非 publish）。

---

## 任务列表

### Task 1: README 重写

**Files:** Modify `README.md`。

- [ ] 逐命令核对 → 重写 → `npm pack --dry-run` 确认入包 → commit。

### Task 2: SECURITY.md + CHANGELOG.md + package.json

**Files:** Create `SECURITY.md`、`CHANGELOG.md`; Modify `package.json`、
`docs/security.md`（状态行）。

- [ ] 写作 → `npm pack --dry-run` 核对 → 四件套 → commit。

### Task 3: 批次收尾（编排者）

- [ ] 审查（文档准确性 + 红线显示面）→ 修复 → architecture 状态行 +
  完成记录 + 发布位交接文案；
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：Phase 6 的 README 打磨 + SECURITY.md 披露流程 + npm 发布
  **材料**（动作归用户）；demo GIF/docs 站明确后置不阻塞。
- 红线：4（发布动作零执行，`npm pack --dry-run` 是本地只读预览）；
  2（占位地址 + 波浪线路径 + 无真实值）；诚实定位（E2E 未跑不宣称
  10 分钟指标达成，写 target）。
- 一致性：命令面以 src/cli/** 现实现为唯一事实源，写前核对。
- 无占位符：结构与条目数已锁定。
