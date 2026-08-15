import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name, promotionSignal, setAnchorOverride, clearAnchorOverride } from '../preset/tool-bootstrap.mjs'

const config = {
  commonTools: ['read'],
  shellTools: ['bash', 'pwsh'],
  // The default one-shot guide is exercised by its own tests below; the
  // strip/promotion tests here disable it so they assert exactly the
  // context-filter contract.
  firstTurnGuideText: '',
}

function register(cfg = config) {
  const listeners = {}
  const hookOptions = {}
  const warns = []
  const ctx = {
    on(event, callback, options) {
      listeners[event] = callback
      hookOptions[event] = options
    },
    logger: {
      warn(message) {
        warns.push(message)
      },
    },
  }
  apply(ctx, cfg)
  return { listeners, hookOptions, warns }
}

const agent = (events, id = 's') => ({ session: { id, events } })

function assemble(listener, events, tools, id = 's') {
  return listener(undefined, { agent: agent(events, id) }, async () => ({ system: 'minimal persona', tools }))
}

function request(listener, events, resolved, id = 's') {
  return listener({ agent: agent(events, id), turn: 1, step: 1 }, async () => resolved)
}

function prestep(listener, events, messages, id = 's') {
  return listener({ agent: agent(events, id), turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
}

const userMessage = { id: 'u', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
const instructionMessage = { id: 'i', content: [], source: { kind: 'agent-instructions' } }
const catalogMessage = { id: 'c', content: [], source: { kind: 'skill-catalog' } }
const gestureMessage = { id: 'g', content: [], source: { kind: 'skill-invocation' } }
const pluginMessage = { id: 'p', content: [], source: { kind: 'plugin' } }

// ── first-turn quick-action guide (all models, one-shot) ────────────────────

test('default guide is injected once for every model during bootstrap', async () => {
  const { listeners } = register({ ...config, firstTurnGuideText: undefined })
  for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
    const decision = await prestep(listeners['agent/pre-step'], [], [userMessage], 's-' + model)
    const guides = decision.messages.filter((message) => message.source?.kind === 'plugin' && message.source?.plugin === name)
    assert.equal(guides.length, 1, `${model}: one guide`)
    assert.ok(guides[0].content[0].text.includes('call exactly one tool NOW'), `${model}: hard-action default text`)
  }
})

test('guide is injected exactly once per session', async () => {
  const { listeners } = register({ ...config, firstTurnGuideText: undefined })
  const first = await prestep(listeners['agent/pre-step'], [], [userMessage], 'once')
  const second = await prestep(listeners['agent/pre-step'], [], [userMessage], 'once')
  const guides = (m) => m.messages.filter((message) => message.source?.kind === 'plugin' && message.source?.plugin === name).length
  assert.equal(guides(first), 1, 'injected on the first bootstrap step')
  assert.equal(guides(second), 0, 'no duplicate on a later bootstrap step (the first guide already sits in the session context)')
})

test('guide stops after promotion and never touches the system prompt', async () => {
  const { listeners } = register({ ...config, firstTurnGuideText: undefined })
  const decision = await prestep(listeners['agent/pre-step'], [{ type: 'tool/call' }], [userMessage])
  assert.ok(!decision.messages.some((message) => message.source?.kind === 'plugin' && message.source?.plugin === name))
})

test('custom guide text replaces the default; empty string disables', async () => {
  const custom = register({ ...config, firstTurnGuideText: '直接干！' })
  const customDecision = await prestep(custom.listeners['agent/pre-step'], [], [userMessage], 'custom')
  const customGuide = customDecision.messages.find((message) => message.source?.kind === 'plugin' && message.source?.plugin === name)
  assert.equal(customGuide.content[0].text, '直接干！')
  const disabled = register({ ...config, firstTurnGuideText: '' })
  const disabledDecision = await prestep(disabled.listeners['agent/pre-step'], [], [userMessage], 'disabled')
  assert.ok(!disabledDecision.messages.some((message) => message.source?.kind === 'plugin' && message.source?.plugin === name))
})

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'bestthink-tool-bootstrap')
})

test('first request exposes one platform shell and read', async () => {
  const { listeners } = register()
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'edit' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['pwsh', 'read'])
})

test('a durable tool call promotes the complete catalog', async () => {
  const { listeners } = register()
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'edit' }, { name: 'grep' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call', data: { name: 'read' } }], tools)
  assert.deepEqual(result.tools, tools)
})

