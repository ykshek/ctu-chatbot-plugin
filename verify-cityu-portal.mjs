/**
 * Standalone verification for the CityUHK portal adapter.
 *
 * Runs the real adapter against a local mock of the portal protocol and checks
 * the exact harness contract: chunk order, assembled message, flattened `qst`,
 * cookie handling, and failure classification through the harness's own
 * `normalizeLlmFailure`.
 *
 * Run: node verify-cityu-portal.mjs
 */

import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { strict as assert } from 'node:assert'
import { CityuPortalAdapter } from './cityu-portal-llm/lib/adapter.js'
import { resolveOptions } from './cityu-portal-llm/lib/config.js'
import { buildQuestion } from './cityu-portal-llm/lib/adapter.js'

const LLM = 'file:///var/home/linuxbrew/.linuxbrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
const FAILURE = 'file:///var/home/linuxbrew/.linuxbrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/adapter-failure.js'
const { BlockAssembler } = await import(LLM)
const { normalizeLlmFailure } = await import(FAILURE)

/** @type {{ path: string, body: any, cookie: string | undefined, userAgent: string | undefined }[]} */
const seen = []

const ANSWER = [
  '**Reset your CityU portal password**\n\n',
  '1. Open the [password reset page](https://www.cityu.edu.hk/).\n',
  '2. Confirm your EID.\n',
  '3. Follow the emailed link.\n',
].join('')

const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  let body
  try { body = raw === '' ? {} : JSON.parse(raw) } catch { body = { _unparsed: raw } }
  seen.push({
    path: req.url ?? '',
    body,
    cookie: req.headers.cookie,
    userAgent: req.headers['user-agent'],
    contentType: req.headers['content-type'],
  })

  if (req.url === '/startnewconversation') {
    if (body.model === 'AUTHFAIL') {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    if (body.model === 'CONFLICT') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'error', errorMsg: 'It seems you have another active Chatbot session. Please close all other sessions.' }))
      return
    }
    if (body.model === 'HTMLSESSION') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>Sign In</body></html>')
      return
    }
    if (body.model === 'REDIRECT') {
      res.writeHead(302, { location: 'https://auth.cityu.edu.hk/signin' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'success', errorMsg: '' }))
    return
  }

  if (req.url === '/getchatresponse') {
    if (body.model === 'EMPTY') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('')
      return
    }
    if (body.model === 'HTML') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>Sign In</body></html>')
      return
    }
    if (body.model === 'SLOW') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('late')
      }, 1500)
      return
    }
    if (body.model === 'GZIP') {
      const gz = gzipSync(Buffer.from(ANSWER, 'utf8'))
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      // Slice mid-codepoint to exercise the UTF-8 stream decoder.
      for (const slice of [gz.subarray(0, 10), gz.subarray(10, 11), gz.subarray(11)]) {
        res.write(slice)
      }
      res.end()
      return
    }
    // Default: plain chunked markdown.
    res.writeHead(200, { 'content-type': 'text/plain' })
    for (const piece of [ANSWER.slice(0, 20), ANSWER.slice(20, 60), ANSWER.slice(60)]) {
      res.write(piece)
      await new Promise(r => setTimeout(r, 5))
    }
    res.end()
    return
  }

  res.writeHead(404)
  res.end('not found')
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = /** @type {{ port: number }} */ (server.address())
const baseURL = `http://127.0.0.1:${port}`

/** @param {unknown} error */
function failureOf(error) {
  const normalized = normalizeLlmFailure(error)
  assert.ok(normalized.message.length > 0, 'normalized message is non-empty')
  return normalized
}

/** @param {object} overrides */
function makeAdapter(overrides = {}) {
  return new CityuPortalAdapter(resolveOptions({
    baseURL,
    cookie: 'JSESSIONID=test-cookie; portal=1',
    requestTimeoutMs: 5000,
    ...overrides,
  }))
}

/** @param {AsyncIterable<any>} stream */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const results = []
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => results.push({ name, ok: true }),
    (error) => { results.push({ name, ok: false, error }) },
  )
}

