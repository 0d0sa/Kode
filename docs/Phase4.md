# Phase 4 执行方案：代码库理解

> 对应 `implementation-plan.md` §7 Phase 4。状态：**已实现（2026-07-24）**。项目负责人确认的组合 `D1-B / D2-B / D3-B / D4-B / D5-B / D6-B / D7-A / D8-B` 已落地，并通过自动化测试与真实仓库 smoke test。

实现结果：Kode 现在会从共享 ignore 规则发现代码文件，使用固定版本
tree-sitter WASM 解析 TypeScript/TSX、JavaScript、Python、Go 和 Rust，以
SQLite generation 缓存符号、语法引用与模块边；四个有界只读工具和 Phase 3
repository context source 共用同一快照。写入、patch 与 undo 成功后会标记相关
文件失效，下一次查询刷新 generation。Phase 4 不包含 embedding 或远程语义索引。

## 0. 阶段定位

Phase 0–3 已经让 Kode 具备配置加载、多 provider Agent Loop、文件/搜索/命令工具、权限与 undo，以及长任务上下文预算能力。当前 Agent 可以通过 `glob`、`grep`、`read_file` 主动探索仓库，但它仍然是“边找边猜”：

1. 每次新会话都要重复读取目录、manifest 和入口文件，才能建立最基本的项目地图。
2. `grep` 只能找到文本匹配，不能区分定义、引用、导入别名、同名符号和语言语法。
3. system prompt 在会话创建时一次性构造，尚无受 token 预算约束的仓库概览来源。
4. 文件被工具修改后，没有统一的索引失效机制，未来 Planner 也没有可复用的结构化代码库视图。

Phase 4 要增加一个本地、可重建、受工作区边界保护的 Codebase Service。它负责发现文件、解析符号、构建模块依赖、生成仓库概览，并以工具和上下文来源两种方式服务 Agent。

### 0.1 当前实现基线

| 现有基础              | 当前行为                                                                                | Phase 4 缺口                                             |
| --------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `glob` / `grep`       | ripgrep 优先、Node fallback，遵守嵌套 `.gitignore`，跳过 `.git`、`node_modules`、`dist` | 每次查询重新扫描；结果无符号语义                         |
| canonical path 边界   | 文件工具不跟随 symlink 越过工作区，越界单独走权限确认                                   | 索引器还不存在，必须复用相同边界，不能另写一套更宽松规则 |
| `ToolRegistry`        | zod schema、权限、审计、输出截断已经统一                                                | 需要注册只读代码理解工具，并保持输出有界                 |
| `buildSystemPrompt()` | 会话启动时组装平台、日期、规则和工具说明                                                | 无动态仓库概览；把全量概览塞进 system 会挤占不可压缩预算 |
| `ContextManager`      | 完整请求计数、priority/pin、工具压缩、摘要 checkpoint                                   | 需要接收可重新生成的高优先级 repository context source   |
| 文件 mutation/undo    | 写入、替换、patch 和 undo 都有集中入口                                                  | 成功修改后尚未通知索引失效                               |
| 配置 schema           | `src/config/schema.ts` 是唯一权威入口                                                   | 尚无 `codebase` 配置，不能在业务代码中临时读取新字段     |

### 0.2 Phase 4 目标

- 在 Agent 首轮请求前提供一个短小、稳定、可解释的仓库概览。
- 为支持的语言建立文件、符号、定义、引用和模块依赖索引。
- 暴露有界、只读、可中止的代码理解工具，减少盲目 `grep` 和整文件读取。
- 缓存可复用，文件新增、修改、删除和 rename 后只更新受影响部分。
- 与 Phase 2 使用同一套工作区、ignore、文件大小和 symlink 安全边界。
- 与 Phase 3 的 token budget 集成；仓库概览可降级、可替换，但不能挤掉用户任务和项目规则。
- 为 Phase 5 Planner 提供结构化仓库能力，为 Phase 6 session 恢复保留索引版本引用接口。

### 0.3 非目标

- 编译器级类型检查、完整类型推导、跨动态调用的精确 call graph。
- 替代 `tsc`、语言服务器、测试或现有 `grep`；索引结果是导航提示，不是编译事实。
- 自动联网下载 grammar、模型或 embedding，除非 D1/D7 明确选择并另设授权边界。
- 将源码全文、embedding 输入或秘密写入普通日志。
- Phase 5 的任务拆分、自检循环和自动测试规划。
- Phase 6 的跨进程会话恢复、模型切换与 TUI。

## 1. 关键设计决策门

以下选择会影响依赖、包体积、冷启动、隐私、公共接口和预计工期。项目负责人已于 2026-07-24 完成选择；未选方案保留为设计取舍记录，实施必须遵循各节标注的“已确认”方案。

### D1. Phase 4 首批支持哪些语言

