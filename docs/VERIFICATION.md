# VERIFICATION — dsh-bestthink-standard

验证分三层：**单测（自动化）** → **结构验证（JSONL 检查点，安装后人工）** →
**轨迹验证（trace-stats 指纹）**。

---

## 1. 单测（自动化，必须全绿）

```powershell
cd D:\software\jzpProject\dsh-bestthink-standard
node --test          # 或 npm test
```

覆盖：
- 晋升判定三模式：promoteOn `tool-call` / `assistant-message` / `either`；
  `promotionSignal` 纯函数；临时 `off` override 可逆
- maxTokens：首轮 cap 1024；晋升后**显式剥离**（seed proposal 继承上一请求
  cap，不剥离则泄漏全程）；非 bootstrap cap 的其它 maxTokens 保留
- 注入剥离：只作用于未晋升阶段；`suppressedContextSources` 可配置/可禁用；
  skill-invocation 手势与 plugin 消息保留；晋升后 skill-catalog /
  agent-instructions 自然放行；reject 决策原样透传
- trace-stats：样例 JSONL 的词频 / p50 / 阶段回复 / header 转换报告

## 2. 结构验证（JSONL 检查点，安装后人工执行）

前置：预设已安装（见 README「安装」），DSH 已重启，用 bestthink-standard
开一个新会话并发送一个任务（如「修复这个仓库里的 bug」），随后导出会话
JSONL（`dsh session export <id>` 或 Web GUI 导出）。

### 检查点 A — 首份 `request/header`（锚定生效）

```json
{ "header": { "config": { "maxTokens": 1024 }, "tools": [ ... ] } }
```

- `config.maxTokens` === 1024（`bootstrapMaxTokens`）
- `tools.length` ≤ 3，且恰好 = 一个平台 shell（win32 上为 `pwsh`）+ `read`
- `header.system` === **`You are a helpful software engineer assistant.`**
  （minimal 句；`complete: true` 抑制了 identity/工具指南/插件说明等全部
  其它 section）——这是锚定的核心检查点
- 该请求的 pre-step 消息里**没有** `source.kind ∈ {skill-catalog,
  agent-instructions}` 的消息（AGENTS.md / 技能目录已被剥离）

### 检查点 B — 首次 `tool/call` 后的下一份变更 `request/header`（晋升生效）

- 工具全量（25 个左右，与官方 standard 一致）
- `config.maxTokens` **无 1024 残留**（剥离生效；若残留说明泄漏，检查
  `agent/request` 的剥离分支）
- 后续 pre-step：AGENTS.md / 技能目录消息**重新出现**（注入自然放行）

### 检查点 C — system prompt 全程不变

- 全量导出中所有 `request/header` 的 `header.system` 文本一致（除了
  检查点 A→B 之间的唯一一次工具目录变化；该变化只 miss 一次缓存）

## 3. 轨迹验证（trace-stats 指纹）

```powershell
node scripts/trace-stats.mjs <exported-session.jsonl>
```

对照目标（anchored-standard 实测指纹）：

| 指标 | 目标 | 说明 |
|---|---|---|
| `let me` | ≈ 0 | 第一人称独白 = 未对齐轨迹的标志 |
| `we` | 占优 | 集体式规划轨迹（英文轨迹） |
| 阶段回复（visible replies） | = 1 | 每轮只有最终一条可见总结 |
| reasoning p50 | 记录即可 | 与 baseline（官方 standard）对比；minimal 锚定下应明显更短 |
| 首/末 header | 1024+tools≤3 → 无1024+tools 全量 | 结构证明锚定与晋升 |

> 中文会话无英文词频可用，以 reasoning 块长与首轮产出判定：minimal 锚定下
> 首轮 reasoning 应短而直接，**首轮必须产出工具调用或可见回复**（若首轮
> reasoning 过长且无输出，说明预算/锚定有问题——参见「首轮中断」教训）。

## 4. 验收清单

- [ ] `node --test` 全绿
- [ ] 检查点 A：首份 header 的 system 仅 minimal 句、maxTokens=1024、
  工具 ≤3、无注入消息
- [ ] 检查点 B：晋升后工具全量、无 1024 残留、注入恢复
- [ ] 检查点 C：system 文本全程不变（缓存只 miss 一次）
- [ ] trace-stats：`let me`≈0、`we` 占优、阶段回复=1（英文轨迹）
- [ ] 首轮无中断：首个 step 必须产出工具调用或可见文本（minimal 短思维链
  不应撞 1024 预算）
- [ ] 无任何「工具包装」式抽象（PTC 教训）：全程只做目录收窄/放行、
  预算覆盖/剥离、消息过滤/放行，无 run_code 类包装层

## 5. 演进记录（为什么没有 router）

曾实现 router-standard 的任务路由（spec/react/weak 三带 persona 选择）：
- 实测失败：分类器在 assemble 时机读不到首条用户消息（`user/message` 事件
  在 `agent/pre-step` 瀑布之后才持久化，而 `system-prompt/assemble` 在其
  之前执行，见 agent-loop `preStep()`），首轮永远落 weak 长文本 persona
- weak persona 的「先分类再行动」指令诱导 reasoning 膨胀（实测首轮 61 块
  1816 字符），撞破 1024 预算 → 首轮无任何输出/工具（「中断」）
- 移除 router，回归 anchored-standard 架构：persona 行恢复 minimal 句 +
  `complete: true`，首轮无条件进入实测最佳思维链
