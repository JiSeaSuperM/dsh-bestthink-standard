/** Router classifier + continuous mode tests (ported + BTS extensions). */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyTask, personaFor, coreFor, bandFor, testinessFor, parseMode, applyPersona,
  isFlashModel, sessionMode, extractText,
} from '../preset/router-core.mjs'

test('react: greenfield/build tasks map to react band', () => {
  assert.equal(bandFor(classifyTask('需要本地开发一个马里奥网页小游戏，参考经典原版')), 'react')
  assert.equal(bandFor(classifyTask('帮我写一个 Python 脚本处理 CSV')), 'react')
  assert.equal(bandFor(classifyTask('从零搭建一个网站')), 'react')
})

test('spec: maintenance/fix tasks map to spec band', () => {
  assert.equal(bandFor(classifyTask('修复这个仓库里的 bug')), 'spec')
  assert.equal(bandFor(classifyTask('为什么登录一直报错，帮我排查')), 'spec')
  assert.equal(classifyTask('修复这个仓库里的 bug'), 0)
})

test('mixed task lands in react band (net react keywords)', () => {
  assert.equal(bandFor(classifyTask('帮我开发一个小游戏然后修复里面的 bug')), 'react')
})

test('unmatched defaults to weak (internal routing)', () => {
  assert.equal(classifyTask('今天天气怎么样'), 'weak')
  assert.equal(bandFor('weak'), 'weak')
})

test('ties default to weak (internal routing)', () => {
  assert.equal(classifyTask('帮我开发一个小游戏然后修复里面的 bug'), 1) // net react wins
  assert.equal(classifyTask('开发并修复'), 'weak') // tie → weak
})

test('weak persona is model-specific (P11/P24)', () => {
  const pro = personaFor('weak', 'deepseek-v4-pro')
  const flash = personaFor('weak', 'deepseek-v4-flash')
  assert.ok(pro.includes('decide the task type (build or fix)'))
  assert.ok(pro.includes('You are a helpful software engineer assistant.'))
  assert.ok(!pro.includes('review what you have already done')) // P24: anchors hurt Pro
  assert.ok(flash.includes('decide the task type (build or fix)'))
  assert.ok(flash.includes('review what you have already done')) // anchors help flash
  assert.notEqual(pro, flash)
  assert.equal(personaFor('weak', 'deepseek-v4-flash'), personaFor('weak', 'deepseek-v4-flash'))
  assert.equal(isFlashModel('deepseek-v4-flash'), true)
  assert.equal(isFlashModel('deepseek-v4-pro'), false)
})

test('parseMode accepts weak', () => {
  assert.equal(parseMode('weak'), 'weak')
  assert.equal(parseMode('router'), 'weak')
})

test('persona quantizes to three measured bands', () => {
  assert.equal(personaFor(0), 'You are a helpful software engineer assistant.')
  assert.equal(personaFor(0.1), 'You are a helpful software engineer assistant.')
  assert.ok(personaFor(0.3).includes('Work directly'))
  assert.ok(!personaFor(0.3).includes('test harnesses'))
  assert.ok(personaFor(1).includes('hands-on'))
  assert.ok(personaFor(1).includes('do not build test harnesses'))
})

test('core tool surface varies by band', () => {
  assert.deepEqual(coreFor(0), ['read', 'edit', 'glob', 'grep'])
  assert.deepEqual(coreFor(1), ['read', 'write', 'edit'])
  assert.deepEqual(coreFor(0.3), ['read', 'edit', 'write', 'glob', 'grep'])
})

test('band mapping matches the measured phase transition', () => {
  assert.equal(bandFor(0.1), 'spec') // stable spec region
  assert.equal(bandFor(0.2), 'mixed') // unstable band (display name)
  assert.equal(bandFor(0.4), 'mixed')
  assert.equal(bandFor(0.5), 'react') // stable react region
  assert.equal(bandFor(0.99), 'react')
})

test('testiness rises toward spec', () => {
  assert.equal(testinessFor(1), 'suppressed')
  assert.equal(testinessFor(0), 'normal')
  assert.equal(testinessFor(0.3), 'light')
})