| 选项 | 方案                                                           | 优点                                              | 代价/风险                                               |
| ---- | -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| A    | 只支持 TypeScript / JavaScript / TSX / JSX；保留语言适配器接口 | 能在约 4 天内把索引正确性做深；直接覆盖 Kode 自身 | 面对 Python、Go、Rust 仓库时只能退回结构概览和 grep     |
| B    | 内置 TS/JS、Python、Go、Rust 五组 grammar/query pack           | 更接近通用 coding agent；常见仓库开箱即用         | grammar 打包、跨平台测试和符号规范化会增加约 1–2 天     |
| C    | 检测到语言后按需下载 grammar/query pack                        | 初始包最小，理论覆盖范围最大                      | 供应链、离线、版本固定、缓存和任意代码/资源下载边界复杂 |

**已确认：B（内置 TS/JS、Python、Go、Rust 五组 grammar/query pack）。**

无论选择哪项，都采用 `LanguageAdapter` 注册表；不支持的语言仍进入文件树和文本搜索，但不得伪造符号结果。选择 B 时，首批只保证：

- 声明：class、interface/type、function/method、variable/constant、module/namespace。
- 模块边：静态 import/export、CommonJS require、Python import、Go import、Rust use/mod。
- 定义/引用：语法可确认的 identifier；动态字符串、反射和宏展开标记为不完整。

### D2. 语法解析运行时

| 选项 | 方案                                                             | 优点                                                   | 代价/风险                                                 |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| A    | TS/JS 使用 TypeScript Compiler API，其他语言以后分别接编译器 API | TS 语义信息强，定义定位更准确                          | 多语言接口和依赖不统一；与总计划的 tree-sitter 路线不同   |
| B    | 使用 `web-tree-sitter` + 固定版本 grammar WASM                   | 跨平台、无 native 编译；统一查询和打包方式，符合总计划 | WASM 初始化和 query 维护复杂；仍不是类型检查器            |
| C    | 使用 Node 原生 `tree-sitter` binding + 原生 grammar 包           | 解析速度通常更快，生态成熟                             | 安装/打包受 Node ABI 和平台影响，Phase 7 单可执行分发更难 |

**已确认：B（`web-tree-sitter` + 随包固定版本 grammar WASM）。**

grammar 必须随 Kode 固定版本发布并记录 digest；解析器不能在普通索引过程中访问网络。query pack 由仓库维护，升级 grammar 或 query 时递增索引格式版本并重建缓存。

### D3. 索引如何持久化

| 选项 | 方案                                                                                                                       | 优点                                             | 代价/风险                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| A    | 仅内存，每次进程启动重建                                                                                                   | 无缓存迁移、native 依赖和磁盘隐私问题            | 大仓库每次冷启动都慢；Phase 6 resume 无法复用                |
| B    | 全局版本化缓存 `~/.kode/index/<project-id>/`；按总计划用 JSON manifest + `better-sqlite3` generation DB 保存符号、引用和边 | 不污染目标仓库；事务查询和增量更新清晰，可跨会话 | 增加 native 依赖；需要生命周期、权限、损坏恢复和跨平台打包   |
| C    | 项目内 `.kode/index/`，使用可原子替换的 JSON/二进制分片，不引入 SQLite native binding                                      | 缓存位置明确，纯文件格式更易随 tsup 分发         | 污染工作区、容易误提交；只读仓库无法写入；复杂查询需内存加载 |

**已确认：B（`~/.kode/index/<project-id>/` + JSON manifest + `better-sqlite3` generation DB）。**

选择 B 时：

- 目录以不可逆 project ID 命名，不在目录名泄露完整仓库路径。
- 元数据文件记录 schema、Kode 版本、grammar/query digest、配置 digest 和 canonical root 校验值。
- 缓存只保存相对路径、符号/位置/边和必要摘要，不保存源码全文。
- SQLite 内使用 transaction 构建新 generation，再原子切换 active generation；JSON manifest 使用临时文件 + rename。损坏、版本不兼容或 root 不匹配时隔离旧缓存并重建。
- 创建目录和文件时采用仅当前用户可访问的权限；日志只记录 project ID、计数、耗时和错误类别。
- T01 必须验证 `better-sqlite3` 在 Node 20、tsup 和 Phase 7 目标平台上的安装/打包；验证失败时回到 D3 决策门，不能静默换存储格式。

### D4. 启动和增量刷新策略

| 选项 | 方案                                                                               | 优点                               | 代价/风险                                                 |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| A    | 启动时同步完整扫描和解析，全部完成后才进入首轮对话                                 | 状态最简单；首轮所有工具结果完整   | 大仓库首屏等待长；单个 parser 失败可能阻塞 Agent          |
| B    | cache-first：同步完成轻量发现/概览，加载有效缓存；变更文件后台或按查询需要增量解析 | 启动快，索引会逐步变完整；适合 CLI | 需要明确 `building/stale/ready/degraded` 状态和查询一致性 |
| C    | 启动不扫描；第一次调用代码理解工具时才建立索引                                     | 裸启动最快，没用到索引就无成本     | 首次工具调用延迟大；无法在首轮自动注入可靠概览            |

