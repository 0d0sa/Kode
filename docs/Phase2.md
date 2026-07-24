# Phase 2 执行方案：工具与权限完善

> 对应 `implementation-plan.md` §7 Phase 2。状态：**已实现**。2026-07-24 项目负责人确认 D1–D6 全部采用 B，同日完成代码、自动化测试和文档接线。

## 0. 阶段定位

Phase 1 已经打通最小闭环：

`用户指令 → LLM → Tool Registry → read/replace/run → tool_result → LLM 总结`

在 Phase 2 实施前，Agent 只能读取已知路径、精确替换单个文件和执行 shell；权限也只按工具名判断。本阶段已经把它提升为可以在真实仓库中安全搜索、创建和批量修改代码的版本。

### 0.1 Phase 1 基线（实施前）

| 已有基础                 | 当前限制                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| `read_file`              | 必须先知道文件路径；绝对路径可直接访问                            |
| `replace_in_file`        | 支持唯一匹配与单文件 `replace_all`；没有原子写入、版本校验和 undo |
| `run_command`            | 所有命令统一视为写操作；没有命令级风险分类                        |
| `ToolRegistry`           | zod 校验、allow/confirm/deny、once/session                        |
| `permissions` 配置       | 只有 `default` 和按工具名的 `overrides`                           |
| pino 日志                | 有工具执行日志；没有独立、可查询的权限审计事件                    |
| AbortSignal              | 已贯穿确认、工具执行和子进程，可继续复用                          |
| `ToolResult.output/meta` | 可承载搜索摘要、修改摘要和审计关联 ID                             |

### 0.2 Phase 2 目标

- 新增 `glob`、`grep`、`write_file`，补齐“发现文件 → 搜索内容 → 创建/修改文件”能力。
- 加固 `read_file`、`replace_in_file` 和 `run_command` 的路径、并发修改与大文件行为。
- 将工具级确认门升级为可解释、可配置、可审计的权限系统。
- 为每次写操作提供恢复路径，避免一次错误工具调用造成不可逆修改。
- 保持 Phase 1 的 provider、Agent Loop、REPL 和 Abort 语义不变。

### 0.3 非目标

- token 预算、摘要和上下文压缩（Phase 3）。
- tree-sitter、符号索引和语义搜索（Phase 4）。
- Todo/Planner、并行工具调度和自动自检（Phase 5）。
- Ink TUI、diff 富渲染、持久会话（Phase 6）。
- 容器沙箱和完整操作系统级隔离。

## 1. 设计决策门

以下 6 项会实质改变配置 schema、工具接口或安全边界。备选方案保留为决策记录，当前实现必须按每节标记的 B 方案执行。

### D1. 工具可访问的路径范围

| 选项 | 方案                       | 优点                           | 代价/风险                                |
| ---- | -------------------------- | ------------------------------ | ---------------------------------------- |
| A    | 保持现状：允许任意绝对路径 | 能力最强，适合跨仓库任务       | 只读工具默认放行时可能读取仓库外敏感文件 |
| B    | 默认工作区内；越界时确认   | 安全与能力平衡；仍可显式跨目录 | 所有工具都要做 realpath/symlink 边界判断 |
| C    | 永远禁止工作区外访问       | 边界最清晰，最容易推理和测试   | 无法操作相邻仓库或用户明确指定的外部文件 |

**推荐：B。** 工作区内只读操作可自动允许；工作区外的读取、搜索、写入都进入单独确认，写入还可以被配置为直接 deny。无论选择哪项，都必须以 canonical path 判断，不能通过 `..` 或 symlink 绕过。

**已确认：B（默认工作区内，越界时确认）。**

### D2. 权限策略的粒度

| 选项 | 方案                             | 示例                                               |
| ---- | -------------------------------- | -------------------------------------------------- |
| A    | 保留按工具名配置                 | `overrides.run_command = "confirm"`                |
| B    | 有序规则：工具 + 路径 + 命令前缀 | 允许 `grep`；确认 `write_file`；允许 `pnpm test`   |
| C    | capability/sandbox 权限令牌      | 给一次任务签发 workspace-read、test-execute 等能力 |

