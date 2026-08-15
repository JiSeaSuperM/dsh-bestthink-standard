/**
 * BestThink tool bootstrap — keep the FIRST model request on a small tool
 * surface and a small output budget, then expose the full preset catalog (and
 * the normal output budget) once the session has produced its first durable
 * promotion signal.
 *
 * Ported from `xiaobright/dsh-anchored-standard` (MIT) — see NOTICE. The
 * original comments, logic, and configuration names are preserved so upstream
 * diffs stay readable; this port adds:
 *   - `suppressedContextSources` (configurable strip list, empty = disabled)
 *   - `bootstrapFlashMaxTokens` (model-adaptive first-request budget:
 *     Flash-family models get a larger cap, default 4096, because their
 *     reasoning at the same effort runs visibly longer than Pro's and the
 *     measured 1024 anchor left complex first tasks empty — see
 *     `DEFAULT_BOOTSTRAP_FLASH_MAX_TOKENS`)
 *   - `firstTurnGuideText` (one-shot near-field quick-action guide for
 *     Flash-family models: compress the first wave of thinking instead of
 *     widening the budget forever; system prompt untouched, stops after
 *     promotion — see `DEFAULT_FIRST_TURN_GUIDE`)
 *   - shared `promotionSignal()` / anchor-override exports (kept for tooling
 *     and tests).
 *
 * The phase is derived from durable session events, so resume and reload
 * preserve it. By default (`promoteOn: 'either'`) a session promotes after the
 * first `tool/call` OR the first `assistant/message`, whichever comes first:
 * request #1 always sees the bootstrap catalog and request #2 always sees the
 * full catalog. The original `'tool-call'` mode is kept for compatibility, but
 * it can trap a session in bootstrap forever when the first model reply makes
 * no tool call — the `'either'` default removes that trap while keeping the
 * first-request anchor intact.
 *
 * Two additional first-request conditions found during the 2026-08-15
 * reproduction work (issue #6):
 *
 *  1. Output budget. On the official endpoint the first request's
 *     `max_tokens` dominates the trajectory anchor: 1024 reproduced the
 *     `We need` style in 26/32 runs against 0/5 at the adapter default of
 *     256000, independent of tool descriptions. Bootstrap therefore caps the
 *     first request at `bootstrapMaxTokens` (default 1024) and strips the cap
 *     after promotion — the next request's seed proposal carries the previous
 *     header's maxTokens forward, so the release must be explicit.
 *
 *  2. Injected reminders. dsh-agent-instructions and dsh-tool-skill inject
 *     workspace instructions (AGENTS.md) and the skill catalog into the first
 *     step as user messages whenever such content exists. With the skill
 *     catalog present the anchor did not reproduce at all (0/9); without it
 *     the same request reproduces at ~81%. Both message kinds are therefore
 *     stripped during bootstrap and allowed again after promotion.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process; the
 *    durable event scan runs once per session per process, then O(1).
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of throwing, so a composition drift can never brick
 *    every request of a session.
 *  - Invalid config (bad tool lists, unknown `promoteOn`) fails at apply
 *    time, i.e. at preset mount, where it is visible and fixable.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bestthink-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Applying without an inject — combined with this row being FIRST in
 * agent.cordis.yml — registers the plugin before dsh-agent-instructions and
 * dsh-tool-skill, and waterfall after-next transforms apply in reverse
 * registration order, so the first-request strip below is the LAST transform.
 * With an inject here those plugins register first and re-inject their
 * messages after the strip.
 */
export const inject = []

const DEFAULT_BOOTSTRAP_MAX_TOKENS = 1024

/**
 * Bootstrap budget for Flash-family models. The measured 1024 anchor value
 * comes from v4-pro (Project2: "We need" trajectory in 26/32 runs). Flash
 * reasoning is visibly longer at the same reasoning_effort: a complex first
 * task produced 1852 chars (~1200+ tokens) of reasoning and exceeded 1024,
 * so the first step ended empty (interruption). Flash gets a larger budget
 * by default; the value stays configurable.
 */
const DEFAULT_BOOTSTRAP_FLASH_MAX_TOKENS = 4096

/**
 * One-shot first-turn quick-action guide for Flash-family models. The FIRST
 * wave of thinking is the only one under the bootstrap budget; flash
 * reasoning at 'max' effort can exceed it on complex tasks (measured
 * interruption). Instead of widening the budget forever, this fixed
 * near-field user message (the measured strongest guidance position) guides
 * that first wave to act quickly; detailed reasoning is deferred to later
 * steps, which run at the session's own unlimited budget. The system prompt
 * is never touched, so the minimal anchor stays byte-exact.
 */
const DEFAULT_FIRST_TURN_GUIDE =
  'First turn: act now — call a tool (read a file or run a command) rather than planning at length. Detailed reasoning can come in later steps.'

/** True when the routed model id is a Flash-family model. */
function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Default message source kinds stripped from first-step injection. */
const DEFAULT_SUPPRESSED_CONTEXT_SOURCES = ['skill-catalog', 'agent-instructions']

/**
 * Pure promotion signal check (shared export; the task-router plugin that
 * consumed it was removed — the anchor is the only phase authority now).
 * @param events - durable session events (each with a `type`).
 * @param promoteOn - 'tool-call' | 'assistant-message' | 'either' | 'off'.
 *   'off' disables the bootstrap phase entirely (always promoted).
 */
export function promotionSignal(events, promoteOn) {
  if (promoteOn === 'off') return true
  const kinds = PROMOTE_EVENTS[promoteOn ?? 'either'] ?? PROMOTE_EVENTS.either
  return Array.isArray(events) && events.some((event) => kinds.includes(event.type))
}