test('a first assistant message promotes the complete catalog (no tool call needed)', async () => {
  const { listeners } = register()
  const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message', data: {} }], tools)
  assert.deepEqual(result.tools, tools)
})

test('sessions derive promotion independently from their own events', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const promoted = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, 'a')
  const fresh = await assemble(listeners['system-prompt/assemble'], [], tools, 'b')
  assert.deepEqual(promoted.tools, tools)
  assert.deepEqual(fresh.tools.map((tool) => tool.name), ['bash', 'read'])
})

test('promotion is memoized per session id within one process', async () => {
  const { listeners } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const first = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, 'memo')
  assert.deepEqual(first.tools, tools)
  // Same session id, events now empty: the cached decision still promotes.
  const second = await assemble(listeners['system-prompt/assemble'], [], tools, 'memo')
  assert.deepEqual(second.tools, tools)
})

test('promoteOn tool-call requires a tool call, not just a reply', async () => {
  const { listeners } = register({ ...config, promoteOn: 'tool-call' })
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const replyOnly = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, 'a')
  assert.deepEqual(replyOnly.tools.map((tool) => tool.name), ['bash', 'read'])
  const withCall = await assemble(listeners['system-prompt/assemble'], [{ type: 'tool/call' }], tools, 'b')
  assert.deepEqual(withCall.tools, tools)
})

test('promoteOn assistant-message promotes after any first reply', async () => {
  const { listeners } = register({ ...config, promoteOn: 'assistant-message' })
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const result = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, 'a')
  assert.deepEqual(result.tools, tools)
})

test('a missing bootstrap shell degrades gracefully to the full catalog', async () => {
  const { listeners, warns } = register()
  const tools = [{ name: 'read' }, { name: 'edit' }]
  const result = await assemble(listeners['system-prompt/assemble'], [], tools)
  assert.deepEqual(result.tools, tools)
  assert.ok(warns.length >= 1)
})

test('invalid promoteOn values fail at apply time', () => {
  assert.throws(() => register({ ...config, promoteOn: 'bogus' }), /promoteOn/)
})

test('invalid bootstrapMaxTokens fails at apply time', () => {
  assert.throws(() => register({ ...config, bootstrapMaxTokens: 0 }), /bootstrapMaxTokens/)
})

test('first request is capped to bootstrapMaxTokens', async () => {
  const { listeners } = register({ ...config, bootstrapMaxTokens: 1024 })
  const resolved = await request(listeners['agent/request'], [], { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(resolved.maxTokens, 1024)
  assert.equal(resolved.provider, 'deepseek-official')
})

test('after promotion, the injected cap is stripped so the default returns', async () => {
  const { listeners } = register({ ...config, bootstrapMaxTokens: 1024 })
  const resolved = await request(listeners['agent/request'], [{ type: 'tool/call' }], { provider: 'x', model: 'y', maxTokens: 1024 })
  assert.equal(resolved.maxTokens, undefined)
})

test('after promotion, a different maxTokens is preserved', async () => {
  const { listeners } = register({ ...config, bootstrapMaxTokens: 1024 })
  const resolved = await request(listeners['agent/request'], [{ type: 'tool/call' }], { provider: 'x', model: 'y', maxTokens: 256000 })
  assert.equal(resolved.maxTokens, 256000)
})

test('the pre-step strip keeps the default registration (no prepend): the FIRST row position in agent.cordis.yml is what makes it the last waterfall transform', () => {
  const { hookOptions } = register()
  // The strip relies on registration order (row 1 + empty inject list), not
  // on a prepend option: with prepend it would run BEFORE the injectors and
  // could not remove what they add. Assert the option is absent so a future
  // edit cannot silently break the ordering contract.
  assert.equal(hookOptions['agent/pre-step'], undefined)
})

test('bootstrap pre-step strips skill-catalog and agent-instructions messages', async () => {
  const { listeners } = register()
  const messages = [
    { id: 'm1', content: [{ type: 'text', text: 'user message' }] },
    { id: 'm2', content: [{ type: 'text', text: '<system-reminder>skills...</system-reminder>' }], source: { kind: 'skill-catalog' } },
    { id: 'm3', content: [{ type: 'text', text: '# AGENTS.md content' }], source: { kind: 'agent-instructions' } },
  ]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages.map((message) => message.id), ['m1'])
})

test('bootstrap strip preserves user skill gestures and other plugin messages', async () => {
  const { listeners } = register()
  const decision = await prestep(listeners['agent/pre-step'], [], [
    userMessage,
    instructionMessage,
    catalogMessage,
    gestureMessage,
    pluginMessage,
  ])
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages.map((message) => message.id), ['u', 'g', 'p'])
})