test('parseMode accepts bands, percents, and decimals', () => {
  assert.equal(parseMode('spec'), 0)
  assert.equal(parseMode('react'), 1)
  assert.equal(parseMode('balanced'), 0.3)
  assert.equal(parseMode('70'), 0.7)
  assert.equal(parseMode('0.3'), 0.3)
  assert.equal(parseMode('auto'), 'auto')
  assert.equal(parseMode('nonsense'), null)
})

test('applyPersona replaces only the persona section (keeps plan-mode)', () => {
  const sections = [
    { name: 'harness-identity', text: 'x', order: -100 },
    { name: 'persona', text: 'old persona', order: 0 },
    { name: 'plan-mode', text: 'You are in plan mode.', order: -50 },
    { name: 'tool-guidance', text: 'y', order: 100 },
  ]
  const out = applyPersona(sections, 'new persona')
  const names = out.map((s) => s.name)
  assert.ok(names.includes('harness-identity'))
  assert.ok(names.includes('plan-mode'), 'plan-mode section must survive')
  assert.ok(names.includes('tool-guidance'))
  assert.ok(!names.includes('persona'), 'old persona section replaced')
  assert.equal(out.find((s) => s.name === 'router-persona').text, 'new persona')
})

test('applyPersona tolerates missing sections', () => {
  const out = applyPersona([], 'p')
  assert.deepEqual(out, [{ name: 'router-persona', text: 'p', order: 0 }])
})

// ── BTS extensions: configurable keywords, session mode, extractText ───────

test('classifyTask: extraReactKeywords widen the react domain', () => {
  const extras = { extraReactKeywords: ['股票池', '选股'] }
  assert.equal(classifyTask('今天天气怎么样'), 'weak')
  assert.equal(classifyTask('整理一份股票池清单', extras), 1)
  assert.equal(classifyTask('今天天气怎么样', extras), 'weak') // unrelated text stays weak
  assert.equal(classifyTask('整理一份股票池清单', {}), 'weak') // empty extras = no-op
})

test('classifyTask: extraSpecKeywords widen the spec domain', () => {
  const extras = { extraSpecKeywords: ['回滚', '欠费'] }
  assert.equal(classifyTask('登录欠费了，帮我处理一下', extras), 0)
})

test('classifyTask: built-in keywords still win without extras', () => {
  assert.equal(classifyTask('帮我写一个 Python 脚本处理 CSV'), 1)
  assert.equal(classifyTask('修复这个仓库里的 bug'), 0)
})

test('classifyTask: regex-special extra keywords are escaped', () => {
  const extras = { extraReactKeywords: ['a+b.c'] }
  assert.equal(classifyTask('做一个 a+b.c 的东西', extras), 1)
  assert.equal(classifyTask('今天天气怎么样', extras), 'weak') // no false hit
})

test('sessionMode derives the mode from the first user message', () => {
  const session = (text) => ({ events: [{ type: 'user/message', data: { content: [{ type: 'text', text }] } }] })
  assert.equal(sessionMode(session('帮我写一个脚本')), 1)
  assert.equal(sessionMode(session('修复这个 bug')), 0)
  assert.equal(sessionMode(session('今天天气怎么样')), 'weak')
  assert.equal(sessionMode({ events: [] }), 'weak')
  assert.equal(sessionMode({ events: [{ type: 'user/message', data: {} }] }), 'weak')
})

test('sessionMode passes extras through to the classifier', () => {
  const session = { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '整理一份股票池清单' }] } }] }
  assert.equal(sessionMode(session), 'weak') // no built-in keyword hits
  assert.equal(sessionMode(session, { extraReactKeywords: ['股票池'] }), 1)
})

test('extractText flattens text blocks and tolerates missing data', () => {
  assert.equal(extractText(undefined), '')
  assert.equal(extractText({}), '')
  assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a b')
  assert.equal(extractText({ content: ['raw', { type: 'text', text: 'x' }] }), 'raw x')
})