const history = [
  { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] },
  { role: 'user', content: [{ type: 'text', text: 'How do I reset my CityU portal password?' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Use the password reset page.' }] },
  { role: 'user', content: [{ type: 'text', text: 'And if the link expires?' }] },
]

await check('happy path streams one text block and stops', async () => {
  const adapter = makeAdapter()
  const chunks = await collect(adapter.stream({ provider: 'cityu-portal', model: 'cityu-gpt5', messages: history }))

  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.ok(chunks.some(c => c.type === 'text-delta'), 'has text deltas')
  const end = chunks.find(c => c.type === 'block-end')
  assert.ok(end, 'has block-end')
  assert.equal(end.block.type, 'text')
  assert.equal(end.block.text, ANSWER, 'block-end carries the complete answer')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.ok(!chunks.some(c => c.type === 'usage'), 'no usage chunk (portal reports none)')

  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const message = assembler.message({ provider: 'cityu-portal', model: 'cityu-gpt5' })
  assert.deepEqual(message.content, [{ type: 'text', text: ANSWER }])
  assert.equal(assembler.finish.kind, 'stop')
})

await check('flattens the transcript into one qst and omits the system prompt by default', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'cityu-portal', model: 'cityu-gpt5', messages: history, system: 'SYSTEM-FIELD' }))
  const chat = seen.find(entry => entry.path === '/getchatresponse')
  assert.ok(chat, 'getchatresponse was called')
  const qst = chat.body.qst
  assert.match(qst, /^User: How do I reset my CityU portal password\?/u)
  assert.match(qst, /Assistant: Use the password reset page\./u)
  assert.match(qst, /User: And if the link expires\?/u)
  assert.ok(!qst.includes('You are a helpful assistant'), 'system message omitted by default')
  assert.ok(!qst.includes('SYSTEM-FIELD'), 'options.system omitted by default')
  assert.equal(chat.body.model, 'GPT', 'cityu-gpt5 maps to the wire value GPT')
  assert.equal(chat.body.id, adapter.sessionId)
  assert.equal(chat.cookie, 'JSESSIONID=test-cookie; portal=1')
  assert.equal(chat.contentType, 'application/json')
  assert.match(chat.userAgent ?? '', /^deepseek-harness\//u, 'attribution user-agent present')
})

await check('includeSystemPrompt forwards the system prompt', async () => {
  seen.length = 0
  const adapter = makeAdapter({ includeSystemPrompt: true })
  await collect(adapter.stream({ provider: 'cityu-portal', model: 'cityu-gpt5', messages: history, system: 'SYSTEM-FIELD' }))
  const qst = seen.find(entry => entry.path === '/getchatresponse').body.qst
  assert.match(qst, /^System: SYSTEM-FIELD/u)
})

await check('claims the conversation before asking', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'cityu-portal', model: 'cityu-gpt5', messages: history }))
  assert.deepEqual(seen.map(entry => entry.path), ['/startnewconversation', '/getchatresponse'])
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['id', 'model'])
  assert.deepEqual(Object.keys(seen[1].body).sort(), ['id', 'model', 'qst'])
})

await check('unknown model ids are forwarded verbatim', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'cityu-portal', model: 'new-backend', messages: history }))
  assert.equal(seen[1].body.model, 'new-backend')
})

await check('reads a gzip-chunked body split mid-codepoint', async () => {
  const adapter = makeAdapter()
  const chunks = await collect(adapter.stream({ provider: 'cityu-portal', model: 'GZIP', messages: history }))
  const end = chunks.find(c => c.type === 'block-end')
  assert.equal(end.block.text, ANSWER)
})

await check('catalog exposes every model with text-only input', async () => {
  const adapter = makeAdapter()
  const models = await adapter.listModels('cityu-portal')
  assert.equal(models.length, 5)
  for (const model of models) {
    assert.equal(model.provider, 'cityu-portal')
    assert.deepEqual(model.inputModalities, ['text'])
    assert.ok(model.name.length > 0)
  }
  const resolved = await adapter.resolveModel('cityu-portal', 'cityu-dsv4')
  assert.equal(resolved.id, 'cityu-dsv4')
  assert.equal(resolved.name, 'CityUHK DeepSeek V4 Flash')
  assert.deepEqual(resolved.context, { contextWindow: 32000 })
})

