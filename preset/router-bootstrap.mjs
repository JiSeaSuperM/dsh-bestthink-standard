/**
 * router-bootstrap: task-aware reasoning-mode router with a continuous
 * react↔spec axis.
 *
 * Ported from `yjh051108/dsh-router-standard` (MIT) — see NOTICE. Original
 * comments and behavior are preserved; this port fixes and extends:
 *   - FIX: `extractText` was called but not imported upstream (ReferenceError
 *     on every real weak-mode user message) — now imported from router-core.
 *   - FIX: promotion now uses the shared `promotionSignal()` from
 *     tool-bootstrap.mjs with the SAME `promoteOn` config, so the router and
 *     the anchor never disagree (upstream router only watched `tool/call`).
 *   - CHANGE: after promotion the assembled `contexts` are KEPT (upstream
 *     cleared them forever) — the promoted phase is the full Standard
 *     experience, workspace context restored. Only the bootstrap phase
 *     clears them.
 *   - ADD: `dev_trajectory_status` (phase + anchor state) and
 *     `dev_anchor_mode` (anchor override, shared with tool-bootstrap).
 *
 * Reads the session's first user message, classifies the task into a
 * continuous mode in [0,1] (0 = spec plan-first, 1 = react doer), and on the
 * first model request injects the matching persona and first-turn core tool
 * set. After the first durable promotion signal the full preset catalog is
 * exposed and nothing is touched again; the mode derives from durable session
 * events, so resume/reload keeps it.
 *
 * The agent can read and tune its own routing through `dev_router_status` and
 * `dev_router_mode` (self-optimization loop) — mode accepts band names
 * (spec/spec-lean/balanced/react-lean/react), 0-100 numbers, or 0.0-1.0.
 *
 * Zero external imports on purpose: relative preset rows resolve bare
 * specifiers from the user home, where `@deepseek-ai/*` is not installed.
 * The router tools therefore inline a minimal schema compiler instead of
 * importing `defineTool` from `@deepseek-ai/dsh-tools`.
 */

import {
  applyPersona, bandFor, coreFor, parseMode, personaFor, sessionMode, testinessFor, clamp01,
  isComplexTask, extractText,
} from './router-core.mjs'
import { promotionSignal, setAnchorOverride, clearAnchorOverride } from './tool-bootstrap.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bestthink-router-bootstrap'

/** Prompt assembly, the tools registry, and the LLM route must exist. */
export const inject = ['systemPrompt', 'tools', 'llm']