**已确认：B（cache-first + 后台或按查询需要增量解析）。**

推荐的变更判定顺序：

1. 比较相对路径、size、mtime 和语言。
2. 对候选变更文件计算内容 hash，避免仅凭 mtime 误判。
3. 删除旧文件对应的符号和边；只重新解析新增/变化文件。
4. 由 Kode 自己完成 write/edit/patch/undo 后，立即标记相对路径 dirty，下一次概览或符号查询前至少刷新这些文件。
5. 进程外修改不强制常驻 watcher；每次用户 turn 开始或代码理解查询前执行廉价 reconcile。

后台任务仅是内部索引工作，不计入 Agent `maxSteps`。它必须支持 AbortSignal、并发上限和超时；失败时基础 Agent、`glob`、`grep`、`read_file` 仍可使用。

### D5. 模块依赖图做到哪一层

| 选项 | 方案                                                      | 优点                                                     | 代价/风险                                           |
| ---- | --------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| A    | 只记录源文件中的静态 import/export/use 边                 | 简单、跨语言统一                                         | 不知道 workspace/package 和真实入口，概览价值有限   |
| B    | A + package/workspace manifest + 入口/测试/构建脚本启发式 | 能解释项目如何启动、模块如何分层；适合生成 repo overview | 要维护 npm/pnpm、Python、Go、Cargo 等 manifest 适配 |
| C    | B + 函数级 call graph 和动态依赖推断                      | 可直接回答复杂调用链                                     | 没有类型系统时误报高，超出 Phase 4 约 4 天范围      |

**已确认：B（静态模块边 + manifest/workspace/入口与命令识别）。**

依赖边必须带 `kind`、`source` 和 `confidence`。无法解析的 alias、动态 import、宏和反射保留 unresolved edge，不把启发式结果描述成编译器事实。

### D6. 仓库概览如何进入模型上下文

| 选项 | 方案                                                                                              | 优点                                             | 代价/风险                                           |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| A    | 把完整概览拼进 system prompt，并在会话期间保持不变                                                | 实现直观；优先级最高                             | system 不可压缩；仓库变化后陈旧；大项目挤掉任务预算 |
| B    | 扩展 Phase 3，加入有 token 上限的 `RepositoryContextSource`，作为 `high` 优先级的可重新生成上下文 | 能按预算缩放、变更后替换；不会挤掉 required 内容 | 需要扩展 `ContextResolveRequest`、计数和 debug 报告 |
| C    | 不自动注入，只提供工具，模型需要时自己查询                                                        | 上下文最省，接口最小                             | 首轮不了解仓库，重复探索成本仍然存在                |

**已确认：B（Phase 3 中有界、可重新生成的高优先级 context source）。**

概览只包含结构化事实：

```text
Repository
Stack and manifests
Workspaces / packages
Entrypoints
Build and test commands
Top-level modules
Dependency hotspots
Index coverage and freshness
```

默认目标约 1,500–2,000 tokens，并根据 Phase 3 剩余输入预算缩小。它不进入自由 LLM 摘要；预算不足时优先删低价值文件树细节，再只保留 stack、入口和索引状态。完整细节由工具按需获取。

### D7. Phase 4 是否实现向量语义检索

| 选项 | 方案                                                    | 优点                                       | 代价/风险                                               |
| ---- | ------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| A    | Phase 4 暂缓 embedding；使用符号索引、依赖图和现有 grep | 无额外模型/数据库/隐私边界；先验证核心价值 | 自然语言概念搜索能力有限                                |
| B    | 本地 embedding + `sqlite-vec`，只索引分块后的代码/注释  | 离线、查询体验好                           | 模型体积、native 扩展、分块质量和 Phase 7 打包复杂      |
| C    | 使用当前 provider 的 embedding API + 本地向量库         | 不携带本地 embedding 模型，效果可能更好    | 源码会离开本机；provider 不一定支持；成本和凭据边界扩大 |

**已确认：A（Phase 4 暂缓 embedding 和 `semantic_search`）。**

Phase 4 保留 `SemanticSearchProvider` 空接口，但不暴露不可用工具。只有符号检索的精确率、增量索引和实际仓库验收稳定后，再单独设计 M13；不得用“可选”绕过数据外发确认。

### D8. 对 Agent 暴露哪些代码理解工具

| 选项 | 方案                                                                | 优点                               | 代价/风险                                                      |
| ---- | ------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| A    | 按总计划只提供 `list_symbols`、`find_definition`；引用继续用 grep   | 工具面小，约 4 天更容易完成        | “所有调用处”仍依赖文本匹配；模块图只能通过概览间接使用         |
| B    | 增加 `find_references`、`module_dependencies`，共四个小而清晰的工具 | 直接覆盖阶段验收；结果和权限易解释 | schema、输出边界和测试量增加                                   |
| C    | 提供单一 `code_query`，通过 mode 参数查询符号、定义、引用和依赖     | 工具数量少，后续扩展集中           | schema 变成大联合类型，模型易传错 mode 参数，权限/输出不够直观 |

