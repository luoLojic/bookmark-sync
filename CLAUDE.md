# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目性质

Chrome / Edge MV3 扩展：通过 WebDAV 或 S3 在多设备间同步书签。零运行时依赖，
TypeScript strict，esbuild 打包，vitest 测试。

**权威规格文档在仓库之外**，两份中文文档，实现须严格遵循：

- `C:\Users\HP\Desktop\book\书签同步器-需求文档.md`（v0.1，FR-\* / NFR-\* 编号）
- `C:\Users\HP\Desktop\book\书签同步器-技术规划方案.md`（v1.0，分层、红线、九步协议、测试策略）

源码注释里大量出现 `FR-14`、`NFR-4`、`方案 4.2`、`需求 6.3` 这样的引用，指的就是这两份文档。
改动涉及行为时，先回这两份文档核对；实现与文档不符时，判断是实现错还是文档该更新，
并把结论写进 `HANDOFF.md`。

## 常用命令

```bash
npm run verify        # typecheck + lint + test + size，提交前跑这个
npm run typecheck     # tsc --noEmit
npm run lint          # eslint，含分层依赖与 domain 纯度的静态强制
npm test              # vitest run（约 680 例）
npm run coverage      # domain/ 门槛：行 ≥95%、分支 ≥90%（vitest.config.ts 里是硬门禁）
npm run size          # 打包并校验 < 200 KB
npm run build         # → dist/
npm run build:watch   # 增量构建
npm run clean         # 清 dist / release / coverage / icons
```

跑单个文件或单个用例：

```bash
npx vitest run test/domain/merge.test.ts
npx vitest run -t '选择合并'                  # 按用例名过滤
npx vitest test/engine                        # watch 模式，只看某目录
```

## 架构

### 分层（依赖只能自上而下，ESLint 静态强制）

```
background.ts   MV3 service worker：依赖装配 + 消息路由，不含同步语义
ui/             只渲染与收发消息（经 ui/messages.ts 的消息协议）
scheduler/      chrome.alarms
engine/         唯一决定副作用顺序的地方：commit 状态机、lock、cancellation
domain/         纯函数：tree、diff、merge、order、plan、guard、hash、guid、firstsync
remote/         RemoteStore 抽象 + WebDAV / S3 transport + codec + history
platform/       chrome.bookmarks、fetch、storage、crypto、permissions、keepalive
shared/         errors、logger、config、types
```

`eslint.config.mjs` 用 `no-restricted-imports` / `no-restricted-globals` 把每层的可依赖
范围写死了。越层 import 会直接 lint 失败，不要靠绕路（改 import 路径写法）通过。

### 三条红线

1. **domain 纯度**：`src/domain/**` 内禁止 `chrome.*`、`fetch`、`Date.now()`、`new Date()`、
   `Math.random()`、`crypto.*`。时间、随机源、哈希函数一律由调用方注入
   （见 `CommitDeps` 的 `now` / `nonce` / `hash` / `newGuid`）。
2. **写序**：只有 `engine/commit.ts` 能触发基线落盘，且只在九步协议的最后一步。
3. **错误分类**：每个错误必须归入 `transient` / `fatal` / `userAction` 之一，由
   `shared/errors.ts` 的抽象基类强制。分类不是装饰——transient 会被重试且绝不清状态。

### 四条状态不变量

- **INV-1**：远端提交成功后才写基线。`setBaseline()` 的调用点只允许 `background.ts`
  （装配处），engine 通过注入的 `saveBaseline` 回调触发。
- **INV-2**：GUID 映射表只增不删（`mergeMap` 是唯一入口，且写入已串行化）。
- **INV-3**：瞬时错误绝不清本地状态。`clearBaseline()` 只允许两个入口：
  `FormatVersionTooNew` 处理路径与用户显式重置。
- **INV-4**：不做断点续传，靠「整轮重跑」收敛。任何一步崩溃后重跑一次必须收敛。

`test/shared/invariants.test.ts` 用源码静态扫描把上面这些钉住了。它会因为「顺手多加一个
调用点」而变红——那是设计意图，不是测试太严。

### 提交协议（`engine/commit.ts`，顺序不可调整）

```
READ → MERGE → [GUARD] → APPLY_LOCAL → PUT_HISTORY → PUT_BOOKMARKS ★
                                                           ↓
                       WRITE_BASELINE ← PUT_INDEX ← VERIFY ┘
```

`★ PUT_BOOKMARKS` 是**唯一的原子提交点**：

- ★ 之前一切可安全重来，允许取消（取消按 transient 处理，不清状态）
- ★ 之后**不可再中止**，必须走到终态。取消信号要显式解除对网络层的传导
  （`sealCancellation()` → `engine/cancellation.ts` 的双 signal 闸门），否则 VERIFY 的 GET
  会被打断，基线永远落不下来
