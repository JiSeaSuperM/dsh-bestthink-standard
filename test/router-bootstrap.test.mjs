/** router-bootstrap plugin-level tests: assembly, promotion agreement, guides. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../preset/router-bootstrap.mjs'

const TOOLS = [
  { name: 'read' }, { name: 'edit' }, { name: 'write' }, { name: 'glob' }, { name: 'grep' },
  { name: 'pwsh' }, { name: 'bash' }, { name: 'skill' }, { name: 'workflow' }, { name: 'todo' },
]

function register(cfg = {}) {
  const listeners = {}
  const registered = []
  const disposers = []
  const ctx = {
    on(event, callback) {
      listeners[event] = callback
    },
    effect(fn) {
      const result = fn()
      if (typeof result === 'function') disposers.push(result)
    },
    get(name) {
      return name === 'agent' ? undefined : undefined
    },
    tools: {
      register(definition) {
        registered.push(definition.name)
        return () => {}
      },
    },
    llm: {
      stream() {
        throw new Error('llm.stream must not be reached in unit tests')
      },
    },
  }
  apply(ctx, cfg)
  return { listeners, registered, disposers }
}

const session = (events, id = 's1') => ({ id, events, header: { cwd: 'C:\\w' } })
const userEvent = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })

function assemble(listener, events, opts = {}) {
  const { model = 'deepseek-v4-pro', tools = TOOLS, sections, contexts, session: sess, agent: agentOverride } = opts
  const target = sess ?? session(events)
  // A real DSH Agent carries `inbox`; tests that exercise the session/event
  // guide path must pass a full agent handle (agentOverride).
  const agent = agentOverride ?? { session: target, options: { model, provider: 'deepseek-official' } }
  return listener(
    undefined,
    { agent },
    async () => ({
      sections: sections ?? [
        { name: 'harness-identity', text: 'identity', order: -100 },
        { name: 'persona', text: 'fallback persona', order: 0 },
        { name: 'plan-mode', text: 'You are in plan mode.', order: -50 },
      ],
      contexts: contexts ?? [{ name: 'time-context', text: 'now' }],
      tools,
      variables: {},
    }),
  )
}

const names = (tools) => tools.map((tool) => tool.name)

test('registers the four dev tools and nothing else', () => {
  const { registered } = register()
  assert.deepEqual(registered.sort(), [
    'dev_anchor_mode', 'dev_mode_subagent', 'dev_router_mode', 'dev_router_status', 'dev_trajectory_status',
  ])
})

test('spec task: spec persona, read-first core + shell, no contexts while bootstrapping', async () => {
  const { listeners } = register()
  const result = await assemble(listeners['system-prompt/assemble'], [userEvent('修复这个仓库里的 bug')])
  assert.equal(result.sections.find((s) => s.name === 'router-persona').text, 'You are a helpful software engineer assistant.')
  assert.ok(result.sections.some((s) => s.name === 'plan-mode'), 'plan-mode section survives')
  assert.ok(!result.sections.some((s) => s.name === 'persona'), 'fallback persona replaced')
  assert.deepEqual(names(result.tools), ['read', 'edit', 'glob', 'grep', 'pwsh'])
  assert.deepEqual(result.contexts, [])
})

test('react task: doer persona, write-first core + shell', async () => {
  const { listeners } = register()
  const result = await assemble(listeners['system-prompt/assemble'], [userEvent('帮我写一个 Python 脚本处理 CSV')])
  const persona = result.sections.find((s) => s.name === 'router-persona').text
  assert.ok(persona.includes('hands-on'))
  assert.ok(persona.includes('do not build test harnesses'))
  assert.deepEqual(names(result.tools), ['read', 'edit', 'write', 'pwsh'])
  assert.deepEqual(result.contexts, [])
})

test('ambiguous task: weak persona for the routed model (pro vs flash)', async () => {
  const { listeners } = register()
  const pro = await assemble(listeners['system-prompt/assemble'], [userEvent('今天天气怎么样')], { model: 'deepseek-v4-pro' })
  const flash = await assemble(listeners['system-prompt/assemble'], [userEvent('今天天气怎么样')], { model: 'deepseek-v4-flash' })
  const proPersona = pro.sections.find((s) => s.name === 'router-persona').text
  const flashPersona = flash.sections.find((s) => s.name === 'router-persona').text
  assert.ok(proPersona.includes('decide the task type'))
  assert.ok(!proPersona.includes('review what you have already done'))
  assert.ok(flashPersona.includes('review what you have already done'))
})

test('after a tool/call the full catalog and full contexts return', async () => {
  const { listeners } = register()
  const events = [userEvent('修复这个仓库里的 bug'), { type: 'tool/call', data: { name: 'read' } }]
  const result = await assemble(listeners['system-prompt/assemble'], events)
  assert.deepEqual(names(result.tools), names(TOOLS), 'full catalog after promotion')
  assert.deepEqual(result.contexts.map((c) => c.name), ['time-context'], 'contexts restored after promotion')
  assert.equal(result.sections.find((s) => s.name === 'router-persona').text, 'You are a helpful software engineer assistant.')
})

test('promotion agrees with promoteOn assistant-message (shared signal)', async () => {
  const { listeners } = register({ promoteOn: 'assistant-message' })
  const events = [userEvent('修复这个仓库里的 bug'), { type: 'assistant/message', data: {} }]
  const result = await assemble(listeners['system-prompt/assemble'], events)
  assert.deepEqual(names(result.tools), names(TOOLS), 'assistant-message promotes when configured')
})

test('promoteOn tool-call keeps bootstrap after a text-only reply', async () => {
  const { listeners } = register({ promoteOn: 'tool-call' })
  const events = [userEvent('修复这个仓库里的 bug'), { type: 'assistant/message', data: {} }]
  const result = await assemble(listeners['system-prompt/assemble'], events)
  assert.deepEqual(names(result.tools), ['read', 'edit', 'glob', 'grep', 'pwsh'])
})

test('config.mode pins every session to a fixed band', async () => {
  const { listeners } = register({ mode: 'react' })
  const result = await assemble(listeners['system-prompt/assemble'], [userEvent('修复这个仓库里的 bug')])
  const persona = result.sections.find((s) => s.name === 'router-persona').text
  assert.ok(persona.includes('hands-on'), 'fix task still gets the react persona')
})

test('config.extraKeywords widen classification', async () => {
  const { listeners } = register({ extraReactKeywords: ['股票池'] })
  const result = await assemble(listeners['system-prompt/assemble'], [userEvent('生成一份股票池报告')])
  const persona = result.sections.find((s) => s.name === 'router-persona').text
  assert.ok(persona.includes('hands-on'), 'extra keyword routes to react')
})

// ── weak-mode near-field guidance ──────────────────────────────────────────

test('weak mode appends one guidance message after a real user message', async () => {
  const { listeners } = register()
  const inboxAppends = []
  const sess = session([userEvent('今天天气怎么样')])
  const target = { session: sess, inbox: { append: (t, m) => inboxAppends.push({ t, m }) } }
  // register the agent through assembly (same session object, full handle),
  // then fire the listener
  await assemble(listeners['system-prompt/assemble'], sess.events, { model: 'deepseek-v4-pro', session: sess, agent: target })
  listeners['session/event'](sess, sess.events[0])
  assert.equal(inboxAppends.length, 1)
  assert.equal(inboxAppends[0].t, 'next-step')
  assert.equal(inboxAppends[0].m.role, 'user')
  assert.equal(inboxAppends[0].m.source.kind, 'plugin')
  assert.ok(inboxAppends[0].m.content[0].text.includes('classify this task'))
})

test('complex weak-mode tasks get the deep guide', async () => {
  const { listeners } = register()
  const inboxAppends = []
  const sess = session([userEvent('帮我设计一个完整的微服务架构并详细分析集成点')])
  const target = { session: sess, inbox: { append: (t, m) => inboxAppends.push({ t, m }) } }
  await assemble(listeners['system-prompt/assemble'], sess.events, { model: 'deepseek-v4-flash', session: sess, agent: target })
  listeners['session/event'](sess, sess.events[0])
  assert.equal(inboxAppends.length, 1)
  assert.ok(inboxAppends[0].m.content[0].text.includes('architecture, edge cases, and integration points'))
})

test('strong modes append no guidance', async () => {
  const { listeners } = register()
  const inboxAppends = []
  const sess = session([userEvent('修复这个仓库里的 bug')]) // spec mode
  const target = { session: sess, inbox: { append: (t, m) => inboxAppends.push({ t, m }) } }
  await assemble(listeners['system-prompt/assemble'], sess.events, { session: sess, agent: target })
  listeners['session/event'](sess, sess.events[0])
  assert.equal(inboxAppends.length, 0)
})

test('plugin-sourced messages never trigger guidance', async () => {
  const { listeners } = register()
  const inboxAppends = []
  const sess = session([userEvent('今天天气怎么样')])
  const target = { session: sess, inbox: { append: (t, m) => inboxAppends.push({ t, m }) } }
  await assemble(listeners['system-prompt/assemble'], sess.events, { session: sess, agent: target })
  listeners['session/event'](sess, { type: 'user/message', data: { content: [], source: { kind: 'plugin' } } })
  assert.equal(inboxAppends.length, 0)
})

test('dev tools execute against the current session', async () => {
  const captured = {}
  const listeners2 = {}
  const ctx2 = {
    on(event, callback) { listeners2[event] = callback },
    effect(fn) { fn() },
    get(name) { return name === 'agent' ? undefined : undefined },
    tools: { register(def) { captured[def.name] = def; return () => {} } },
    llm: { stream() { throw new Error('not reached') } },
  }
  apply(ctx2, {})
  const sess = session([userEvent('修复这个仓库里的 bug')])
  await listeners2['system-prompt/assemble'](undefined, { agent: { session: sess, options: { model: 'deepseek-v4-pro' } } }, async () => ({ sections: [], contexts: [], tools: TOOLS, variables: {} }))
  const status = await captured.dev_trajectory_status.execute()
  assert.ok(status.includes('phase=bootstrap'), status)
  assert.ok(status.includes('bootstrapMaxTokens=1024'))
  // promote and re-check
  sess.events.push({ type: 'tool/call', data: {} })
  const promoted = await captured.dev_trajectory_status.execute()
  assert.ok(promoted.includes('phase=promoted'), promoted)
  assert.ok(promoted.includes('contextStrip=released'), promoted)
  // anchor mode switch
  const anchor = await captured.dev_anchor_mode.execute({ mode: 'off' })
  assert.ok(anchor.includes('next request applies'), anchor)
})
