# dsh-bestthink-standard（最佳思维链标准模式，BTS）

DeepSeek Harness（DSH）agent preset：**首轮无条件进入 minimal 极简模式的
RL 对齐思维链（实测最佳思维链），首次工具调用后自动晋升为完整 Standard
25 工具 + 工作区上下文恢复**，全程 system prompt 不变、可验证。

> 兼容基线：DeepSeek Harness **0.1.0-rc.5 / 提交 47f9438**（本机 checkout）。
> 许可：MIT；移植自 `xiaobright/dsh-anchored-standard`（MIT），
> `agent.cordis.yml` 基于官方 standard preset 修改（见 `preset/NOTICE`）。

## 原理（一句话）

DeepSeek V4 Pro 的行为被「首轮请求的完整 system prompt + 工具 schema 分布」
强条件化。Project2 实测：**minimal（1 句 prompt + 2 工具）99/96，两阶段锚定
98/99，standard 91** —— 首轮落入 minimal 对齐形态就是最佳思维链。BTS 用
**锚定三因子**把它无条件锁进首轮：

1. **system 纯净**：persona 行 = minimal 句（`complete: true`），组装后
   system 仅有这一句话（identity/工具指南/插件说明全部被抑制）
2. **输出预算**：首轮 `maxTokens=1024`（Pro 实测锚定值；**Flash 模型自动
   提高到 4096**——flash 的 reasoning 明显更长，1024 会令复杂任务首轮
   reasoning 撞预算 → 空转中断；晋升后显式剥离，防泄漏）
3. **窄工具面 + 剥离注入**：首轮仅 shell + `read`；剥离 skill-catalog /
   AGENTS.md 注入消息

**第一波引导（Flash）**：第一波思考是唯一受预算限制的一波，所以除放宽
预算外，还向首轮注入一条固定的"快速行动"近场引导（Flash 专属；system
不变，晋升后自动停止）——第一波想太多是中断的唯一来源，引导它直接动手，
第二波起完全放开。

首次 `tool/call` 或 `assistant/message`（`promoteOn: either`）后自动晋升：
全量工具、正常预算、AGENTS.md/技能目录自然恢复。**不做任何工具包装抽象**
（PTC 教训）。

> 演进记录：曾尝试 router-standard 的任务路由（spec/react/weak 三带 persona
> 选择），实测失败已移除——分类器在 assemble 时机读不到首条用户消息
> （user/message 事件在 pre-step 瀑布后才持久化），首轮永远落 weak 长文本
> persona，诱导 reasoning 膨胀撞破 1024 预算导致首轮空转中断。最小即最优。

## 目录结构

```
dsh-bestthink-standard/
├── preset/
│   ├── agent.cordis.yml       # 核心组装（standard 底稿 + minimal persona 行 + bootstrap 行）
│   ├── preset.yml             # 元数据（name/description）
│   ├── tool-bootstrap.mjs     # 锚定插件（anchored-standard 移植）
│   └── NOTICE                 # 上游 MIT 声明（anchored-standard + 官方 standard）
├── test/                      # node --test 单测
├── scripts/trace-stats.mjs    # 轨迹指纹统计
├── docs/VERIFICATION.md       # 验证步骤（JSONL 检查点）
└── package.json
```

## 安装

