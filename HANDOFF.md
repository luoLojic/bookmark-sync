# 开发交接记录

> 规则：本文件中已经存在的内容只能读取，禁止修改、改写、删除或重排。任何后续交接信息只能追加到文件末尾，并应包含日期、提交号（如已有）和验证结果。

## 2026-07-29 · 接手基线与首次审计

- 接手前源码已原样保存在 Git 根提交 `ad3b149`，后续修复可与原始实现逐项对照。
- 已完整阅读《书签同步器-需求文档》v0.1 与《书签同步器-技术规划方案》v1.0；开发顺序按 M0 → M1 → M2…，M1 未达到测试门槛前不进入 M2。
- 原始验证：TypeScript 通过；ESLint 5 个错误；测试无法启动；构建无法完成。
- 确认的前序缺口：缺少 `src/background.ts`、图标、测试、CI 与依赖锁文件；界面使用的多数 i18n key 与语言包不一致；取消错误分类和映射整表覆盖违反方案不变量。
- 本轮优先修复 M0，不把未完成的同步逻辑伪装成可用功能。

## 2026-07-29 · 第二轮审计与 M0 收口

接手状态：前一位 agent 的改动全部为未提交的工作区修改（基线 `ad3b149` 之上）。本轮先审计再提交，未改动其已有交接内容。

验证结果（本轮修复后全部通过）：`typecheck` 通过；`lint` 无告警；`test` 30 例全过；`size` 打包 19.6 KB / 上限 200 KB。`domain/tree.ts` 行覆盖 100%、分支 98%，达到方案 7.1 门槛。

确认前一位 agent 已修好的问题：i18n key 与语言包对齐、`AbortedError` 改归 `TransientError`（方案 4 要点 4）、缺失的 `src/background.ts` 与图标生成、CI、依赖锁文件。

本轮新发现并修复的三处缺陷：

1. `src/ui/options/options.ts` 二次确认调用了语言包中不存在的 `confirmAgain`，两处重置流程的第二道弹窗会显示 `⟦confirmAgain⟧`。已补该 key，并让第二道弹窗改用原本孤立未被引用的 `confirmResetSyncTitle` / `confirmResetAllTitle` 作标题。
2. `src/platform/storage.ts` 的 `putMap()` 名为「整表替换」实为合并，函数名与语义相反，且无任何调用点。已删除该函数（INV-2 由 `mergeMap` 单一入口保证），同步调整对应单测。
3. `src/background.ts` 中 `remoteCounts: baseline ? null : null` 是恒为 null 的死表达式。已改为直接 `null` 并注明远端计数在 M3 接入。

测试补强：`test/ui/i18n.test.ts` 原先只扫描 HTML 标记，这正是缺陷 1 未被发现的原因。已扩展为同时扫描 UI 脚本中的 `t()` 字面量 key、`confirmDialog()` 实参与 `errors.ts` 的 `messageKey`，并逐项验证过删除任一 key 都会使对应用例失败（非空断言）。

遗留与后续里程碑衔接：
- 语言包中 `guardBodyLocal` / `guardBodyRemote` / `resultSynced` / `capDegradedWarning` / `permissionNeeded` 等约 40 个 key 尚无引用，属 M3–M6 预留，本轮不删。
- `background.ts` 对 sync / upload / download / preview / cancel / testConnection / history 类请求一律返回 `errNotReady`，符合「不把未完成功能伪装成可用」的约定。`StatusPayload.localCounts` 与 `remoteCounts` 目前恒为 null，分别待 M2、M3 接入。
- `src/domain/` 目前仅有 `tree.ts`，M1 的 diff / merge / order / plan / guard / hash / firstsync / guid 全部未开始，是下一步工作起点。
- 仓库 `.git` 属主为另一 Windows 账户，本机操作前需 `git config --global --add safe.directory C:/Users/HP/Desktop/book/bookmark-sync`。