**已确认：B（四个独立工具：符号、定义、引用和模块依赖）。**

四个工具都标记为 workspace 内只读：

- `list_symbols`：按文件、目录、名称、kind 分页列出定义。
- `find_definition`：按 symbol/name + 可选来源位置返回候选定义和置信度。
- `find_references`：返回语法引用；可选是否包含声明；明确 coverage 和 unresolved。
- `module_dependencies`：查看某文件/package 的入边、出边或有限深度邻居。

每项结果至少返回相对路径、1-based 行列、符号 kind、语言和 index freshness。禁止默认返回整段源码；只允许短 signature/snippet，仍受工具统一字节/条目上限约束。

### 1.1 已确认决策记录

| 决策 | 结果 | 锁定内容                                                     |
| ---- | ---- | ------------------------------------------------------------ |
| D1   | B    | 内置 TS/JS、Python、Go、Rust grammar/query pack              |
| D2   | B    | `web-tree-sitter` + 固定版本 grammar WASM                    |
| D3   | B    | 全局版本化缓存 + JSON manifest + `better-sqlite3`            |
| D4   | B    | cache-first + 后台/按需增量刷新                              |
| D5   | B    | 静态模块边 + manifest/workspace/入口与命令识别               |
| D6   | B    | 作为 Phase 3 的有界高优先级 context source 注入              |
| D7   | A    | Phase 4 暂缓 embedding 与向量检索                            |
| D8   | B    | `list_symbols`、`find_definition`、`find_references`、依赖图 |

确认日期：2026-07-24。确认组合：`B / B / B / B / B / B / A / B`。Phase 4 工期据此从约 4 天调整为约 **6–7 天**。

## 2. 不依赖选项的安全与正确性不变量

- 所有扫描、解析和查询都从 canonical workspace root 出发；默认不跟随 symlink，不能借索引绕过 Phase 2 的越界策略。
- 文件发现必须与 `glob`/`grep` 共享 ignore 语义：`.gitignore`、硬排除目录、binary/超大文件限制不能产生两套结果。
- 索引是派生缓存，不是事实来源。缓存不存在、陈旧或损坏时可重建，且不能阻断基础文件工具。
- 每个查询返回 freshness/coverage；结果不完整时明确说明，不能静默当成“没有定义/引用”。
- 解析错误按文件隔离。一个坏文件、缺失 grammar 或未知语法不能使整个仓库不可用。
- 不在 info/debug/audit 日志记录源码、符号 snippet、绝对路径或 embedding 内容；只记录 hash ID、数量、耗时、状态和错误类别。
- 不自动联网下载 grammar、模型或依赖；任何未来下载路径都必须显式配置、校验 digest 并走独立设计。
- 索引构建和查询支持 AbortSignal、时间/文件数/单文件大小/输出条目上限。
- Kode 自身写入成功后必须先失效索引，再向模型报告工具成功；undo 也走同样流程。
- repository context 不能覆盖 system/rules/current user turn，也不能被解释为用户指令；必须使用明确的数据标签。
- 查询结果中的源码和注释仍是不可信项目内容，不得被提升为 system instruction。
- 缓存 schema、grammar/query pack 或归一化规则变化时必须版本失效，不能尝试读取成兼容数据后继续猜测。

## 3. 已确认架构

以下目录基于已确认组合 `D1-B / D2-B / D3-B / D4-B / D5-B / D6-B / D7-A / D8-B`：

```text
src/
├── codebase/
│   ├── types.ts               # snapshot / symbol / location / edge / status
│   ├── errors.ts              # 可诊断、可降级的索引错误
│   ├── discovery.ts           # 文件发现、ignore、语言检测
│   ├── languages/
│   │   ├── registry.ts        # LanguageAdapter 注册与能力查询
│   │   ├── tree-sitter.ts     # WASM runtime 生命周期
│   │   ├── typescript.ts      # grammar/query pack
│   │   ├── python.ts
│   │   ├── go.ts
│   │   └── rust.ts
│   ├── indexer.ts             # 初建、增量 reconcile、dirty queue
│   ├── store.ts               # 缓存版本、原子保存、损坏恢复
│   ├── graph.ts               # import / manifest / workspace 图
│   ├── overview.ts            # 有预算的 RepositoryOverview
│   └── service.ts             # CLI、Context Manager、工具的统一入口
├── context/
│   ├── types.ts               # 增加外部 context source 类型
│   └── manager.ts             # 对 source 计数、裁剪和 debug 报告
├── tools/
│   ├── codebase/
│   │   ├── list-symbols.ts
│   │   ├── find-definition.ts
│   │   ├── find-references.ts
│   │   └── module-dependencies.ts
│   ├── mutation.ts            # 写成功后通知 codebase service
│   └── index.ts               # 注册新工具
├── cli/
│   └── session.ts             # service 生命周期、首轮概览和关闭
└── config/
    └── schema.ts              # 唯一 codebase 配置入口

assets/
└── grammars/                  # 固定版本 WASM 与 query pack（若 D2-B）
```

