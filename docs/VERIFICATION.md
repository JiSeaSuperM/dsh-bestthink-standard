# VERIFICATION — dsh-bestthink-standard

验证分三层：**单测（自动化）** → **结构验证（JSONL 检查点，安装后人工）** →
**轨迹验证（trace-stats 指纹）**。

---

## 1. 单测（自动化，必须全绿）

```powershell
cd D:\software\jzpProject\dsh-bestthink-standard
node --test          # 或 npm test
```

覆盖（68 例）：
- 分类器：build/create → react；fix/debug/为什么 → spec；空/混合/未命中 → weak；
  `extraReactKeywords` / `extraSpecKeywords` 扩展生效且正则特殊字符被转义
- 带宽映射：0→spec、0.3→transition(mixed)、1→react；parseMode 全格式
  （band 名 / 0-100 / 0.0-1.0 / auto）
- persona：spec 句与官方 minimal 字节一致；react doer 句；weak 按模型分版
  （pro：spec 句 + classify；flash：neutral + classify + 回顾/防跑题锚）
- 晋升判定三模式：promoteOn `tool-call` / `assistant-message` / `either`；
  共享 `promotionSignal` 使 router 与 anchor 永不分歧；临时 `off` override 可逆
- maxTokens：首轮 cap 1024；晋升后**显式剥离**（seed proposal 继承上一请求
  cap，不剥离则泄漏全程）；非 bootstrap cap 的其它 maxTokens 保留
- 注入剥离：只作用于未晋升阶段；`suppressedContextSources` 可配置/可禁用；
  skill-invocation 手势与 plugin 消息保留；晋升后 skill-catalog /
  agent-instructions 自然放行；reject 决策原样透传
- applyPersona：只替换 persona section，plan-mode section 存活
- router-bootstrap 插件级：首轮收窄（spec read-first / react write-first +
  shell、contexts 清空）、晋升后全量目录 + contexts 恢复、config.mode 固定
  模式、weak 模式近距离引导（简单/复杂分版、plugin 消息不触发、强模式不触发）、
  dev_trajectory_status / dev_anchor_mode 执行
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
- 该请求的 pre-step 消息里**没有** `source.kind ∈ {skill-catalog,
  agent-instructions}` 的消息（AGENTS.md / 技能目录已被剥离）
- system prompt 只含 router-persona section（spec/react/weak 之一），
  **无** persona 之外的动态变化；plan-mode section 存在

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
| `we` | 占优 | 集体式规划轨迹 |
| 阶段回复（visible replies） | = 1 | 每轮只有最终一条可见总结 |
| reasoning p50 | 记录即可 | 与 baseline（官方 standard）对比 |
| 首/末 header | 1024+tools≤3 → 无1024+tools 全量 | 结构证明锚定与晋升 |

## 4. 验收清单

- [ ] `node --test` 全绿（68 例）
- [ ] 检查点 A：首份 header maxTokens=1024、工具 ≤3、无注入消息
- [ ] 检查点 B：晋升后工具全量、无 1024 残留、注入恢复
- [ ] 检查点 C：system 文本全程不变（缓存只 miss 一次）
- [ ] trace-stats：`let me`≈0、`we` 占优、阶段回复=1
- [ ] dev 工具可用：`dev_trajectory_status` 报告
  `phase=bootstrap|promoted`；`dev_router_status` / `dev_router_mode` /
  `dev_anchor_mode` / `dev_mode_subagent` 正常
- [ ] 无任何「工具包装」式抽象（PTC 教训）：全程只做目录收窄/放行、
  预算覆盖/剥离、消息过滤/放行，无 run_code 类包装层
