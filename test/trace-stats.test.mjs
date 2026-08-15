/** trace-stats self-tests against the sample session JSONL. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { analyzeSession, parseJsonl, parseLine, formatReport } from '../scripts/trace-stats.mjs'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'trace-sample.jsonl')
const sample = parseJsonl(readFileSync(fixture, 'utf8'))

test('parseLine skips blank and malformed lines', () => {
  assert.equal(parseLine(''), null)
  assert.equal(parseLine('   '), null)
  assert.equal(parseLine('not json'), null)
  assert.equal(parseLine('{"a":1}').a, 1)
})

test('the sample parses into events', () => {
  assert.ok(sample.length >= 12)
  assert.equal(sample[0].type, 'request/header')
})

test('fingerprint counts reasoning blocks, words, replies, tools', () => {
  const stats = analyzeSession(sample)
  assert.equal(stats.reasoningBlocks, 3)
  assert.ok(stats.we >= 5, `we=${stats.we} should dominate`)
  assert.equal(stats['let me'], 1) // the single "Let me check..." in block 1
  assert.equal(stats["let's"], 0)
  assert.equal(stats.visibleReplies, 1) // only the final summary
  assert.equal(stats.toolCalls, 2)
})

test('reasoning p50 is the median block length', () => {
  const stats = analyzeSession(sample)
  const lengths = [
    'We need to locate the failing test first. Let me check the repository layout so we can find the broken module. We should read the error log before editing anything.'.length,
    'We can see the failing test now. We should patch the module directly and verify with the test runner.'.length,
    'We verified the fix by running the tests and the suite is green.'.length,
  ].sort((a, b) => a - b)
  assert.equal(stats.reasoningP50Chars, lengths[1])
})

test('headers report the bootstrap→promoted transition', () => {
  const stats = analyzeSession(sample)
  assert.equal(stats.headers.count, 2)
  assert.ok(stats.headers.first.includes('maxTokens=1024 tools=2'), stats.headers.first)
  assert.ok(!stats.headers.last.includes('1024'), stats.headers.last)
  assert.ok(stats.headers.last.includes('tools=9'), stats.headers.last)
})

test('empty sessions produce a safe report', () => {
  const stats = analyzeSession([])
  assert.deepEqual(stats.reasoningBlocks, 0)
  assert.equal(stats.reasoningP50Chars, null)
  assert.equal(stats.headers.count, 0)
  assert.ok(formatReport(stats).includes('reasoning blocks : 0'))
})