### 3.1 核心领域模型

建议先锁定语言无关的稳定类型，grammar 细节留在 adapter 内：

```ts
type IndexState = 'empty' | 'building' | 'ready' | 'stale' | 'degraded';

type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'function'
  | 'method'
  | 'variable'
  | 'constant'
  | 'module'
  | 'namespace'
  | 'unknown';

interface SourceLocation {
  path: string; // workspace-relative POSIX path
  start: { line: number; column: number }; // 1-based
  end: { line: number; column: number };
}

interface CodeSymbol {
  id: string;
  name: string;
  qualifiedName?: string;
  kind: SymbolKind;
  language: string;
  location: SourceLocation;
  signature?: string;
  exported: boolean;
  containerId?: string;
}

interface Reference {
  symbolId?: string;
  name: string;
  kind: 'read' | 'write' | 'call' | 'import' | 'unknown';
  location: SourceLocation;
  confidence: 'exact' | 'syntactic' | 'heuristic';
}

interface DependencyEdge {
  from: string;
  to?: string;
  specifier: string;
  kind: 'import' | 'export' | 'require' | 'workspace' | 'manifest';
  confidence: 'exact' | 'syntactic' | 'heuristic';
}
```

`id` 只在同一索引 schema/version 内稳定。公开工具不能要求模型记住内部 ID；应允许 name + path/location 查询，并把候选歧义显式返回。

### 3.2 Codebase Service 边界

```ts
interface CodebaseService {
  start(signal?: AbortSignal): Promise<RepositorySnapshot>;
  status(): IndexStatus;
  reconcile(signal?: AbortSignal): Promise<IndexStatus>;
  markDirty(paths: readonly string[]): void;
  overview(budget: OverviewBudget, signal?: AbortSignal): Promise<RepositoryOverview>;
  listSymbols(query: SymbolQuery, signal?: AbortSignal): Promise<SymbolPage>;
  findDefinitions(query: DefinitionQuery, signal?: AbortSignal): Promise<DefinitionResult>;
  findReferences(query: ReferenceQuery, signal?: AbortSignal): Promise<ReferenceResult>;
  dependencies(query: DependencyQuery, signal?: AbortSignal): Promise<DependencyResult>;
  close(): Promise<void>;
}
```

- CLI session 持有一个 service；工具共享同一实例，不能各自扫描仓库。
- `start()` 可返回部分 snapshot；D4-B 下不要求所有文件解析完成。
- 查询先刷新 dirty 文件，再读取一致版本；后台更新使用 copy-on-write 或单写多读快照，避免读到半个 transaction。
- `close()` 等待或中止未提交构建，保证缓存文件不留下半写状态。

### 3.3 文件发现与语言适配

`discovery.ts` 应从 Phase 2 抽取可复用的 `IgnoreMatcher`/walk primitive，而不是复制 `search/adapter.ts`：

1. canonicalize root，只产生 workspace-relative POSIX path。
2. 排除 `.git`、`node_modules`、`dist`、缓存目录和配置硬排除。
3. 逐层应用 `.gitignore`，保留重新 include 语义。
4. 不跟随目录/文件 symlink；对普通文件执行 binary 和大小检查。
5. 按扩展名、shebang 和 manifest 选择 `LanguageAdapter`。
6. 记录 unsupported、ignored、too-large、parse-failed 数量供 coverage 报告使用。

```ts
interface LanguageAdapter {
  id: string;
  extensions: readonly string[];
  initialize(signal?: AbortSignal): Promise<void>;
  parse(input: ParseInput, signal?: AbortSignal): Promise<ParsedFile>;
}
```

query pack 返回声明、引用和 import captures；公共层统一位置、kind 和边，不让 tree-sitter node 或 WASM 对象逃逸到 store/tool 层。

### 3.4 缓存与增量索引

推荐的 snapshot manifest：

```ts
interface IndexManifest {
  schemaVersion: number;
  projectId: string;
  rootDigest: string;
  kodeVersion: string;
  parserDigest: string;
  configDigest: string;
  generatedAt: string;
  files: Record<
    string,
    {
      language: string;
      size: number;
      mtimeMs: number;
      contentHash: string;
      parseStatus: 'ok' | 'unsupported' | 'too-large' | 'failed';
    }
  >;
}
```

增量更新必须作为一个 generation 提交：

`discover → diff → hash candidates → parse changed → remove deleted → resolve edges → build overview → atomic commit`