1. 复制 `preset/` 目录到用户预设根：

   ```powershell
   Copy-Item -Recurse D:\software\jzpProject\dsh-bestthink-standard\preset `
     $HOME\.dsh\.agent-presets\bestthink-standard
   ```

2. 重启 DSH 进程（预设只在启动时扫描）。
3. 新会话选择「最佳思维链标准模式」（preset.yml 的 name）。

> 安装目录名 `bestthink-standard` 即 preset id；也可改名，但必须与
> `preset.yml` 内容无关（id 取自目录名）。

## 使用

- **首轮**：minimal 思维链（system = 仅 `You are a helpful software engineer
  assistant.`，工具 = shell + read，maxTokens = 1024，无任何注入）
- **晋升**：首次工具调用或首条助手消息后，全量 Standard 工具目录 + 完整
  输出预算 + AGENTS.md/技能目录自然恢复；system prompt 不再变化
- **验证**：导出会话 JSONL，首份 header 的 system 应为**仅 minimal 句**
  （<100 字符），工具 ≤ 2，maxTokens=1024；晋升后全量工具、无 1024 残留

## 验证

三步（详见 `docs/VERIFICATION.md`）：

1. **单测**：`node --test`（Node ≥ 18）
2. **结构**：导出会话 JSONL，检查首份 header（system 仅 minimal 句、
   maxTokens=1024、工具 ≤2、无注入消息）与晋升后 header（全量工具、
   无 1024 残留、注入恢复）
3. **轨迹**：`node scripts/trace-stats.mjs <session.jsonl>` ——
   目标 `let me`≈0、`we` 占优、阶段回复=1（英文轨迹；中文会话参考首轮
   reasoning 块长：minimal 锚定下首块应短而直接）

## 配置面

| 位置 | 键 | 默认 | 说明 |
|---|---|---|---|
| tool-bootstrap 行 | `shellTools` | `[bash, pwsh]` | 候选平台 shell |
| | `commonTools` | `[read]` | 首轮核心工具 |
| | `promoteOn` | `either` | `tool-call` / `assistant-message` / `either` |
| | `bootstrapMaxTokens` | `1024` | Pro 首轮输出预算（晋升后显式剥离） |
| | `bootstrapFlashMaxTokens` | `4096` | Flash 系模型首轮预算（防 reasoning 撞预算中断） |
| | `firstTurnGuideText` | 内置文案 | Flash 首轮"快速行动"引导（`''` 禁用，自定义文本可替换；近场消息注入，system 不变，晋升后停止） |
| | `suppressedContextSources` | `[skill-catalog, agent-instructions]` | 首轮剥离的消息源；空数组禁用剥离 |
| persona 行 | `text` | minimal 句 | 建议保持 minimal 句（实测最佳思维链） |
| | `complete` | `true` | system 仅此一段（锚定的核心） |
| | `includeRuntimeContext` | `false` | 抑制运行时上下文快照 |

## 移植说明与 rc.5 适配（重要）

- **来源**：`xiaobright/dsh-anchored-standard`（MIT）→ `tool-bootstrap.mjs`
  与 persona 行（minimal 句 + complete）；`agent.cordis.yml` 基于官方
  standard（rc.5 / 47f9438）修改。NOTICE 见 `preset/NOTICE`。
- **本仓库新增**（相对 anchored-standard）：
  1. `suppressedContextSources` 配置（空数组可禁用剥离）
  2. `promotionSignal()` / anchor override 导出（工具化，纯函数）
  3. 临时 `off` 锚定 override 不入 append-only promoted 记忆集（可逆）
- **行序铁律**：`tool-bootstrap` 行必须在 `agent.cordis.yml` **第一**且插件
  `inject: []`（waterfall 逆序 → 剥离是最后一个 transform）。
- **缓存铁律**：system 前缀任何动态变化都会导致全量缓存 miss——persona
  固定 minimal 句、全程不变；动态内容（AGENTS.md/技能目录）只走消息侧且
  晋升后才注入，首轮→晋升有且仅有一次目录变化。

## 开发

```powershell
npm test                    # node --test test/
node scripts/trace-stats.mjs test/fixtures/trace-sample.jsonl   # 脚本自测
```

## 已知限制

- 轨迹收益以 v4-pro 实测为准（anchored 98/99 vs standard 91）；Flash 的
  锚定收益未在本机复测，但首轮 system 纯净可消除「提示冗长 + 工具少」的
  错配，中断类问题（reasoning 撞预算）应随之消失。