test('promoted pre-step keeps every injected context message', async () => {
  const { listeners } = register()
  const messages = [userMessage, instructionMessage, catalogMessage, pluginMessage]
  const decision = await prestep(listeners['agent/pre-step'], [{ type: 'tool/call' }], messages)
  assert.equal(decision.messages, messages)
})

test('a text-only first reply promotes the context injections too', async () => {
  const { listeners } = register()
  const stripped = await prestep(listeners['agent/pre-step'], [], [userMessage, instructionMessage, catalogMessage])
  assert.deepEqual(stripped.messages.map((message) => message.id), ['u'])
  const kept = await prestep(listeners['agent/pre-step'], [{ type: 'assistant/message' }], [userMessage, instructionMessage])
  assert.deepEqual(kept.messages.map((message) => message.id), ['u', 'i'])
})

test('reject decisions pass through the context filter untouched', async () => {
  const { listeners } = register()
  const decision = { kind: 'reject', messages: [userMessage, instructionMessage] }
  const result = await listeners['agent/pre-step'](
    { agent: agent([]), turn: 1, step: 1 },
    async () => decision,
  )
  assert.equal(result, decision)
})

test('suppressedContextSources is configurable', async () => {
  const { listeners } = register({ ...config, suppressedContextSources: ['skill-invocation'] })
  const decision = await prestep(listeners['agent/pre-step'], [], [userMessage, instructionMessage, catalogMessage, gestureMessage])
  assert.deepEqual(decision.messages.map((message) => message.id), ['u', 'i', 'c'])
})

test('an empty suppressedContextSources disables the context filter', async () => {
  const { listeners } = register({ ...config, suppressedContextSources: [] })
  const messages = [userMessage, instructionMessage, catalogMessage]
  const decision = await prestep(listeners['agent/pre-step'], [], messages)
  assert.equal(decision.messages, messages)
})

test('invalid suppressedContextSources values fail at apply time', () => {
  assert.throws(() => register({ ...config, suppressedContextSources: 'agent-instructions' }), /suppressedContextSources/)
  assert.throws(() => register({ ...config, suppressedContextSources: ['agent-instructions', 42] }), /suppressedContextSources/)
})

// ── promotionSignal: the shared pure signal (also used by router-bootstrap) ─

test('promotionSignal: either promotes on tool/call or assistant/message', () => {
  assert.equal(promotionSignal([], 'either'), false)
  assert.equal(promotionSignal([{ type: 'tool/call' }], 'either'), true)
  assert.equal(promotionSignal([{ type: 'assistant/message' }], 'either'), true)
  assert.equal(promotionSignal([{ type: 'user/message' }], 'either'), false)
})

test('promotionSignal: per-mode events and default', () => {
  assert.equal(promotionSignal([{ type: 'assistant/message' }], 'tool-call'), false)
  assert.equal(promotionSignal([{ type: 'tool/call' }], 'assistant-message'), false)
  assert.equal(promotionSignal([{ type: 'tool/call' }], 'tool-call'), true)
  assert.equal(promotionSignal([{ type: 'assistant/message' }], 'assistant-message'), true)
  assert.equal(promotionSignal([{ type: 'tool/call' }], undefined), true) // default either
})

test('promotionSignal: off disables the bootstrap phase entirely', () => {
  assert.equal(promotionSignal([], 'off'), true)
  assert.equal(promotionSignal([{ type: 'user/message' }], 'off'), true)
})

test('anchor overrides: off promotes immediately, auto restores the config', async () => {
  const { listeners } = register({ ...config, promoteOn: 'tool-call' })
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  // configured tool-call: an assistant-message-only session stays bootstrap
  const before = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, 'ov')
  assert.deepEqual(before.tools.map((tool) => tool.name), ['bash', 'read'])
  // override off → promoted immediately
  setAnchorOverride('ov', 'off')
  const during = await assemble(listeners['system-prompt/assemble'], [], tools, 'ov')
  assert.deepEqual(during.tools, tools)
  // clear override → back to config (session has no tool/call, so bootstrap)
  clearAnchorOverride('ov')
  const after = await assemble(listeners['system-prompt/assemble'], [{ type: 'assistant/message' }], tools, 'ov')
  assert.deepEqual(after.tools.map((tool) => tool.name), ['bash', 'read'])
})