如果中途 Abort 或某文件失败：

- 已有 generation 继续提供服务并标记 `stale`。
- 单文件 parse error 写入新 generation 的 coverage，但不丢其他成功文件。
- store 写失败只影响持久化，内存 snapshot 仍可作为当前进程的 `degraded` 结果。

### 3.5 仓库概览与 Phase 3 集成

不把仓库概览永久加入 `buildSystemPrompt()`。建议扩展为请求级 context source：

```ts
interface ContextSource {
  id: string;
  priority: 'high' | 'normal' | 'compressible';
  version: string;
  content: string;
  maxTokens: number;
  strategy: 'truncate-structured' | 'summarize';
  placement: 'current-user-prefix';
}

interface ContextResolveRequest extends TokenCountRequest {
  sources?: readonly ContextSource[];
}
```

`RepositoryContextSource` 的策略固定为 `truncate-structured`：

- `required` 预算仍只留给 system、rules、根任务、最新输入和当前工具链。
- Context Manager 先计算完整请求；概览超预算时让 `overview.ts` 按 section 降级，不调用 LLM 自由摘要。
- source 只在派生请求视图中，以 `<repository-context trust="untrusted-data">` 数据块前缀到当前 turn 最近一条包含人类文本的 user message；不修改 `TerminalSession.history`，不创建连续 user message，也不提升为 system instruction。
- 对 tool loop 的后续 step 仍定位同一条人类 user message并替换数据块，因此不会破坏 Anthropic 的 user/assistant 与 tool-use/tool-result 配对。
- source `version` 使用 index generation + overview config digest。版本变化后，旧请求视图和 token count cache 不复用。
- debug 只报告 `repository tokens=... version=... freshness=...`，不打印内容。
- 没有索引或构建失败时注入短状态说明和基础 manifest 事实，不伪造完整概览。

### 3.6 工具结果约定

所有代码理解工具返回统一 envelope：

```ts
interface CodebaseToolOutput<T> {
  data: T;
  index: {
    state: IndexState;
    generation: string;
    coverage: number;
    staleFiles: number;
    warnings: string[];
  };
  page?: {
    nextCursor?: string;
    truncated: boolean;
  };
}
```

- cursor 必须绑定 query digest + generation，索引变化后返回 `cursor_stale`，不能错页。
- path 始终相对工作区；需要读源码时让 Agent 再调用 `read_file`。
- `find_definition` 同名多候选时按来源文件距离、import edge、qualified name 排序，但全部标注置信度。
- `find_references` 只能承诺“当前已索引覆盖范围内的语法引用”。验收中的“所有调用”必须结合 coverage；必要时用现有 grep 做独立校验。

### 3.7 配置草案

配置只能通过 `src/config/schema.ts` 增加，建议：

```jsonc
{
  "codebase": {
    "enabled": true,
    "languages": ["typescript", "javascript", "python", "go", "rust"],
    "cache": "global",
    "refresh": "incremental",
    "maxFiles": 50000,
    "maxFileBytes": 2097152,
    "parseConcurrency": 4,
    "overviewTokens": 1800,
    "semanticSearch": {
      "enabled": false,
    },
  },
}
```

具体默认值在实现时通过真实 fixtures benchmark 决定，但必须满足：

- 所有数值有合理上下限，错误配置由 zod 在启动时明确拒绝。
- `enabled: false` 时不建索引、不注册不可用工具、不注入伪概览。
- 配置变化进入 `configDigest`，只让真正影响解析/发现的字段使索引失效。
- 不通过 config 接收未校验的 grammar 文件路径或远程 URL。

## 4. 端到端流程

### 4.1 启动

1. CLI 加载并校验配置、创建 provider、权限与工具基础设施。
2. 创建 `CodebaseService`，确定 canonical root 和 project ID。
3. 快速读取 manifest、顶层目录和有效缓存。
4. 生成初始 repository overview；缓存缺失时允许 `building` 状态。
5. 注册所选代码理解工具，共享 service。
6. 每次模型调用前请求最新有界 overview，交给 Context Manager 统一计数。
7. D4-B 下继续增量解析；完成一个 generation 后原子切换。

### 4.2 文件修改

1. write/edit/patch/undo 在原子文件操作成功后得到准确的受影响路径。
2. mutation 层调用 `codebase.markDirty(paths)`。
3. 工具结果仍立即返回；不得为了全库重建阻塞一次写操作。
4. 下一次代码理解查询或用户 turn 前刷新 dirty 文件。
5. 新 generation 发布后 repository source version 变化；下一次 Context Manager resolve 使用新概览。

### 4.3 符号查询

1. zod 校验工具参数和结果上限。
2. canonicalize 可选 path filter，并执行同一工作区边界校验。
3. reconcile dirty/相关文件；超时则使用旧 generation 并标记 stale。
4. 查询 snapshot，排序、分页和截断。
5. 返回位置、置信度、coverage 和 freshness；Agent 可用 `read_file` 验证上下文。