await check('prepareCall binds model metadata and stream', async () => {
  const adapter = makeAdapter()
  const prepared = await adapter.prepareCall('cityu-portal', 'cityu-qwen38')
  assert.equal(prepared.model.id, 'cityu-qwen38')
  const chunks = await collect(prepared.stream({ provider: 'cityu-portal', model: 'cityu-qwen38', messages: history }))
  assert.equal(chunks.at(-1).type, 'finish')
})

await check('missing cookie fails MISSING_CREDENTIAL', async () => {
  const adapter = new CityuPortalAdapter(resolveOptions({ baseURL, cookieEnv: 'CITYU_TEST_ABSENT_COOKIE' }))
  delete process.env.CITYU_TEST_ABSENT_COOKIE
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'cityu-gpt5', messages: history })),
    (error) => failureOf(error).code === 'MISSING_CREDENTIAL',
  )
})

await check('env cookie is honored', async () => {
  process.env.CITYU_TEST_PRESENT_COOKIE = 'ENVCOOKIE=1'
  seen.length = 0
  const adapter = new CityuPortalAdapter(resolveOptions({ baseURL, cookieEnv: 'CITYU_TEST_PRESENT_COOKIE' }))
  await collect(adapter.stream({ provider: 'cityu-portal', model: 'cityu-gpt5', messages: history }))
  assert.equal(seen[0].cookie, 'ENVCOOKIE=1')
  delete process.env.CITYU_TEST_PRESENT_COOKIE
})

await check('401 fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'AUTHFAIL', messages: history })),
    (error) => { const f = failureOf(error); assert.equal(f.status, 401); return f.code === 'INVALID_CREDENTIAL' },
  )
})

await check('session conflict fails INVALID_REQUEST with guidance', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'CONFLICT', messages: history })),
    (error) => {
      const f = failureOf(error)
      assert.match(f.message, /active chatbot session/iu)
      return f.code === 'INVALID_REQUEST'
    },
  )
})

await check('empty answer fails EMPTY_RESPONSE', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'EMPTY', messages: history })),
    (error) => failureOf(error).code === 'EMPTY_RESPONSE',
  )
})

await check('login page on getchatresponse fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'HTML', messages: history })),
    (error) => failureOf(error).code === 'INVALID_CREDENTIAL',
  )
})

await check('login page on startnewconversation fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'HTMLSESSION', messages: history })),
    (error) => failureOf(error).code === 'INVALID_CREDENTIAL',
  )
})

await check('SSO redirect fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'REDIRECT', messages: history })),
    (error) => failureOf(error).code === 'INVALID_CREDENTIAL',
  )
})

await check('deadline fails TIMEOUT', async () => {
  const adapter = makeAdapter({ requestTimeoutMs: 200 })
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'SLOW', messages: history })),
    (error) => failureOf(error).code === 'TIMEOUT',
  )
})

await check('caller abort fails ABORTED', async () => {
  const adapter = makeAdapter({ requestTimeoutMs: 60000 })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'cityu-portal', model: 'SLOW', messages: history, signal: controller.signal })),
    (error) => failureOf(error).code === 'ABORTED',
  )
})

await check('buildQuestion can truncate from the front', async () => {
  const settings = { includeSystemPrompt: false, maxQuestionChars: 40 }
  const question = buildQuestion({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'A'.repeat(50) }] },
    { role: 'user', content: [{ type: 'text', text: 'B'.repeat(50) }] },
  ] }, settings)
  assert.equal(question.length, 74)
  assert.ok(question.endsWith('B'.repeat(40)))
  assert.match(question, /^\[earlier conversation truncated\]/u)
})

server.close()
await new Promise(resolve => setTimeout(resolve, 20))

let failed = 0
for (const result of results) {
  if (result.ok) {
    console.log(`ok   ${result.name}`)
  } else {
    failed++
    console.log(`FAIL ${result.name}`)
    console.log(result.error)
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