/** Minimal spec → JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx, config) {
  const overrides = new Map() // session id -> explicit mode (number 0..1)
  const agents = new Map() // session id -> Agent (live handle, in-process only)
  const promoteOn = config.promoteOn ?? 'either'
  const extras = {
    extraReactKeywords: config.extraReactKeywords ?? [],
    extraSpecKeywords: config.extraSpecKeywords ?? [],
  }
  // Preset-level default mode: 'auto' (or unset) classifies per task; a fixed
  // value (spec / weak / mixed / react / 0-100) pins every session to it.
  const configMode = config.mode === undefined || config.mode === 'auto' ? null : parseMode(config.mode)

  const sessionModeFor = (session) => overrides.get(session.id) ?? configMode ?? sessionMode(session, extras)

  const hasPromotionSignal = (session) => promotionSignal(session.events, promoteOn)

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)

    const mode = sessionModeFor(session)
    const modelId = agent.options?.model
    const persona = personaFor(mode, modelId)

    // The persona stays constant for the whole session (mode is fixed); only
    // the tool surface changes once, after the first durable promotion signal.
    const sections = applyPersona(assembled.sections, persona)

    if (hasPromotionSignal(session)) {
      // Promoted: full catalog and full contexts — only the persona section
      // differs from the un-bootstrapped Standard assembly.
      return { ...assembled, sections }
    }

    const core = new Set(coreFor(mode))
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      throw new Error(`${name}: no platform shell in catalog`)
    }
    core.add(shell)

    return {
      ...assembled,
      sections,
      contexts: [], // bootstrap phase: no dynamic contexts (time/workspace/...)
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })

  // ── near-field routing guidance for weak mode (P14/P16/P17/P19/P20) ─────
  // Every REAL user message in a weak-mode session gets ONE fixed guidance
  // message appended to the inbox right after it (near field, cache-neutral).
  // v19: depth-adaptive — SIMPLE tasks get the fast-convergence guide;
  // COMPLEX tasks get the deep-exploration guide (depth-first, information-
  // driven stop signal). The persona carries no hard converge anchor
  // (P27: information-driven convergence beats step-driven; user feedback:
  // flash was over-confident / too shallow on complex tasks).
  const GUIDE_WEAK =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
  const GUIDE_DEEP =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const data = event.data ?? {}
    if (data.source?.kind !== 'user') return // only real user messages
    const agent = ctx.get('agent')
    const target = agent !== undefined && agent.session === session ? agent : [...agents.values()].find((a) => a.session === session)
    if (target === undefined || target.inbox === undefined) return
    const mode = sessionModeFor(session)
    if (bandOf(mode) !== 'weak') return // strong modes need no guidance
    const text = extractText(data)
    if (!text.trim()) return
    const guide = isComplexTask(text) ? GUIDE_DEEP : GUIDE_WEAK
    try {
      target.inbox.append('next-step', {
        id: `router-guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'bestthink-router-bootstrap' },
        content: [{ type: 'text', text: guide }],
      })
    } catch { /* duplicate/ordering races: skip */ }
  })

  // ── router visibility & tuning (agent self-optimization) ────────────────
  const registerTool = (tool) => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
      // output.schema is already a plain JSON Schema; keep it as-is
    }))
  }

  const modeSpec = {
    mode: {
      type: 'string',
      required: true,
      description: 'band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override',
    },
  }

  function fmtMode(mode) {
    return typeof mode === 'string' ? mode : mode.toFixed(2)
  }

  registerTool({
    name: 'dev_router_status',
    description: 'Show this session\'s reasoning-mode routing: mode, band, persona, first-turn core tools, test-suppression, and whether an override is active.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const mode = sessionModeFor(session)
      const modelId = currentAgent()?.options?.model
      return [
        `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
        `persona=${personaFor(mode, modelId).replace(/\n/g, ' / ')}`,
        `core=[${coreFor(mode).join(', ')}]`,
        `testiness=${testinessFor(mode)}`,
        `override=${overrides.has(session.id) ? 'yes' : 'no'}`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'dev_router_mode',
    description: 'Set this session\'s reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, or 0.0-1.0; use auto to return to task classification. The next request applies it.',
    parameters: modeSpec,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      if (parsed === 'auto') overrides.delete(session.id)
      else overrides.set(session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
      const current = sessionModeFor(session)
      return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
    },
  })

  // ── trajectory/anchoring visibility (BTS addition) ───────────────────────
  const ANCHOR_MODES = ['either', 'tool-call', 'assistant-message', 'off', 'auto']

  registerTool({
    name: 'dev_trajectory_status',
    description: 'Show this session\'s BestThink trajectory phase: bootstrap (narrow first-request tool surface + 1024 maxTokens + injected-context strip active) or promoted (full Standard catalog, full budget, contexts restored), plus the current anchor configuration.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const promoted = hasPromotionSignal(session)
      const configBootstrapTools = (config.shellTools?.length ?? 0) + (config.commonTools?.length ?? 0)
      return [
        `phase=${promoted ? 'promoted' : 'bootstrap'}`,
        `promoteOn=${promoteOn}`,
        `bootstrapTools=${configBootstrapTools} (shell+common, first request)`,
        `bootstrapMaxTokens=${config.bootstrapMaxTokens ?? 1024}`,
        `contextStrip=${promoted ? 'released' : `active (${JSON.stringify(config.suppressedContextSources ?? ['skill-catalog', 'agent-instructions'])})`}`,
        'cacheChanges=n/a (phase reported only; request-cache observability is not exposed by rc.5)',
      ].join('\n')
    },
  })

  registerTool({
    name: 'dev_anchor_mode',
    description: 'Set this session\'s bootstrap anchor mode: either (default; first tool call OR first assistant message promotes) / tool-call / assistant-message / off (disable the bootstrap phase, full catalog immediately) / auto (clear the override, back to the composition config). The next request applies it.',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        description: 'either / tool-call / assistant-message / off / auto',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const mode = String(args.mode ?? '').trim().toLowerCase()
      if (!ANCHOR_MODES.includes(mode)) return `invalid anchor mode "${args.mode}": use either / tool-call / assistant-message / off / auto`
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      if (mode === 'auto') clearAnchorOverride(session.id)
      else setAnchorOverride(session.id, mode)
      return `anchorMode=${mode} — next request applies`
    },
  })

  // ── mode-isolated subagent: run a task in a DIFFERENT reasoning mode,
  //    without touching this session's trajectory (P6 showed tail persona
  //    is ineffective; DSH's native subagent inherits this persona, so the
  //    only working isolation is a fresh LLM call with its own system). ──
  registerTool({
    name: 'dev_mode_subagent',
    description: 'Run one task in a DIFFERENT reasoning mode than this session, in a fresh isolated context (own system prompt). The current session trajectory is untouched. Mode: spec (plan-first) / weak (internal routing) / react (doer) / balanced. Returns the subagent\'s answer text.',
    parameters: {
      mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
      task: { type: 'string', required: true, description: 'the task to hand to the mode-isolated subagent' },
      maxTokens: { type: 'number', description: 'output cap (default 1024)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
      const session = currentSession()
      const agent = session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
      if (agent === undefined || agent.options === undefined) return 'no agent route available'
      const { provider, model } = agent.options
      if (!provider || !model) return 'agent route missing provider/model'

      const persona = personaFor(parsed, model)
      const maxTokens = Number(args.maxTokens || 1024)
      let text = ''
      let reasoningChars = 0
      try {
        const stream = ctx.llm.stream({
          provider,
          model,
          system: persona,
          messages: [{ role: 'user', content: [{ type: 'text', text: String(args.task) }] }],
          maxTokens,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        }
      } catch (error) {
        return `subagent error: ${error && error.message ? error.message : String(error)}`
      }
      const head = text.slice(0, 3000)
      return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
    },
  })

  function currentSession() {
    const agent = ctx.get('agent')
    if (agent !== undefined && agent.session !== undefined) return agent.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function currentAgent() {
    const session = currentSession()
    return session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
  }
}