## 5. 实施拆分

### T01 — 锁定决策、依赖与性能基线

- 记录 D1–D8 结果和最终工期。
- 在最小 fixture 上验证 grammar WASM 的 Node 20 ESM/tsup 加载方式。
- 验证 `better-sqlite3` 的 Node 20/tsup/目标平台安装、事务和构建产物加载。
- 测量 1k/10k 文件的发现、缓存加载、单文件解析和内存基线。
- 若 D2-B 或 D3-B 无法被 `tsup` 稳定打包，先回到相应决策门，不临时更换解析器或存储后端。

**完成条件**：依赖、license、包体积和跨平台加载风险有书面结论。

### T02 — 类型、配置和文件发现复用

- 增加 codebase 类型、错误与配置 schema。
- 从现有 search adapter 抽取共享 ignore/walk 规则。
- 覆盖 nested `.gitignore`、重新 include、symlink、binary、超大文件和 Abort。

**完成条件**：索引发现集合与 `glob` 在相同过滤条件下保持一致。

### T03 — LanguageAdapter 与 parser

- 初始化固定 grammar/query pack。
- 归一化定义、引用、signature、位置和 import edge。
- 隔离 parse error，输出 coverage。
- 按 D1 添加各语言 fixtures。

**完成条件**：每种支持语言都能从 fixture 得到稳定 snapshot。

### T04 — Store、generation 与增量 reconcile

- 实现 project ID、manifest、版本校验、原子提交和损坏恢复。
- 处理 add/modify/delete/rename 及自有 mutation dirty path。
- 限制并发、内存和文件数量；支持中止。

**完成条件**：第二次启动命中缓存；单文件变化不重解析无关文件。

### T05 — 依赖图与 repository overview

- 解析 manifest/workspace、入口、build/test scripts。
- 合并源码 import edge，标记 unresolved/confidence。
- 生成 section 化、有 token/条目上限的概览。

**完成条件**：monorepo fixture 能识别 package、入口、测试命令和主要依赖方向。

### T06 — Context Manager 集成

- 增加请求级 context source 及计数/预算报告。
- 实现 repository source 的 deterministic 降级。
- 索引 generation 变化后使相关缓存失效。

**完成条件**：极小窗口下仍保留 required 内容，概览被安全缩小或移除。

### T07 — 代码理解工具

- 按 D8 注册工具、schema、分页、输出截断和 stale cursor。
- 复用 ToolRegistry 的权限、Abort 和审计路径。
- 提供歧义候选、coverage 与 fallback 提示。

**完成条件**：工具可以完成定义、引用、符号和依赖验收，不返回无界源码。

### T08 — 生命周期、mutation 联动和降级

- CLI session 创建/关闭 service。
- write/edit/patch/undo 成功后统一失效。
- parser/store/background task 失败时保持基础 Agent 可用。
- `--debug` 增加无正文的索引状态与耗时。

**完成条件**：修改文件后下一轮查询不会静默返回旧定义。

### T09 — 回归、文档与真实仓库验收

- 完成单元、集成和打包测试。
- 更新 README、配置示例、AGENTS 和总计划状态。
- 在 Kode 自身及至少一个多 package fixture 上执行验收任务。

**完成条件**：全部质量门禁通过，验收记录包含 cold/warm/incremental 数据。

## 6. 测试策略

### 6.1 单元测试

- 文件发现：nested ignore、negation、hard exclude、symlink、binary、size limit。
- adapter：各语言声明/引用/import capture，语法错误和 Unicode 行列。
- store：schema/parser/config 失效、损坏 JSON/DB、原子提交失败。
- reconcile：add/modify/delete/rename、同 mtime 不同 hash、自有 dirty 标记。
- graph：alias、workspace、循环依赖、unresolved edge、入口启发式。
- overview：稳定排序、预算降级、无源码/秘密日志。
- tools：歧义定义、分页 cursor、stale generation、coverage 和 Abort。
- context source：计数、priority、版本失效、required 内容保护。

### 6.2 集成测试

- 首次启动无缓存 → 部分 overview → 索引 ready。
- warm start 命中缓存，不重复解析未变化文件。
- Agent 修改文件后，下一次 `find_definition`/`find_references` 看到新 generation。
- 缓存目录不可写或内容损坏时降级到内存，不影响 grep/read/edit。
- grammar 缺失或单语言初始化失败时，其他语言仍可查询。
- 小 context window 下 repository overview 被缩减，模型请求仍合法。
- `pnpm build` 后 grammar/assets 能从真实 `dist`/bin 启动路径加载。

### 6.3 性能与资源门槛

最终数值在 T01 benchmark 后锁定，测试至少记录：