**推荐：B。** 它足以支持真实项目，又不会提前引入完整沙箱。建议规则模型：

```ts
type PermissionDecision = 'allow' | 'confirm' | 'deny';

interface PermissionRule {
  id: string;
  decision: PermissionDecision;
  tools?: string[];
  paths?: string[];
  commandPrefixes?: string[];
}
```

建议决策顺序：

1. 执行内置不可绕过约束（Abort、路径规范化、输入合法性）。
2. `permissions.rules` 从上到下取首条匹配；无匹配时兼容旧 `permissions.overrides`。
3. 仍无匹配时，工作区内只读默认 allow；写入和执行使用显式 `permissions.default`，未设置则 confirm。
4. 配置结果为 deny 时立即拒绝，session grant 永远不能覆盖 deny。
5. 配置结果为 allow 时直接允许。
6. 结果为 confirm 时再检查 session grant；grant 应按“工具 + 路径范围/命令前缀”授权，不再只记工具名。

**已确认：B（工具 + 路径 + 命令前缀的有序规则）。**

### D3. `glob` / `grep` 的执行后端

| 选项 | 方案                     | 优点                             | 代价/风险                          |
| ---- | ------------------------ | -------------------------------- | ---------------------------------- |
| A    | 强依赖系统 `rg`          | 快、语义成熟、实现最小           | 新机器没装 ripgrep 时工具不可用    |
| B    | `rg` 优先，Node 实现降级 | 有 rg 时快；无 rg 时仍可完成任务 | 两套实现要做兼容测试，增加依赖     |
| C    | 只使用 Node 库           | 跨平台行为统一                   | 大仓库性能通常弱于 rg，grep 要自写 |

**推荐：B。** `rg` 负责高性能路径；降级使用 `fast-glob` + `ignore` + Node 流式文本扫描。两条路径必须共享结果格式、排序、ignore、上限和 Abort 行为。

**已确认：B（rg 优先，Node fallback）。**

### D4. Phase 2 的编辑工具组合

| 选项 | 方案                                  | 优点                             | 代价/风险                      |
| ---- | ------------------------------------- | -------------------------------- | ------------------------------ |
| A    | `write_file` + 现有 `replace_in_file` | 接口简单，模型容易稳定调用       | 多段修改调用次数多             |
| B    | A + `apply_patch`（unified diff）     | 适合多 hunk 修改，贴近工程工作流 | patch 解析和错误提示测试量较大 |
| C    | 以 `apply_patch` 为主，弱化精确替换   | 能力集中                         | 小改动更难生成，模型兼容性较差 |

**推荐：B。** 保留精确替换作为最稳的小修改路径，同时增加 patch 处理复杂编辑。所有覆盖式写入建议采用：

- 临时文件 + rename 的原子写入。
- 覆盖已有文件必须提供 `expected_sha256` 做乐观并发校验；文件在 read 后被外部修改时拒绝覆盖。
- 保留原权限确认和 Abort 写前复查。
- 输出修改文件、修改字节数、旧/新 hash 和 undo 记录 ID。

如果不希望 Phase 2 体量扩大，可选 A，并把 `apply_patch` 延后。

**已确认：B（write + replace + apply_patch）。**

### D5. Undo 的存储位置与触发方式

| 选项 | 方案                                        | 优点                             | 代价/风险                               |
| ---- | ------------------------------------------- | -------------------------------- | --------------------------------------- |
| A    | 项目内 `.kode/undo/` + REPL `/undo`         | 透明、随项目定位，符合主计划原文 | 会污染工作区，需要处理 gitignore        |
| B    | `~/.kode/undo/<project-id>/` + REPL `/undo` | 不修改目标仓库，集中清理         | 项目移动后映射和生命周期更复杂          |
| C    | 依赖 Git，写前要求干净并记录基线            | 不复制文件，用户熟悉 Git 恢复    | 非 Git 项目不可用；不能擅自 stash/index |

**推荐：B。** 使用全局快照，不自动执行 `git add`、stash、checkout 或 reset。每次写工具在成功 rename 前写入：

- canonical path 与项目 ID。
- 原文件是否存在、mode、内容或压缩内容。
- 修改前 hash、时间、run ID、tool call ID。

