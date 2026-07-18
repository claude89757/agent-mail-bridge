# Phase 3 前置批次三：项目 allowlist/索引 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec §3.4 的项目发现组件（Phase 3 五组件中继 worktree manager 后第二个
纯确定性件）：配置的 repo roots allowlist + git 扫描 + alias 索引，
**邮件永远不能指定任意路径**——路由只在索引里按名字/别名查，索引是唯一路径来源。

**Architecture:** 单模块 `src/application/projectIndex.ts`，io 注入模式与安全姿态完全
沿用 `worktreeManager.ts`（realpath 前缀校验、git 白名单子命令、call-sequence 可断言）；
真实 git 临时仓库集成测试 + fake io 错误路径。config 塑形仍归 daemon 批次
（本模块收参数，不读配置文件）。

**Tech Stack:** TypeScript strict + ESM + nodenext、vitest、真实 git（mkdtemp 临时仓库）。

**范围裁定（明确排除）：** 候选评分/thread↔session 映射/`继续、新建`意图（Phase 4
路由批次——本模块只提供索引与精确查找）；config schema（daemon 批次）；
alias 的用户配置格式（daemon 批次接 config 时定，本模块收 `Record<string, string>`）。

---

## 锁定决策

### D-P3B3-1 形状与注入

```ts
// src/application/projectIndex.ts
export interface ProjectEntry {
  /** 索引名（目录 basename，小写归一）。 */
  readonly name: string;
  /** realpath 解析后的绝对路径——唯一可信路径来源。 */
  readonly path: string;
  /** 命中该项目的全部别名（小写归一，不含 name 本身）。 */
  readonly aliases: readonly string[];
}
export interface ProjectIndex {
  readonly entries: readonly ProjectEntry[];
  /** 精确匹配 name 或任一 alias（输入 trim+小写后比较）；无模糊评分。 */
  lookup(term: string): readonly ProjectEntry[];
}
export interface BuildProjectIndexInput {
  /** 配置的仓库根目录白名单；每个 root 的直接子目录中扫描 git 仓库。 */
  roots: readonly string[];
  /** alias → 项目路径（须命中扫描结果，否则 fail closed 报错）。 */
  aliases?: Readonly<Record<string, string>>;
}
export function buildProjectIndex(
  input: BuildProjectIndexInput,
  io: ProjectScanIo,
): Promise<ProjectIndex>;
export function buildDefaultProjectScanIo(): ProjectScanIo; // 生产接线，参照 buildDefaultWorktreeIo
```

`ProjectScanIo` 最小面（实现者按需微调并文档化）：`realpath`、`listDirectories(dir)`
（仅直接子目录）、`isGitRepo(dir)`（`git rev-parse --git-dir`，argv 全常量）。

### D-P3B3-2 安全不变量（每条一测）

1. root 必须存在且 realpath 解析；扫描出的项目路径 = realpath(root 子目录)，且必须以
   realpath(root) + sep 开头（worktreeManager 同款前缀校验）——指向 root 外的
   symlink 子目录 **拒收不入索引**（fail closed，静默丢弃会掩盖配置错误 → 收集为
   构建报告的 `rejected` 列表，见 D-P3B3-4）；
2. 只收 git 仓库（`rev-parse --git-dir` 成功）；非 git 目录跳过（正常情形，不算 rejected）；
3. alias 校验 fail closed：alias 指向的路径不在扫描结果中 → `buildProjectIndex` 抛错
   （配置错误必须暴露）；alias 与任何 name 或另一 alias 冲突（小写归一后重名）→ 抛错；
4. name 冲突（两个 root 下同名目录）：都入索引，`lookup` 返回多条——消歧是 Phase 4
   路由/澄清的职责，本模块不猜；
5. 邮件文本永远不做路径解释：`lookup(term)` 对 term 只做 trim+小写+全等比较，
   含 `/`、`\`、`..`、null 字节的 term 直接返回空数组（防路径味输入，测试钉住）；
6. git 调用面：`rev-parse --git-dir` 是唯一 git 子命令（fake io call-sequence 断言）。

### D-P3B3-3 归一与查找语义

- name = 目录 basename 经 `trim().toLowerCase()`；alias 键同样归一；
- `lookup`：term 归一后与 name/alias 全等比较；命中多个项目返回全部（数组序 =
  entries 序 = roots 参数序 → root 内目录名字典序，确定性可测）；
- 空/全空白 term → `[]`；不做前缀/模糊/包含匹配（评分归 Phase 4）。

### D-P3B3-4 构建报告

`buildProjectIndex` 返回值扩为 `Promise<{ index: ProjectIndex; rejected: readonly RejectedDir[] }>`，
`RejectedDir = { path: string; reason: 'SYMLINK_ESCAPE' | 'ROOT_NOT_FOUND' }`（root 缺失
拒整根并记录，不抛——多 root 场景单个坏 root 不应废掉全部；但 **roots 为空数组** 或
**全部 root 均 rejected** → 抛错，空索引必然是配置错误）。上层（daemon 批次）决定
如何呈现 rejected；本模块不打日志（no-console 红线）。

---

## 任务列表

### Task 1: projectIndex 模块

**Files:** Create `src/application/projectIndex.ts`; Test `tests/unit/project-index.test.ts`。

- [ ] 失败测试（真实 git 临时仓库 + fake io 双轨，风格照 worktree-manager.test.ts）：
  真实轨——两 root 各含 git 仓库/非 git 目录/同名目录，索引条目与 lookup 命中断言；
  symlink 子目录指向 root 外 → rejected 列表含 SYMLINK_ESCAPE 且不入索引；缺失 root →
  rejected ROOT_NOT_FOUND 且其余 root 正常；fake 轨——alias 指向未扫描路径抛错、
  alias 撞 name/alias 抛错、路径味 term（`../x`、`a/b`、`a\0b`）→ `[]`、
  call-sequence 仅 rev-parse --git-dir、roots 空数组抛错、全 root rejected 抛错、
  大小写归一命中、多命中排序确定性。
- [ ] RED → 实现 → GREEN → commit。

### Task 2: 批次收尾

- [ ] 四件套全绿；本计划完成记录；architecture 表将「identity gate 接线/CodexDriver/
  send/IDLE/daemon」行保持 not started、新增或并入 project index done 行；
  threat-model C7 的「项目定位 allowlist + realpath」半句补 *Evidence (partial)* 指针；
- [ ] commit + push。

---

## Self-review notes

- spec 覆盖：§3.4「项目发现」整句逐要素映射（allowlist=roots 参数、git 扫描=isGitRepo、
  alias=校验过的别名表、realpath+拒逃逸=不变量 1、邮件不能指定路径=不变量 5）✓。
- 类型一致性：ProjectEntry/ProjectIndex/RejectedDir 一次定义；io 模式与既有两个
  buildDefault*Io 一致。
- 与 Phase 4 边界：lookup 只精确匹配，评分/消歧/意图明确排除；与 daemon 批次边界：
  config 与 rejected 呈现明确排除。
- 无占位符：每测试点具体；夹具占位值。
