# dsh-bestthink-standard（最佳思维链标准模式）

**[English](README.md) | [中文](README.zh-CN.md)**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 agent preset：**首轮无条件进入实测最佳思维链**（RL 对齐的 minimal 极简形态），首次工具调用后**自动晋升为完整 Standard 25 工具**并恢复工作区上下文。

> 兼容基线：DeepSeek Harness **0.1.0-rc.5 / 提交 47f9438**。
> 许可：MIT（移植自 `xiaobright/dsh-anchored-standard`；`agent.cordis.yml` 基于官方 `standard` preset 修改——见 [`preset/NOTICE`](preset/NOTICE)）。

---

## 为什么

前沿推理模型的行为被**首份请求的 system prompt 与可见工具目录**强条件化——而非其原始能力。Project2 维护类基准实测（DeepSeek V4 Pro，`reasoning_effort=max`）：

| 条件 | Ability |
|---|---:|
| 官方 `minimal`（1 句 prompt + 2 工具） | **99 / 96** |
| **两阶段锚定**（首轮 minimal，首次工具调用后全量目录） | **98 / 99** |
| 官方 `standard`（一开始就 25 工具） | 91 |

首份请求即锁定会话轨迹；首次持久工具调用后扩展工具目录至多扰动一个推理块、不会翻转模式。因此锚定是"免费的"：**既拿到最佳思维链首轮，又拥有完整 Standard 能力**。

## 工作原理

三大锚定因子把首份请求锁进 RL 对齐的 minimal 形态，**对每个模型统一生效**（无任何按模型特殊化——会话中途切换模型也不可能收到错配的配置）：

1. **system 纯净**——persona 行为 minimal 句 + `complete: true` + `includeRuntimeContext: false`，组装后的 system prompt 精确等于 `You are a helpful software engineer assistant.`（harness 身份、工具指南、插件说明全部被抑制）。
2. **输出预算**——首份请求 `maxTokens=1024`（实测锚定值）；晋升后显式剥离，绝不泄漏到后续步骤。
3. **窄工具面 + 剥离注入**——首份请求只见 `shell + read`；skill-catalog / AGENTS.md 注入消息在 bootstrap 期间被过滤，晋升后自然恢复。

**首轮快速行动引导**——第一波思考是唯一受预算限制的一波，复杂任务的 reasoning 会撞破 1024 导致首轮空转中断。首轮注入一条固定的近场用户消息（实测最强引导位置），**硬性禁止首轮设计思考**，晋升后自动停止：

> *First turn: call exactly one tool NOW (read a file or run a command). Do NOT design, plan, or analyze in this turn — no architecture, no implementation details. All design and planning happens in later steps, after the tool result.*

**晋升**——首次持久 `tool/call` 或 `assistant/message`（`promoteOn: either`）后，全量 Standard 目录、正常预算、工作区上下文（AGENTS.md / 技能目录）全部恢复。system prompt 此后不再变化（至多一次前缀缓存 miss）。

不做任何工具包装抽象（官方 `code` preset 的 `run_code` 层实测更差：92 vs 91-99，且引入新的错误面）。

## 安装

```powershell
# 1. 复制 preset 目录到用户预设根
Copy-Item -Recurse <repo>\preset $HOME\.dsh\.agent-presets\bestthink-standard

# 2. 重启 DeepSeek Harness（预设只在启动时扫描）
# 3. 新建会话，选择「最佳思维链标准模式」（preset.yml 的 name）
```

> 安装目录名（`bestthink-standard`）即 preset id。

## 使用

- **首轮**：minimal 最佳思维链（1 句 system、`shell + read`、1024 预算、无注入、一条快速行动引导）。
- **晋升后**：完整 Standard 25 工具、正常预算、AGENTS.md / 技能目录恢复。
- **无需任何特殊措辞**——minimal 句由预设注入，不是要你手动输入的。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `shellTools` | `[bash, pwsh]` | 候选平台 shell |
| `commonTools` | `[read]` | 首轮核心工具 |
| `promoteOn` | `either` | `tool-call` / `assistant-message` / `either` |
| `bootstrapMaxTokens` | `1024` | 首轮输出预算（晋升后显式剥离） |
| `firstTurnGuideText` | 内置文案 | 首轮快速行动引导（`''` 禁用；自定义文本可替换） |
| `suppressedContextSources` | `[skill-catalog, agent-instructions]` | bootstrap 期间剥离的注入消息源（`[]` 禁用剥离） |

## 验证

1. **单测**：`node --test`（Node ≥ 18）——晋升三模式、maxTokens 覆盖/剥离、注入剥离/放行、引导一次性行为。
2. **结构**（导出会话 JSONL）：首份 `request/header` 应为 `maxTokens=1024`、工具 ≤2（`shell` + `read`）、system 精确等于 minimal 句、含一条 `source.kind: plugin` 引导消息；首次工具调用后的 header 应为全量目录且无 `1024` 残留。
3. **轨迹**（`node scripts/trace-stats.mjs <session.jsonl>`）：英文推理轨迹应呈现 `we` 占优、`let me` ≈ 0、每轮仅一条可见回复（minimal 轨迹指纹）。

## 演进记录

- 第一版包含任务路由器（spec/react/weak 三带 persona 选择，移植自 `dsh-router-standard`），实测后移除：分类器在 assemble 时机读不到首条用户消息（`user/message` 事件在 `agent/pre-step` 瀑布之后才持久化，而 `system-prompt/assemble` 在其之前执行），首轮永远落入 weak 长文本 persona，诱导 reasoning 膨胀撞破 1024 预算导致首轮空转。**最小即最优**：一个无条件锚定，不做路由。
- bootstrap 预算曾短暂按模型自适应，随后统一回 1024：`agent.options.model` 在会话创建时快照，GUI 切换模型会产生陈旧快照；任何按模型的逻辑都有预算/引导错配风险。统一配置免疫此问题。

## 许可与致谢

MIT。本项目移植与组合了：

- [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)（MIT）→ `tool-bootstrap.mjs` 机制与 minimal persona 行
- [`yjh051108/dsh-router-standard`](https://github.com/yjh051108/dsh-router-standard)（MIT）→ 测量方法论与近场引导洞察（未保留代码）
- 官方 DeepSeek Harness `standard` preset（rc.5 / 47f9438）→ 基础组装

完整归属见 [`preset/NOTICE`](preset/NOTICE)。Project2 实测数据来自 [`xiaobright/modeltest`](https://github.com/xiaobright/modeltest)（V4.1b，已冻结）。与 DeepSeek 无关联；实测结果与具体环境相关，不构成通用基准。