/** Anchor-mode overrides per session id ('off' or one of the promoteOn names). */
const anchorOverrides = new Map()

/** Set a per-session anchor override; 'off' disables the bootstrap phase. */
export function setAnchorOverride(sessionId, mode) {
  anchorOverrides.set(sessionId, mode)
}

/** Clear a per-session anchor override (back to the composition config). */
export function clearAnchorOverride(sessionId) {
  anchorOverrides.delete(sessionId)
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListAllowEmpty(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings (may be empty)`)
  }
  return [...new Set(value)]
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return 'either'
  if (value === 'tool-call' || value === 'assistant-message') return value
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

function positiveInt(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const commonTools = stringList(config.commonTools, 'commonTools')
  const shellTools = stringList(config.shellTools, 'shellTools')
  const promoteOn = parsePromoteOn(config.promoteOn)
  const bootstrapMaxTokens = positiveInt(config.bootstrapMaxTokens, 'bootstrapMaxTokens', DEFAULT_BOOTSTRAP_MAX_TOKENS)
  const bootstrapFlashMaxTokens = positiveInt(
    config.bootstrapFlashMaxTokens, 'bootstrapFlashMaxTokens', DEFAULT_BOOTSTRAP_FLASH_MAX_TOKENS,
  )
  const bootstrapBudgets = new Set([bootstrapMaxTokens, bootstrapFlashMaxTokens])
  const suppressedContextSources = new Set(
    stringListAllowEmpty(config.suppressedContextSources ?? DEFAULT_SUPPRESSED_CONTEXT_SOURCES, 'suppressedContextSources'),
  )
  // '' disables the first-turn guide; a custom string replaces the default.
  const firstTurnGuide = config.firstTurnGuideText === undefined
    ? DEFAULT_FIRST_TURN_GUIDE
    : String(config.firstTurnGuideText)
  const guideInjected = new Set() // session ids that already got the one-shot guide

  /** Sessions already promoted in this process. Promotion is append-only, so a Set is sound. */
  const promoted = new Set()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Whether the session has reached the promoted phase.
   * @param agent - the assembly context's agent, or undefined outside an agent.
   */
  const isPromoted = (agent) => {
    if (agent === undefined) return true
    const session = agent.session
    if (session === undefined) return true
    if (promoted.has(session.id)) return true
    const mode = anchorOverrides.get(session.id) ?? promoteOn
    const hit = promotionSignal(session.events, mode)
    // A real promotion signal is append-only and memoized; the temporary
    // 'off' override must NOT be memoized, or clearing it could not restore
    // the bootstrap phase for a session that never actually promoted.
    if (hit && mode !== 'off') promoted.add(session.id)
    return hit
  }

  /** Narrow the assembled catalog to one platform shell plus the common tools. */
  const applyBootstrap = (assembled) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const selectedShells = shellTools.filter((toolName) => available.has(toolName))
    const missingCommon = commonTools.filter((toolName) => !available.has(toolName))
    if (selectedShells.length !== 1 || missingCommon.length > 0) {
      warnOnce(
        `${name}: expected exactly one bootstrap shell and every common tool; `
        + `shells=${JSON.stringify(selectedShells)}, missing=${JSON.stringify(missingCommon)} — `
        + 'bootstrap disabled, full catalog exposed',
      )
      return assembled
    }
    const bootstrap = new Set([...selectedShells, ...commonTools])
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => bootstrap.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      if (isPromoted(context.agent)) return assembled
      return applyBootstrap(assembled)
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  /** The bootstrap output budget for the agent's model (Flash gets more). */
  const budgetFor = (agent) => (isFlashModel(agent?.options?.model) ? bootstrapFlashMaxTokens : bootstrapMaxTokens)

  // Cap the first model request's output budget while bootstrapping.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload.agent
    if (isPromoted(agent)) {
      // The next request's seed proposal carries the previous header's
      // maxTokens forward, so the injected cap must be stripped explicitly —
      // otherwise it would persist for the whole session.
      if (bootstrapBudgets.has(resolved.maxTokens)) {
        const { maxTokens: _bootstrap, ...rest } = resolved
        return rest
      }
      return resolved
    }
    return {
      ...resolved,
      maxTokens: budgetFor(agent),
    }
  })

  // Strip first-step injected reminders (skill catalog, AGENTS.md) during
  // bootstrap. Because this listener is the first registered (see the inject
  // note and the row order in agent.cordis.yml), the strip is the final
  // waterfall transform and actually removes what later listeners inject.
  // Also injects a one-shot first-turn quick-action guide for Flash-family
  // models: the FIRST wave of thinking is the only one under the bootstrap
  // budget, and flash reasoning at 'max' effort can exceed it on complex
  // tasks (measured interruption). Instead of widening the budget forever we
  // guide that first wave to act quickly. The guide is a fixed near-field
  // user message (the measured strongest guidance position), never a system
  // change — the minimal anchor stays byte-exact — and stops automatically
  // after promotion. `firstTurnGuideText: ''` disables it; a custom string
  // replaces the default.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const agent = payload.agent
    if (isPromoted(agent)) return decision
    let messages = decision.messages
    if (suppressedContextSources.size > 0) {
      messages = messages.filter((message) => !suppressedContextSources.has(message.source?.kind))
    }
    if (firstTurnGuide !== '' && isFlashModel(agent?.options?.model)) {
      const sessionId = agent?.session?.id
      if (sessionId !== undefined && !guideInjected.has(sessionId)) {
        guideInjected.add(sessionId)
        messages = [...messages, {
          role: 'user',
          source: { kind: 'plugin', plugin: name },
          content: [{ type: 'text', text: firstTurnGuide }],
        }]
      }
    }
    if (messages === decision.messages) return decision
    return { ...decision, messages }
  })
}