`/undo` 默认只恢复最近一次写工具产生的整组文件；恢复本身也需要确认。Phase 2 只提供用户触发的 `/undo`，不向模型暴露 `undo_last_edit`，避免模型自行回滚用户认可的修改。

**已确认：B（全局 undo 存储 + REPL `/undo`）。**

### D6. 权限审计的存储方式

| 选项 | 方案                        | 优点                           | 代价/风险                        |
| ---- | --------------------------- | ------------------------------ | -------------------------------- |
| A    | 复用普通 pino 日志          | 实现最小                       | 难以单独查询，日志级别可能丢事件 |
| B    | `~/.kode/audit/` 独立 JSONL | 不污染仓库，事件稳定、便于检索 | 需要轮转和保留策略               |
| C    | 项目内 `.kode/audit.jsonl`  | 每个项目审计独立               | 污染仓库并可能泄露路径/命令      |

**推荐：B。** 审计事件独立于 `logLevel`，至少记录：

```ts
interface AuditEvent {
  timestamp: string;
  runId: string;
  cwd: string;
  tool: string;
  decision: 'allow' | 'confirm' | 'deny';
  source: 'builtin' | 'config' | 'session' | 'user';
  scope: 'once' | 'session' | 'config';
  inputSummary: string;
  outcome?: 'ok' | 'error' | 'aborted';
  durationMs?: number;
}
```

审计不得记录文件正文、API key、完整环境变量或未截断的大命令。敏感键名先脱敏，摘要再做长度上限。

**已确认：B（全局独立 JSONL 审计）。**

### 1.1 决策记录

| 决策 | 结果 | 锁定内容                                        |
| ---- | ---- | ----------------------------------------------- |
| D1   | B    | 工作区内默认访问，canonical path 越界单独确认   |
| D2   | B    | 工具、路径、命令前缀的有序权限规则              |
| D3   | B    | ripgrep 优先，Node 搜索实现降级                 |
| D4   | B    | write、replace、unified diff patch 三种编辑路径 |
| D5   | B    | `~/.kode/undo/<project-id>/` 与用户 `/undo`     |
| D6   | B    | `~/.kode/audit/` 独立 JSONL                     |

## 2. 已锁定的不变量

这些约束不依赖 §1 的选择：

- zod schema 是工具输入和注入 LLM JSON Schema 的唯一来源。
- 所有相对路径基于 session `cwd`；权限判断使用 canonical path。
- 文件列表使用相对路径、稳定排序，输出设置条目数和字节双上限。
- 默认尊重 `.gitignore`，默认跳过 `.git/`、`node_modules/`、`dist/` 和二进制文件。
- 新工具必须支持已取消信号，并在发生副作用前再次检查 AbortSignal。
- 写工具先确认、后备份、再原子写入；失败不得留下半写文件。
- 覆盖已有文件必须携带 read 阶段得到的 hash，写前再次校验，冲突时拒绝覆盖。
- 不记录文件正文、密钥和环境变量值；错误信息不得回显秘密。
- `ToolResult.output` 面向模型、保持简洁；结构化统计放入 `meta`。
- 保持 ESM、`.js` 相对导入、`import type` 和当前 TypeScript 严格选项。
- 不编辑或提交 `dist/`，不自动更改用户的 Git index、stash 或分支。

## 3. 目标工具契约

具体字段可在实现时微调，但语义在决策后锁定。

### 3.1 `glob`

用途：按 glob 模式发现文件和目录。

```ts
const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  ignore: z.array(z.string().min(1)).optional(),
  hidden: z.boolean().optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});
```

约束：

- 默认根目录为 `cwd`，结果返回相对路径。
- 默认仅返回文件；如需目录，后续增加显式选项，避免混合语义。
- 默认 `hidden=false` 且尊重 ignore；用户显式请求时才搜索隐藏文件。
- 达到上限时返回 `truncated=true` 与已省略提示。
- 结果字典序稳定，便于模型重试和测试。

### 3.2 `grep`

用途：在文本文件中搜索文字或正则。

```ts
const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  literal: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  context: z.number().int().min(0).max(10).optional(),
  max_matches: z.number().int().min(1).max(5000).optional(),
});
```

