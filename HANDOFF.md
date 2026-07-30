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

## 2026-07-30 · M1 domain 核心完成

提交：`5d07563`（guid/hash/crypto）、`5534f7e`（diff）、`7f6e16c`（order）、`ee26958`（merge）、`df031f3`（plan）、`8c5a2af`（guard）、`3f7cd58`（firstsync）、`cf1af96`（顺序三方判定修正）。

验证：typecheck、lint 通过；213 例测试全过；domain 行覆盖 99.59%、分支 94.94%，达到方案 7.1 的 M1 门槛（95% / 90%）；打包 19.6 KB / 上限 200 KB。

方案 7.2 的 5 条属性测试全部落地：幂等、同值收敛、`apply(plan(a,b),a)=b`、计划有序、双设备收敛。第 5 条方案原本建议放到 M4，但它在纯函数层面就能验证（一次同步等价于 `T = merge(baseline, local, remote)` → `apply(plan(local,T))` → `baseline'=T`），不必等 engine，因此在 M1 就补齐，M1 验收条件得以按字面满足。

九个 domain 模块全部完成：tree、guid、hash、diff、merge、order、plan、guard、firstsync。另加 `platform/crypto.ts` 提供注入侧的 SHA-256 与随机源。

### 本轮最重要的发现：需求 6.3 的顺序规则会导致永不收敛

方案 7.2 第 5 条一写出来就抓到真缺陷。两台设备各自在同一文件夹追加一条书签（最常见的并发编辑）永不收敛：

```
第 1 轮  A=[a]      B=[b,a]   远端=[b,a]
第 2 轮  A=[a,b]    B=[b,a]   远端=[b,a]
第 3 轮  A=[a,b]    B=[b,a]   远端=[b,a]   ← 无限乒乓
```

根因是需求 6.3 规则 1「以本地的顺序为骨架」若无条件成立，每台设备每次同步都把对方的顺序改回自己的。副作用不止顺序抖动：每轮都判定「内容有变化」，于是每次定时同步都写一份历史快照，FR-14 的无变化短路永远不生效，远端 `history/` 无限膨胀。

已改为三方判定：拿本地顺序与基线比，只有真改过顺序的一侧才当骨架，两侧都改过时仍以本地为准；判断「改过」只比公共元素的相对顺序，故单纯新增或删除不算重排。这不是放宽需求 —— 反而让需求 6.3 自己写的「最终以先同步者的顺序为准，另一方的重排会在下次同步时被覆盖」第一次真正成立（原实现下后同步方永远不会采纳对方顺序，那句话不可能发生）。`OrderInput` 因此新增 `base` 字段。**若后续要修订需求文档，6.3 规则 1 应据此更新。**

### 其他对方案的偏离与补充（均已在代码注释与提交信息中说明）

1. `hash.ts` 把逻辑根标题替换为固定占位符后再哈希。「书签栏」在英文界面下是 "Bookmarks bar"，属设备本地界面标签；若参与哈希，两台语言不同的设备会永久互判「内容有变化」。
2. `merge.ts` 增加父链循环检测。方案未提及，但字段级 parentGuid 判定会真的造出环（本地把 A 移入 B、远端把 B 移入 A 时两个节点各自「只有一侧改」），环上节点从根不可达会被装配阶段静默丢弃 —— 表现为整片书签消失而输出树本身仍合法。兜底时沿各侧父链回溯所属逻辑根，避免条目在 bar 与 other 之间搬家。
3. `plan.ts` 的 `LocalOp.create` 用平铺 `type/title/url`，而非方案 3.3 写的 `node: Bookmark | Omit<Folder,'children'>`。两者同构，平铺不必构造没有 children 的假 Folder。
4. `platform/crypto.ts` 用纯 JS 同步实现 SHA-256 而非 `crypto.subtle.digest`。后者是异步的，采用它会让 `HashFn` 及 merge/commit 全链路变成 async。已与 WebCrypto 在 14 种长度（含 55/56/57、63/64/65 两组填充边界）、多字节 UTF-8 与 100KB 载荷上交叉校验。
5. `domain/guid.ts` 的随机源是必填参数，不提供 `Math.random` 默认值 —— ESLint 红线一规则拦下了默认参数，规则是对的：默认值会让不纯性在调用点不可见。

### 工作方法说明（后续里程碑建议延续）

每个模块都按「先写测试表再写实现」推进，实现后用变异测试验证测试不空转：手工改坏实现的关键分支，确认对应用例真的失败。本轮共验证 26 个变异体，全部被杀。两处因此改进了测试或实现：

- `hash.test.ts` 原先用字符串长度充当假哈希，节点在两棵根之间移动时总长度不变，漏掉该差异 —— 改为 FNV-1a。
- `plan.ts` 原先无条件钳制索引，变异测试显示它完全不可观测（`splice` 本身就钳制越界），属于假装提供保证的死代码 —— 改为「越界容忍 + 负数报错」并各有用例。

`merge.ts` 的循环打破最初只被 1 个定点用例杀死（随机森林几乎撞不出父链互换），为此补了一条定向属性：同一批文件夹在两侧各按随机嵌套组织。

### 下一步

M2 本地适配：`platform/bookmarks.ts`、逻辑根识别（含 `folderType` 校验）、映射表读写与批量策略实测、plan 应用器、FakeBookmarks。`domain/plan.ts` 的 `applyPlan` 是严格的纯参考实现（前置条件不满足即抛错），M2 的真实 applier 必须对齐它的语义；差别在于面对 `chrome.bookmarks` 时还需显式把越界索引钳到长度以内。

M2 验收要求对 900/120 树完成一次全量应用 < 5s，并把映射写入性能实测数据记录在 PR 描述中，据此定稿方案 3.1 的批量策略（默认先逐条同步写）。
