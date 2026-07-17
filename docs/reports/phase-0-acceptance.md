# Phase 0 验收报告 — 仓库与工程骨架

> 日期：2026-07-17
> 结论：**出口标准全部达成**，证据如下。用户异步 review 本报告；发现问题可随时插话纠正。
> 提交区间：`4a85b65` → `916d8cc`（5 个提交，全部在 main）

## 出口标准逐条对照

| # | 出口标准（spec §5 Phase 0 + goal 附加清单） | 证据 |
| --- | --- | --- |
| 1 | `pnpm test` 全绿 | 2 个测试文件、5 个测试全部通过（tests/unit/package-contract、cli-main） |
| 2 | CI 徽章亮起 | GitHub Actions run 29573441109 `conclusion: success`，5 个 job（macOS/Linux × Node 22/24 + gitleaks）全 success；badge.svg HTTP 200、内容 "passing" |
| 3 | lint / typecheck / secret-scanning 全绿 | `pnpm lint`、`pnpm typecheck` exit 0；gitleaks 本地全历史（11 commits）与 CI 双重扫描 "no leaks found" |
| 4 | docs 骨架 + THREAT_MODEL v0 | `docs/`：README 索引、architecture、**threat-model v0**（资产/信任边界/A1-A7/C1-C10/非目标/待实测项）、security、privacy、operations、compatibility |
| 5 | AGENTS.md / CLAUDE.md 固化安全红线 | `AGENTS.md`（权威源）+ `CLAUDE.md`（import 引用防漂移），提交 f40cf33 |
| 6 | 锁定并记录 Codex CLI / Node 版本 | `docs/compatibility.md`：Node 24.4.1（支持 `>=22`）、pnpm 10.13.1、codex-cli 0.140.0、TS 6.0.3（TS 7 因 typescript-eslint 8.64 不支持而暂缓） |
| 7 | app-server schema 存档 | `docs/reference/codex-app-server-schema/` 261 份 JSON（v1+v2，codex 0.140.0 生成）；核实含 `TurnStartParams.clientUserMessageId` 与 `AppsList*`；敏感串扫描干净 |
| 8 | 附加① LICENSE | MIT，第 3 行 `Copyright (c) 2026 claude89757` |
| 9 | 附加② handoff 归档 | `docs/research/gmail-codex-bridge-handoff.md` 文首归档说明标注"以 spec 为准"，并列举被取代的关键决策 |
| 10 | 附加③ 项目级 agent 规则 | 同 #5 |

## 主要工程决定（记录在案）

- 最小生产代码走完整 TDD 红绿循环：契约测试守护决策 D10（包名 `agent-mail-bridge`、bin 别名 `amb`、Node≥22、ESM），先红（模块缺失）后绿。
- ESLint 全局禁 `console`（仅 `src/cli/` 豁免）——为"脱敏日志"红线在工具层设防。
- `src/` 按 spec §3.1 立 7 个模块目录，各目录 README 写明"做什么/被谁用/依赖什么"。
- 测试目录分层 unit / contract / integration / e2e，e2e 仅手动 workflow（防止默认 CI 消耗模型额度）。

## 遗留与后续

- Phase 0 无 ADR 产出（按 spec，首批 ADR 随 Phase 1 四个 spike 产生）；`docs/adr/` 约定已立（MADR-lite，spike 必附可复现步骤）。
- 顺手清理：上次规划会话遗留的 `.claude/worktrees/` 残留 worktree 与已合并分支。
- 重点建议 review：`AGENTS.md` 红线表述、`docs/threat-model.md` 的控制与非目标边界。
