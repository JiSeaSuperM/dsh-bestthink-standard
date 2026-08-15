# dsh-bestthink-standard（最佳思维链标准模式，BTS）

DeepSeek Harness（DSH）agent preset：**首轮进入与任务匹配的训练对齐思维轨迹
（spec / react 稳定带），首次工具调用后自动晋升为完整 Standard 25 工具 +
工作区上下文恢复**，全程 system prompt 不变、可观测、可调优、可验证。

> 兼容基线：DeepSeek Harness **0.1.0-rc.5 / 提交 47f9438**（本机 checkout）。
> 许可：MIT；移植自两个上游研究项目并保留 NOTICE（见 `preset/NOTICE`）。

## 原理（一句话）

DeepSeek V4 Pro 的行为被「首轮请求的完整 system prompt + 工具 schema 分布」
强条件化。BTS 用**锚定三因子**把首轮锁进 RL 训练对齐形态：

1. **输出预算**：首轮 `maxTokens=1024`（最强因子）
2. **窄工具面**：首轮仅 shell + `read`
3. **剥离注入**：首轮过滤 skill-catalog / AGENTS.md 注入消息

任务分类（build→react / fix→spec / 模糊→weak）决定首轮 persona 与核心
工具集；首次 `tool/call` 或 `assistant/message`（`promoteOn: either`）后
自动晋升。**不做任何工具包装抽象**（PTC 教训）。

## 目录结构

```
dsh-bestthink-standard/
├── preset/
│   ├── agent.cordis.yml       # 核心组装（standard 底稿 − persona 行 + 2 bootstrap 行）
│   ├── preset.yml             # 元数据（name/description）
│   ├── tool-bootstrap.mjs     # 锚定插件（anchored-standard 移植）
│   ├── router-core.mjs        # 纯路由逻辑，零依赖（router-standard 移植）
│   ├── router-bootstrap.mjs   # Cordis 插件：persona 注入 + 引导 + dev_* 工具
│   └── NOTICE                 # 上游 MIT 声明（两来源 + 官方 standard）
├── test/                      # node --test 单测（68 例）
├── scripts/trace-stats.mjs    # 轨迹指纹统计
├── docs/VERIFICATION.md       # 验证步骤（JSONL 检查点）
└── package.json
```

## 安装