约束：

- 默认正则；`literal=true` 时按纯文本搜索。
- 输出格式固定为 `relative/path:line:column: text`。
- context 行必须明确标记，不能计为独立匹配。
- 跳过二进制和超大文件；具体阈值在实现时写入常量和边界测试。
- rg 与 fallback 的差异通过归一层抹平，测试只依赖公共结果。

### 3.3 `write_file`

用途：创建新文件或明确覆盖整个文件。

候选契约：

```ts
const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().optional(),
  create_directories: z.boolean().optional(),
  expected_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
```

约束：

- 文件已存在且 `overwrite !== true` 时拒绝。
- 覆盖已有文件时必须先 `read_file`，并使用其 hash 做乐观校验。
- `create_directories` 默认 false，避免拼错路径时创建整棵错误目录。
- 成功结果包含创建/覆盖状态、字节数、新 hash 和 undo ID。

### 3.4 `replace_in_file` 加固

- 保持唯一匹配和显式 `replace_all`。
- 将字符计数改为字节安全的输出上限。
- 增加最大输入文件限制，超限时引导使用 patch 或其他工具。
- 通过共享 File Mutation Service 完成权限、备份、hash 校验和原子 rename。
- 如果 read 后文件发生变化，返回冲突而不是覆盖新内容。

### 3.5 `apply_patch`

- 输入为单个 unified diff；可以包含多个文件和多个 hunk。
- 先完整 parse 和 dry-run，任一 hunk 不匹配则整次失败，不允许部分应用。
- 禁止绝对路径、`../` 逃逸和 symlink 越界。
- 所有目标文件组成一个 undo group。
- Phase 2 不支持 binary patch、rename、mode-only change 和 Git 特有扩展。

### 3.6 `read_file` 加固

- 复用统一 Path Resolver 和 workspace boundary。
- 大文件改为流式读取，避免先将整个文件载入内存。
- `meta` 返回 canonical path、size、mtime 和 sha256，供写工具并发校验。
- 明确 UTF-8 解码失败与二进制文件错误。

### 3.7 `run_command` 权限加固

- 只有没有 shell 运算符、重定向和命令替换的简单命令才参与 prefix allow。
- 复合命令、管道、重定向、变量展开和 `bash -c` 嵌套默认 confirm。
- 未知命令默认 confirm，不通过脆弱 denylist 假装安全。
- session grant 绑定规范化命令前缀，不等于永久允许所有 `run_command`。
- 保留进程组终止、有界输出和超时逻辑。

## 4. 权限系统候选架构

已确认的目标结构如下：

```text
src/
├── permission/
│   ├── types.ts        # rule / request / decision / source
│   ├── policy.ts       # 纯函数规则匹配和优先级
│   ├── scope.ts        # session grant key
│   ├── summarize.ts    # 脱敏输入摘要
│   └── audit.ts        # JSONL writer
├── tools/
│   ├── path.ts         # canonical path + workspace boundary
│   ├── mutation.ts     # backup + hash check + atomic write
│   ├── fs/
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   └── write.ts
│   └── edit/
│       └── apply-patch.ts
```

Registry 的职责保持为统一入口：

1. 查找工具。
2. zod 校验输入。
3. 生成结构化 PermissionRequest。
4. Policy Engine 返回 decision、source、reason 和可授权 scope。
5. 写入 permission audit。
6. 必要时询问用户。
7. 执行工具。
8. 写入 outcome audit，并把结果回灌 Agent Loop。

Policy Engine 必须尽量是无 I/O 纯函数；路径规范化、审计写入和终端确认由边界层负责。

## 5. 配置演进设计

在保持旧配置兼容的前提下增加规则：

```jsonc
{
  "permissions": {
    "default": "confirm",
    "overrides": {
      "read_file": "allow",
    },
    "rules": [
      {
        "id": "deny-env-files",
        "decision": "deny",
        "tools": ["read_file", "grep", "write_file", "replace_in_file"],
        "paths": [".env", ".env.*"],
      },
      {
        "id": "allow-project-search",
        "decision": "allow",
        "tools": ["glob", "grep"],
        "paths": ["**/*"],
      },
      {
        "id": "allow-tests",
        "decision": "allow",
        "tools": ["run_command"],
        "commandPrefixes": ["pnpm test", "pnpm typecheck"],
      },
    ],
  },
}
```