- `PUT_INDEX` 失败只记警告（下次提交会重写修复）；`WRITE_BASELINE` 失败必须重试 3 次

sync / upload / download **复用同一个状态机**，只替换 MERGE 阶段的目标树算法
（`engine/sync.ts` 的 `computeTargetFor`）。这是「三个操作可靠性等价」的唯一保证，
不要为某个操作单独写一条路径。

### 两层重试，严格分开

- **HTTP 层**（`platform/http.ts`）：指数退避 + jitter，默认 5 次，重试的是网络抖动
- **合并轮次**（`runCommit` 的 while 循环）：412 或写后校验失败时整体回到 READ，
  最多 3 轮，重试的是逻辑冲突

### 合并算法（`domain/merge.ts`）

不消解两份 diff，而是「三棵树展平 → 逐节点按 (inBase, inLocal, inRemote) 三元存在性
判定 Keep/Drop → 按 parentGuid 装配」。幂等与收敛因此是恒等式的推论。
`domain/order.ts` 的顺序判定是**三方**的（要拿 base 比），不能退回「无条件以本地为骨架」
——那会让两台设备永不收敛（详见 HANDOFF.md 2026-07-30 M1 那节）。

### 远端布局与并发

`bookmarks.json`(.gz) 是当前快照，`history/` 存历史版本，`history/index.json` 是索引。
乐观并发用 `If-Match`/ETag；服务器不支持条件写时进降级模式（写后用 `writerNonce` 校验
是否被并发覆盖）。能力探测结果缓存在 storage，**作废必须删键**（`clearCaps()`），
写哨兵记录会让实例永久停在降级模式。

## 测试约定

- **先写测试表再写实现**，合并判定矩阵的每一行都要有对应用例
- **属性测试**（fast-check）：幂等、同值收敛、`apply(plan(a,b),a)=b`、计划有序、双设备收敛
- **崩溃注入**：`CommitDeps.crashAfter`（阶段边界）与 `crashAfterOps`（应用改动中途）
- **集成测试用 `test/engine/harness.ts`**：一台「设备」= FakeBookmarks + 自己的基线映射 +
  指向共享 FakeRemote 的**真实** WebDAV store。除 store/bookmarks 外一律不替换，
  commit / sync / webdav / http / codec / domain 全在测试路径上
- **静态契约测试**（`test/ui/*.test.ts`、`test/shared/invariants.test.ts`）：`hidden` 不被
  `display` 压过、脚本引用的 id 必存在、CSS 类名与 TS 里 set 的一致、manifest 引用的文件
  必有构建来源。这类「只在浏览器加载那一刻才成立」的约束逻辑测试看不见
- **改完实现要做变异测试**：手工把修复改回缺陷形态，确认对应用例真的变红。
  仓库历史里每一处修复都这样验证过，新增测试也照此办理

`vitest.config.ts` 把 `src/ui/**` 与 `src/background.ts` 排除在覆盖率之外——
`background.ts` 目前零单元测试，是已知的最大测试空洞（见 HANDOFF.md 待办清单）。

## 两个必须遵守的操作约定

**`HANDOFF.md` 只能追加和读取，禁止修改已有内容。** 这是用户明确定下的规则。每一轮
实质性工作结束后追加一节，含日期、提交号、验证结果、与规格文档的偏离、以及留给下一位的
待办。文件顶部也写着这条规则。

**工作副本是 CRLF。** 所有靠字符串匹配定位的批量编辑或变异脚本，必须先
`replace(/\r\n/g, '\n')` 再匹配，**并且匹配失败要断言报错**——否则脚本会「成功」地什么都
没改，而你以为变异体没被杀是测试的问题。另外别用 `node -e` 写含 `\{` `\}` 和换行的正则
一行流（会 SyntaxError，且备份文件根本没生成）。

## 其他

- 界面文字全部经 `chrome.i18n`，key 定义在 `_locales/zh_CN/messages.json`。
  错误的 `messageKey` 要能被 `test/ui/i18n.test.ts` 的扫描找到，别把裸 key 显示给用户
- 提交信息用中文，格式 `fix(engine): 简述（缺陷编号）`
- Git 提交前若报权限问题：`git config --global --add safe.directory C:/Users/HP/Desktop/book/bookmark-sync`
- 不做的事（明确排除在范围外）：端到端加密、移动端、Firefox、标签页同步、移动书签根、
  API 型后端、断点续传、favicon 同步。本机无 Docker，容器化 WebDAV 验收项不在活跃范围
