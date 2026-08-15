# dsh-bestthink-standard

**[English](README.md) | [中文](README.zh-CN.md)**

**Best-Thinking + Standard mode** — a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) agent preset that enters the *measured best-thinking trajectory* (the RL-aligned minimal condition) on the very first request, then auto-promotes to the **full Standard 25-tool catalog** with workspace context restored.

> Compatible baseline: DeepSeek Harness **0.1.0-rc.5 / commit 47f9438**.
> License: MIT (ported from `xiaobright/dsh-anchored-standard`; `agent.cordis.yml` derives from the official `standard` preset — see [`preset/NOTICE`](preset/NOTICE)).

---

## Why

A frontier reasoning model's behavior is strongly conditioned by the **first request's system prompt and visible tool catalog** — not by its raw capability. Measured on the Project2 maintenance benchmark (DeepSeek V4 Pro, `reasoning_effort=max`):

| Condition | Ability |
|---|---:|
| official `minimal` (1-sentence prompt, 2 tools) | **99 / 96** |
| **two-phase anchored** (minimal first, full catalog after first tool call) | **98 / 99** |
| official `standard` (full 25-tool catalog from the start) | 91 |

The first request commits the session to a trajectory; expanding the tool catalog *after* the first durable tool call perturbs at most one reasoning block and never flips the mode. So the anchor is free: you get the best-thinking first turn **and** the full Standard capability.

## How it works

Three anchoring factors lock the first request into the RL-aligned minimal form, **uniformly for every model** (no per-model special-casing — sessions that switch models mid-flight can never receive mismatched settings):

1. **Pristine system prompt** — the persona row is the minimal sentence with `complete: true` + `includeRuntimeContext: false`, so the assembled system prompt is *exactly* `You are a helpful software engineer assistant.` (harness identity, tool guidance, and plugin sections are all suppressed).
2. **Tight output budget** — the first request is capped at `maxTokens=1024` (the measured anchor value); the cap is explicitly stripped after promotion so it can never leak into later steps.
3. **Narrow tool surface + stripped injections** — the first request sees only `shell + read`; skill-catalog / AGENTS.md injected messages are filtered out during bootstrap and naturally return after promotion.

**First-turn quick-action guide** — the first wave of thinking is the *only* wave under the bootstrap budget, and a complex task's reasoning can blow past 1024 and end the first step empty. A fixed near-field user message (the strongest measured guidance position) is injected once on the first turn — *hard-forbidding* first-turn design reasoning — and stops automatically after promotion:

> *First turn: call exactly one tool NOW (read a file or run a command). Do NOT design, plan, or analyze in this turn — no architecture, no implementation details. All design and planning happens in later steps, after the tool result.*

**Promotion** — after the first durable `tool/call` or `assistant/message` (`promoteOn: either`), the full Standard catalog, the normal output budget, and the workspace context (AGENTS.md / skill catalog) all return. The system prompt never changes again (at most one prefix-cache miss).

No tool-wrapping abstractions (the official `code` preset's `run_code` layer measured *worse*: 92 vs 91-99, plus a new failure surface).

## Install

```powershell
# 1. copy the preset directory into your user preset root
Copy-Item -Recurse <repo>\preset $HOME\.dsh\.agent-presets\bestthink-standard

# 2. restart DeepSeek Harness (presets are scanned at startup)
# 3. start a NEW session and pick 「最佳思维链标准模式」 (the preset.yml name)
```

> The install directory name (`bestthink-standard`) is the preset id.

## Usage

- **First turn**: minimal best-thinking trajectory (1-sentence system, `shell + read`, 1024 budget, no injected context, one quick-action guide).
- **After promotion**: full Standard 25-tool catalog, normal budget, AGENTS.md / skill catalog restored.
- **No special prompts needed** — the minimal sentence is injected by the preset, not something you type.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `shellTools` | `[bash, pwsh]` | candidate platform shells |
| `commonTools` | `[read]` | first-turn core tool |
| `promoteOn` | `either` | `tool-call` / `assistant-message` / `either` |
| `bootstrapMaxTokens` | `1024` | first-request output budget (explicitly stripped after promotion) |
| `firstTurnGuideText` | built-in | first-turn quick-action guide (`''` disables; a custom string replaces the default) |
| `suppressedContextSources` | `[skill-catalog, agent-instructions]` | injected message kinds stripped during bootstrap (`[]` disables) |

## Verification

1. **Unit tests**: `node --test` (Node ≥ 18) — promotion modes, maxTokens cap/release, injection strip/release, guide one-shot behavior.
2. **Structure** (export a session JSONL): first `request/header` must show `maxTokens=1024`, ≤2 tools (`shell` + `read`), system = exactly the minimal sentence, and one `source.kind: plugin` guide message; after the first tool call the header must show the full catalog with no `1024` residue.
3. **Trajectory** (`node scripts/trace-stats.mjs <session.jsonl>`): English reasoning traces should show `we`-dominant, `let me` ≈ 0, and a single visible reply per turn (the minimal-trajectory fingerprint).

## Development history

- The first version included a task-router (spec/react/weak persona selection, ported from `dsh-router-standard`). It was removed after measurement: the classifier cannot see the first user message at assembly time (`user/message` events persist only after the `agent/pre-step` waterfall, while `system-prompt/assemble` runs before it), so first requests always fell into the weak persona whose long guidance text inflated first-turn reasoning past the 1024 budget — empty first steps. **Minimal is the optimum**: one unconditional anchor, no routing.
- The bootstrap budget was briefly made model-adaptive, then unified back to 1024: `agent.options.model` is snapshotted at session creation, so GUI model switching produces a stale snapshot; any per-model logic risks mismatched budgets/guides. One uniform setting is immune.

## License & acknowledgements

MIT. This project ports and composes:

- [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) (MIT) → `tool-bootstrap.mjs` mechanics and the minimal persona row
- [`yjh051108/dsh-router-standard`](https://github.com/yjh051108/dsh-router-standard) (MIT) → measurement methodology and the near-field guidance insight (no code retained)
- official DeepSeek Harness `standard` preset (rc.5 / 47f9438) → base composition

See [`preset/NOTICE`](preset/NOTICE) for full attribution. Project2 measurements come from [`xiaobright/modeltest`](https://github.com/xiaobright/modeltest) (V4.1b, frozen). Not affiliated with DeepSeek; measurements are environment-specific and not a general benchmark.