- 1k、10k、配置上限文件数的 cold discovery 和 warm cache load。
- 每种语言 1 MB 文件的解析耗时与峰值内存。
- 单文件修改后的增量更新时间。
- cache 大小与源代码总大小比例。
- Abort 后后台任务停止时间和未完成缓存清理。

性能退化不应只用宽松 timeout 掩盖；CI 中使用结构性断言，例如“只解析变化文件”和“warm start 不初始化无关 grammar”。

## 7. 验收标准

1. 启动 Kode 后，首轮模型上下文能看到 stack、manifest、入口、构建/测试命令、主要模块和索引覆盖率。
2. repository overview 有严格 token 上限；窗口不足时不会挤掉 system、rules、当前任务和最新用户输入。
3. `list_symbols` 能按路径/name/kind 稳定分页，位置统一为 1-based。
4. `find_definition` 对 import alias、同名符号返回排序后的候选与置信度，不静默猜一个结果。
5. 若选择 D8-B，`find_references` 能在已支持语言和 coverage 内找出 `handleError` 的调用，并说明不完整来源。
6. 若选择 D8-B，`module_dependencies` 能解释入口到目标模块的主要静态依赖路径。
7. Agent 能完成“定位 `handleError` 的所有调用处并解释其异常处理策略”，并用 read/grep 对关键结论做源码校验。
8. 第二次启动可复用缓存；修改一个文件只解析必要文件和受影响依赖。
9. write/edit/patch/undo 后，下一次查询不会把旧 generation 当成最新结果。
10. `.gitignore`、hard exclude、symlink、binary 和超大文件边界与 Phase 2 一致。
11. grammar、单文件解析或缓存失败时基础 Agent 与原有 7 个工具仍可工作。
12. 普通日志、debug、audit 中没有源码、snippet、API Key 或可读绝对仓库路径。
13. `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm build` 全部通过。

## 8. 风险与降级

| 风险                                   | 预防                                       | 降级                               |
| -------------------------------------- | ------------------------------------------ | ---------------------------------- |
| grammar 包体积或 WASM 路径在打包后失效 | 固定 assets manifest；从构建产物做集成测试 | 禁用失败语言，仅保留文件树/grep    |
| 大仓库冷启动过慢                       | cache-first、上限、增量、按语言初始化      | 注入轻量概览并标记 `building`      |
| 语法引用被误认为真实调用               | kind/confidence/coverage + grep/read 校验  | 返回候选，不声称完整 call graph    |
| 缓存损坏或版本漂移                     | generation、digest、原子 rename            | 隔离并重建；必要时内存模式         |
| 进程外修改导致陈旧                     | turn/query 前 reconcile + hash 候选        | 返回 stale warning，不隐藏         |
| Context Manager 被概览挤占             | source 独立预算、结构化裁剪                | 移除低价值 section 或整个 source   |
| watcher/后台任务竞态                   | 单写 generation、Abort、close 约束         | 停止后台刷新，查询时同步相关文件   |
| 多语言 query 维护成本高                | adapter contract + 每语言 golden fixture   | 暂时降低该语言 capability/coverage |
| embedding 泄露源码                     | 默认 D7-A，不实现远程 embedding            | 只使用符号、图和本地文本检索       |

## 9. 对后续阶段的接口

### Phase 5 — Planner / 自检

- Planner 可读取 repository overview，按 package/module 拆分 todo。
- Todo 项可记录 symbol/location/generation，而不是只保存自然语言路径。
- 验证步骤可以从 manifest 图中选择正确的 package test/build 命令。
- 索引只提供事实候选；Planner 仍必须用工具输出和测试结果验证完成状态。

### Phase 6 — 会话恢复与模型切换

- Session Store 只保存 project ID、index generation 和 overview version，不复制索引或源码。
- resume 时重新校验 canonical root 和 generation；仓库变化则 reconcile 后生成新 overview。
- 模型切换导致 token 预算变化时，repository source 重新按新窗口渲染。
- 索引生命周期独立于 provider，不因切换云模型而重建。

### Phase 7 — 打包发布

- grammar WASM、query pack 和 license 必须进入 package assets 清单。
- 构建产物在 macOS/Linux/Windows Node 20 上验证资源定位。
- 全局缓存提供查看/清理命令或明确手工清理文档，不能无限增长。

## 10. 实现完成清单

- [x] D1：首批语言范围已确认。
- [x] D2：解析运行时已确认。
- [x] D3：索引保存位置已确认。
- [x] D4：启动与刷新策略已确认。
- [x] D5：依赖图精度已确认。
- [x] D6：上下文注入方式已确认。
- [x] D7：语义检索范围已确认。
- [x] D8：工具面已确认。
- [x] Phase 4 工期已调整为约 6–7 天。
- [x] 依赖 license、WASM/tsup 加载和本地 SQLite 事务 spike 通过。
- [x] T02–T09 的核心实现、自动化回归、真实仓库 smoke test 与文档更新完成。
