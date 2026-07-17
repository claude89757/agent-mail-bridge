# CLAUDE.md

@AGENTS.md

本项目的全部 agent 规则（安全红线、工程约定、Git 约定）定义在 `AGENTS.md`，
上方已通过 import 加载；若你的运行环境不支持 import 语法，开工前必须先完整阅读
[`AGENTS.md`](AGENTS.md) 并遵守其中每一条规则，安全红线不容例外。

Claude Code 专属补充：

- 推进阶段任务用项目命令 `/amb-goal`（可重入，一次会话最多推进一个 Phase 出口）；
- 写实现代码前用 superpowers 的 test-driven-development 技能；
  排障用 systematic-debugging；宣称"完成/通过"之前用 verification-before-completion。