兼容策略：

- `permissions.default` 和 `overrides` 在 Phase 2 继续有效。
- `rules` 是可选增量，不改变已有配置含义。
- 冲突规则按数组顺序首条匹配，并在 `kode config` 中打印来源。
- schema 仍以 `src/config/schema.ts` 为唯一权威。
- 日后若需要配置版本升级，另做 migration；Phase 2 不提升顶层 `version`。

## 6. 工作分解（WBS）

| ID  | 任务                                                   | 依赖      | 产出                              |
| --- | ------------------------------------------------------ | --------- | --------------------------------- |
| T01 | 按已确认 D1–D6 回写接口和配置 schema                   | —         | schema.ts、permission types       |
| T02 | Path Resolver：realpath、symlink、workspace boundary   | D1        | tools/path.ts + 单测              |
| T03 | Search Adapter 与能力探测                              | D3        | tools/search/adapter.ts           |
| T04 | `glob` 工具                                            | T02,T03   | tools/fs/glob.ts + 单测           |
| T05 | `grep` 工具                                            | T02,T03   | tools/fs/grep.ts + 单测           |
| T06 | File Mutation Service：hash、backup、atomic write      | D4,D5,T02 | tools/mutation.ts + 单测          |
| T07 | `write_file` 与 `replace_in_file` 加固                 | T06       | tools/fs/write.ts、replace.ts     |
| T08 | `apply_patch`                                          | T06       | tools/edit/apply-patch.ts + 单测  |
| T09 | Policy Engine 与 session scope                         | D2,T02    | permission/policy.ts、scope.ts    |
| T10 | `run_command` 权限请求结构化                           | T09       | shell/run.ts、permission adapter  |
| T11 | Audit Writer 与输入脱敏                                | D6,T09    | permission/audit.ts、summarize.ts |
| T12 | Registry/Session 接线与旧配置兼容                      | T04–T11   | registry.ts、session.ts           |
| T13 | system prompt、默认注册器、README/AGENTS/examples 更新 | T12       | prompt.ts、文档                   |
| T14 | 回归、集成与真实临时仓库验收                           | 全部      | tests/unit、tests/integration     |

建议实施顺序：

1. 先锁定决策和纯函数边界。
2. 先写 Path Resolver、Policy Engine、Mutation Service 的单测。
3. 再实现 glob/grep/write/patch。
4. 最后接 Registry、Session、审计和 REPL `/undo`。

### 6.1 工期影响

原主计划的 ~3 天只够最小组合（D2-A、D3-A、D4-A，权限和 undo 只做薄层）。已确认方案包含 fallback、细粒度策略、patch、全局 undo 和独立审计，实施工期锁定为 **5–6 个工作日**。

## 7. 测试策略

### 7.1 单元测试

- Path Resolver：相对/绝对路径、`..`、不存在目标、父目录 symlink、文件 symlink、大小写差异。
- Policy Engine：规则顺序、旧 overrides、default、session scope、deny、越界请求。
- Search：排序、ignore、hidden、二进制、UTF-8、上限、Abort、rg/fallback 一致性。
- Mutation：create/overwrite、hash 冲突、权限位、原子失败、Abort、undo group。
- Patch：多 hunk、多文件、冲突、路径逃逸、部分失败回滚。
- Audit：allow/confirm/deny、outcome、轮转、并发 append、脱敏和截断。

### 7.2 集成测试

- 使用临时 Git 仓库，不修改真实工作区。
- 同一测试矩阵分别强制 rg 和 fallback 后端。
- 模拟用户 allow once、allow session、deny、Abort。
- 模拟文件在 read 与 write 之间被外部修改。
- 模拟 patch 第二个 hunk 失败，验证第一个 hunk 没有落盘。
- 模拟 undo 后内容、mode 和不存在文件状态恢复。

### 7.3 回归门禁

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