1. 复制 `preset/` 目录到用户预设根：

   ```powershell
   # Windows（%USERPROFILE%\.dsh）：
   Copy-Item -Recurse D:\software\jzpProject\dsh-bestthink-standard\preset `
     $HOME\.dsh\.agent-presets\bestthink-standard

   # 或从本仓库根目录（含 preset 子目录）：
   #   cp -r preset ~/.dsh/.agent-presets/bestthink-standard
   ```

2. 重启 DSH 进程（预设只在启动时扫描）。
3. 新会话选择「最佳思维链标准模式」（preset.yml 的 name）。

> 安装目录名 `bestthink-standard` 即 preset id；也可改名，但必须与
> `preset.yml` 内容无关（id 取自目录名）。

## 使用

- **自动路由**（默认 `mode: auto`）：首条用户消息按关键词分类：
  - build/create 类 → **react**（doer persona，write-first 核心工具）
  - fix/debug/维护类 → **spec**（plan-first persona，read-first 核心工具）
  - 模糊/未命中 → **weak**（模型自分类；每次真实用户消息后追加一条固定
    近距离引导，复杂任务用深度引导）
- **晋升**：首次工具调用或首条助手消息后，全量 Standard 工具目录 + 完整
  输出预算 + AGENTS.md/技能目录自然恢复；system prompt 不再变化。
- **dev 工具**（会话内可观测/调优）：
  - `dev_trajectory_status` — phase（bootstrap/promoted）+ 锚定配置
  - `dev_anchor_mode` — `either|tool-call|assistant-message|off|auto`
  - `dev_router_status` / `dev_router_mode` — 模式查看/切换
    （`spec|weak|mixed|react`、0-100、0.0-1.0、`auto`；`mixed` 为过渡带陷阱，
    仅显式指定）
  - `dev_mode_subagent` — 隔离上下文按异模式跑任务

## 验证

三步（详见 `docs/VERIFICATION.md`）：

1. **单测**：`node --test`（68 例全绿；Node ≥ 18，本机 Node 24）
2. **结构**：导出会话 JSONL，检查首份 header（maxTokens=1024、工具 ≤3、
   无注入消息）与晋升后 header（全量工具、无 1024 残留、注入恢复）
3. **轨迹**：`node scripts/trace-stats.mjs <session.jsonl>` ——
   目标 `let me`≈0、`we` 占优、阶段回复=1

## 配置面

| 位置 | 键 | 默认 | 说明 |
|---|---|---|---|
| tool-bootstrap 行 | `shellTools` | `[bash, pwsh]` | 候选平台 shell |
| | `commonTools` | `[read]` | 首轮核心工具 |
| | `promoteOn` | `either` | `tool-call` / `assistant-message` / `either` |
| | `bootstrapMaxTokens` | `1024` | 首轮输出预算（晋升后显式剥离） |
| | `suppressedContextSources` | `[skill-catalog, agent-instructions]` | 首轮剥离的消息源；空数组禁用剥离 |
| router-bootstrap 行 | `mode` | `auto` | `auto` 分类 / 固定 band（`spec`/`weak`/`mixed`/`react`） |
| | `promoteOn` | `either` | 必须与 tool-bootstrap 行一致（两插件共享晋升信号） |
| | `extraReactKeywords` | `[]` | 域扩展：额外 react 关键词 |
| | `extraSpecKeywords` | `[]` | 域扩展：额外 spec 关键词 |

## 移植说明与 rc.5 适配（重要）

- **来源**：`xiaobright/dsh-anchored-standard`（MIT）→ `tool-bootstrap.mjs`；
  `yjh051108/dsh-router-standard`（MIT）→ `router-core.mjs` /
  `router-bootstrap.mjs`；`agent.cordis.yml` 基于官方 standard
  （rc.5 / 47f9438）修改。NOTICE 见 `preset/NOTICE`。
- **rc.5 vs rc.6**：router 上游声明 rc.6。经 `D:\software\deepseek-harness\packages\`
  源码核对，本机 rc.5 中全部依赖 API 形状一致，**无需适配**：
  `system-prompt/assemble`、`agent/request`（返回 `LlmCallConfig{maxTokens?}`）、
  `agent/pre-step`（`PreStepDecision`）、`session/event`、`inbox.append`、
  `tools.register`、`llm.stream`（`text-delta`/`reasoning-delta`）。
- **移植修复/差异**（上游源码 bug，本仓库已修并在提交信息记录）：
  1. `router-bootstrap.mjs` 上游调用 `extractText` / `bandOf` 但未导入 →
     已导入（否则 weak 模式每次真实用户消息 ReferenceError）。
  2. 晋升信号统一：上游 router 只观察 `tool/call`，与 `promoteOn:
     assistant-message|either` 冲突 → 两插件共享 `promotionSignal()` 纯函数，
     以 tool-bootstrap 行的 `promoteOn` 为准。
  3. 晋升后 `contexts` 恢复：上游 router 晋升后仍清空 contexts → BTS 在
     晋升分支保留 contexts（bootstrap 阶段才清空），符合「上下文自然恢复」。
  4. 新增 `suppressedContextSources` 配置（上游较新版本特性，测试已移植）。
  5. 临时 `off` 锚定 override 不入 append-only promoted 记忆集（可逆）。
- **行序铁律**：`tool-bootstrap` 行必须在 `agent.cordis.yml` **第一**且插件
  `inject: []`（waterfall 逆序 → 剥离是最后一个 transform）；`router-bootstrap`
  行第二且 `inject: ['systemPrompt','tools','llm']`——两个 inject 声明**别搞混**。
- **缓存铁律**：所有引导/锚定文本是硬编码常量；动态内容（weak 引导）只走
  用户消息侧；system prompt 前缀任何动态变化都会导致全量缓存 miss。

## 开发

```powershell
npm test                    # node --test test/
node scripts/trace-stats.mjs test/fixtures/trace-sample.jsonl   # 脚本自测
```

## 已知限制

- `dev_trajectory_status` 的缓存变化计数：rc.5 未暴露请求缓存观测 API，
  当前只报 phase（见工具输出说明）。
- 轨迹收益以 v4-pro 实测为准（anchored 98/99 vs standard 91）；Flash 的
  锚定收益未在本机复测，但风格归一本身可观测。
