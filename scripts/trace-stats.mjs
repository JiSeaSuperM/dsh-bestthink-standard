#!/usr/bin/env node
/**
 * trace-stats — BestThink trajectory fingerprint statistics.
 *
 * Reads a DeepSeek Harness session JSONL export (one JSON event per line,
 * e.g. `dsh session export <id>` output or the persisted session log) and
 * reports the trajectory fingerprint measured by the modeltest evaluation:
 *
 *   reasoning blocks   — number of `reasoning` content blocks across all
 *                        assistant messages
 *   we / let me / let's— word frequencies inside reasoning text
 *                        (case-insensitive word-boundary matches)
 *   reasoning p50      — median reasoning-block length in characters
 *   visible replies    — assistant messages carrying a visible `text` block
 *                        (the final summary; "stage replies" ≈ 1 for the
 *                        anchored trajectory)
 *   tool calls         — durable `tool/call` events
 *   headers            — first/last `request/header`: maxTokens and tool
 *                        count, the structural proof of the bootstrap→
 *                        promoted transition (1024 + ≤3 tools, then full
 *                        catalog + no 1024 residue)
 *
 * Target fingerprint (anchored-standard, Project2 V4.1b): `let me` ≈ 0,
 * `we` dominant, stage replies = 1.
 *
 * Usage: node scripts/trace-stats.mjs <session.jsonl> [more.jsonl ...]
 */

import { readFileSync } from 'node:fs'

/** Parse one line of the session JSONL into an event object, or null. */
export function parseLine(line) {
  const text = typeof line === 'string' ? line.trim() : String(line).trim()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Parse a whole JSONL document into an event array (skipping bad lines). */
export function parseJsonl(text) {
  return String(text)
    .split(/\r?\n/)
    .map(parseLine)
    .filter((event) => event !== null)
}

const WORD_RE = {
  we: /\bwe\b/gi,
  'let me': /\blet me\b/gi,
  "let's": /\blet's\b/gi,
}

function countMatches(regex, text) {
  return [...text.matchAll(regex)].length
}

function median(sortedNumbers) {
  if (sortedNumbers.length === 0) return null
  const mid = Math.floor(sortedNumbers.length / 2)
  return sortedNumbers.length % 2 === 1
    ? sortedNumbers[mid]
    : Math.round((sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2)
}

/** Collect the text of every `reasoning` block across assistant messages. */
function reasoningBlocks(events) {
  const blocks = []
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'reasoning' && typeof block.text === 'string') blocks.push(block.text)
    }
  }
  return blocks
}

/**
 * Analyze parsed session events into the trajectory fingerprint.
 * @param events - parsed JSONL event objects.
 * @returns the fingerprint object (all counts are plain numbers or null).
 */
export function analyzeSession(events) {
  const reasoning = reasoningBlocks(events)
  const reasoningText = reasoning.join('\n')

  const visibleReplies = events.filter((event) => {
    if (event?.type !== 'assistant/message') return false
    const content = event.data?.message?.content
    return Array.isArray(content) && content.some((block) => block?.type === 'text' && typeof block.text === 'string')
  }).length

  const toolCalls = events.filter((event) => event?.type === 'tool/call').length

  const headers = events
    .filter((event) => event?.type === 'request/header')
    .map((event) => event.data?.header)

  const summarizeHeader = (header) => {
    if (header === undefined) return 'n/a'
    const config = header.config ?? {}
    const tools = Array.isArray(header.tools) ? header.tools.length : null
    return `maxTokens=${config.maxTokens ?? 'default'} tools=${tools ?? '?'}`
  }

  return {
    reasoningBlocks: reasoning.length,
    we: countMatches(WORD_RE.we, reasoningText),
    'let me': countMatches(WORD_RE['let me'], reasoningText),
    "let's": countMatches(WORD_RE["let's"], reasoningText),
    reasoningP50Chars: median(reasoning.map((block) => block.length).sort((a, b) => a - b)),
    visibleReplies,
    toolCalls,
    headers: {
      count: headers.length,
      first: summarizeHeader(headers[0]),
      last: summarizeHeader(headers.at(-1)),
    },
  }
}

/** Render the fingerprint report as a plain-text table. */
export function formatReport(stats, label = '<session>') {
  const target = 'target: let me ≈ 0 · we dominant · stage replies ≈ 1'
  return [
    `trace fingerprint: ${label}`,
    `  reasoning blocks : ${stats.reasoningBlocks}`,
    `  we               : ${stats.we}`,
    `  let me           : ${stats['let me']}`,
    `  let's            : ${stats["let's"]}`,
    `  reasoning p50    : ${stats.reasoningP50Chars ?? 'n/a'} chars`,
    `  visible replies  : ${stats.visibleReplies}`,
    `  tool calls       : ${stats.toolCalls}`,
    `  request headers  : ${stats.headers.count} (first: ${stats.headers.first} / last: ${stats.headers.last})`,
    `  ${target}`,
  ].join('\n')
}

function main(argv) {
  const files = argv.slice(2)
  if (files.length === 0) {
    process.stderr.write('usage: node scripts/trace-stats.mjs <session.jsonl> [more.jsonl ...]\n')
    process.exitCode = 1
    return
  }
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      process.stderr.write(`trace-stats: cannot read ${file}: ${error.message}\n`)
      process.exitCode = 1
      continue
    }
    const stats = analyzeSession(parseJsonl(text))
    process.stdout.write(formatReport(stats, file) + '\n')
  }
}

// Direct execution (imports reuse analyzeSession/parseJsonl for tests).
import { pathToFileURL } from 'node:url'

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv)
}