Phase 1 的 66 个单测必须继续通过；Phase 2 测试不能访问真实 `~/.kode` 或真实网络。

## 8. 验收用例

1. **搜索闭环**：在临时仓库执行“找出所有 TODO，按文件列出”，结果尊重 `.gitignore` 且稳定排序。
2. **主验收任务**：执行“找到所有 TODO 并改成 FIXME”，Agent 使用 glob/grep 定位，再通过 replace/patch 修改。
3. **拒绝路径**：首次写入确认选择 deny，所有目标文件和 undo 存储均不变化。
4. **session 放权**：只对所选路径范围生效，不扩大为所有写工具全局放行。
5. **越界访问**：通过绝对路径、`..` 和 symlink 尝试访问工作区外，行为符合 D1。
6. **并发冲突**：read 后由外部进程修改文件，写工具检测 hash 冲突并拒绝覆盖。
7. **原子 patch**：多文件 patch 中任一 hunk 失败，所有文件保持原样。
8. **Undo**：一次多文件编辑后 `/undo`，内容与权限位恢复，新增文件被移除。
9. **命令权限**：简单已放行前缀按规则执行；复合命令仍进入确认。
10. **审计**：allow/deny/confirm/aborted 均有事件，日志不含测试密钥和文件正文。
11. **无 rg 降级**：模拟 PATH 中无 rg 时仍能搜索，或按 D3-A 给出明确安装指引。
12. **中断清理**：搜索、写入、patch 和命令在 Abort 后不继续产生副作用。
13. **Phase 1 回归**：纯对话、read、replace、run、退出码和 config 脱敏保持正常。

## 9. 完成定义

- [x] D1–D6 已由项目负责人确认并回写本文。
- [x] glob/grep/write 与选定编辑工具完成并注册。
- [x] workspace boundary、hash 冲突和原子写入有自动化测试。
- [x] 权限请求可解释，once/session scope 不越权。
- [x] 每次权限决策和工具 outcome 有脱敏审计。
- [x] Undo 能恢复覆盖、创建和多文件修改。
- [x] §8 中可自动化的验收路径均有测试覆盖；真实模型端到端由本地配置决定。
- [x] Phase 1 回归、typecheck、test、lint、format、build 全绿。
- [x] README、AGENTS.md、配置示例和主计划同步。

## 10. 风险与缓解

| 风险                      | 影响                   | 缓解                                                    |
| ------------------------- | ---------------------- | ------------------------------------------------------- |
| symlink/realpath 判断错误 | 读写工作区外文件       | 集中 Path Resolver；权限和执行使用同一个 canonical path |
| rg 与 fallback 语义不一致 | 同一任务结果不稳定     | 公共归一层 + 双后端契约测试                             |
| patch 部分成功            | 工作区处于不可预测状态 | 全量 dry-run、undo group、失败回滚                      |
| read 后文件被外部修改     | 覆盖用户新修改         | hash/mtime 乐观并发校验                                 |
| session 放权范围过大      | 一次允许变成后续任意写 | grant key 包含工具、路径或命令前缀                      |
| 审计包含秘密              | API key/源码泄露       | 字段 allowlist、敏感键脱敏、摘要长度上限                |
| undo 快照无限增长         | 占用磁盘               | 大小/时间双保留策略，清理时不影响当前 run               |
| 搜索大仓库输出过多        | 上下文爆炸             | match/byte 双上限、稳定截断提示                         |
| 配置升级破坏旧项目        | Phase 1 用户无法启动   | 保持 overrides/default 兼容，rules 仅为可选字段         |

## 11. 与后续阶段的接口

- Phase 3 Context Manager 可直接压缩 glob/grep 的有界输出，不需要改变工具接口。
- Phase 4 Codebase Index 可以复用 Path Resolver、ignore 和 Search Adapter。
- Phase 5 Planner 可以根据审计/ToolResult meta 判断任务进度和失败原因。
- Phase 6 TUI 可以订阅结构化 PermissionRequest、diff preview 和 undo event。
- Phase 7 回放测试可以使用 audit/run ID 关联一次完整工具链。

D1–D6 已全部按 §6 的依赖顺序实现；后续变更应继续保持本节列出的安全边界。
