/**
 * Standalone verification for the portal adapter.
 *
 * Runs the real adapter against a local mock of the portal's `chatbot` module
 * and checks the exact harness contract: chunk order, assembled message, the
 * flattened `qst`, the `,,,` answer frame, style/sessionOnly fields, cookie
 * handling, disclaimer handling, and failure classification through the
 * harness's own `normalizeLlmFailure`.
 *
 * Run: node verify-ctu-portal.mjs
 */

import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { strict as assert } from 'node:assert'
import { buildQuestion, CtuPortalAdapter } from './ctu-chatbot-plugin/lib/adapter.js'
import { coerceArguments, extractToolCalls } from './ctu-chatbot-plugin/lib/dsml.js'
import { resolveOptions } from './ctu-chatbot-plugin/lib/config.js'

const LLM = 'file:///var/home/linuxbrew/.linuxbrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
const FAILURE = 'file:///var/home/linuxbrew/.linuxbrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/adapter-failure.js'
const { BlockAssembler } = await import(LLM)
const { normalizeLlmFailure } = await import(FAILURE)

/** @type {{ path: string, body: any, cookie: string | undefined, userAgent: string | undefined, contentType: string | undefined }[]} */
const seen = []

const ANSWER = [
  '**Reset your portal password**\n\n',
  '1. Open the [password reset page](https://www.cityu.edu.hk/).\n',
  '2. Confirm your EID.\n',
  '3. Follow the emailed link.\n',
].join('')

const TOOL_DSML = [
  "I'll inspect the project.\n\n",
  '<｜DSML｜tool_calls>\n',
  '<｜DSML｜invoke name="bash">\n',
  '<｜DSML｜parameter name="description" string="true">List files</｜DSML｜parameter>\n',
  '<｜DSML｜parameter name="command" string="true">pwd && ls -la</｜DSML｜parameter>\n',
  '</｜DSML｜invoke>\n',
  '<｜DSML｜invoke name="read">\n',
  '<｜DSML｜parameter name="file_path" string="true">/tmp/example.txt</｜DSML｜parameter>\n',
  '<｜DSML｜parameter name="offset" string="false">3</｜DSML｜parameter>\n',
  '</｜DSML｜invoke>\n',
  '</｜DSML｜tool_calls>',
].join('')

const REFUSAL = '很抱歉，我無法提供你問題的答案。你可以通過電郵IT.ServiceDesk @cityu.edu.hk或致電3442 - 8340（職員專線）或3442 - 6488（學生專線）聯繫IT Service Desk尋求進一步的協助。謝謝！'
const CONFLICT = 'It seems you have another active Chatbot session. Please close all other sessions and reload this page. If all your other Chatbot session(s) have been closed, please wait for 5 minutes and reload this page again.'

/** Conversation ids whose disclaimer was accepted by the mock. */
const agreed = new Set()
/** Per-conversation count for the one-shot length-guard model. */
const tooLongOnce = new Map()
/** Conversation ids whose user record was created by the mock. */
const created = new Set()

/** @param {string} id @param {string} text */
function frame(id, text) {
  return `${id},,,${text}`
}

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

  const path = req.url ?? ''

  if (path.endsWith('/getchathistory')) {
    if (body.model === 'AUTHFAIL') {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    if (body.model === 'DENIED') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'AccessDenied', errorMsg: '' }))
      return
    }
    if (body.model === 'REFUSED') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'fail' }))
      return
    }
    if (body.model === 'CONFLICT') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'fail', errorMsg: 'It seems you have another active Chatbot session. Please close all other sessions.' }))
      return
    }
    if (body.model === 'DISCLAIMER') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'showdisclaimer' }))
      return
    }
    if (body.model === 'NEWUSER' && !created.has(body.id)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'newUser' }))
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
    res.end(JSON.stringify({ status: 'success', errorMsg: '', chatMessages: [], style: '1', sessionOnly: false }))
    return
  }

  if (path.endsWith('/agreeandproceed')) {
    agreed.add(body.id)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'success' }))
    return
  }

  if (path.endsWith('/createnewuser')) {
    created.add(body.id)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'success' }))
    return
  }

  if (path.endsWith('/getchatresponse')) {
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
        res.end(frame(body.id, 'late'))
      }, 1500)
      return
    }
    if (body.model === 'GZIP') {
      const gz = gzipSync(Buffer.from(frame(body.id, ANSWER), 'utf8'))
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      // Slice mid-codepoint to exercise the UTF-8 stream decoder.
      for (const slice of [gz.subarray(0, 10), gz.subarray(10, 11), gz.subarray(11)]) {
        res.write(slice)
      }
      res.end()
      return
    }
    if (body.model === 'SPLITPREFIX') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      const framed = frame(body.id, ANSWER)
      const separator = framed.indexOf(',,,')
      // Split the separator itself and the answer after it, without overlap.
      for (const piece of [framed.slice(0, separator + 1), framed.slice(separator + 1, separator + 4), framed.slice(separator + 4)]) {
        res.write(piece)
        await new Promise(r => setTimeout(r, 5))
      }
      res.end()
      return
    }
    if (body.model === 'NOPREFIX') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('just an answer')
      return
    }
    if (body.model === 'REFUSALTEXT') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(REFUSAL)
      return
    }
    if (body.model === 'REFUSALFRAMED') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(frame(body.id, REFUSAL))
      return
    }
    if (body.model === 'TOOLS') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(frame(body.id, TOOL_DSML))
      return
    }
    if (body.model === 'TOOLS_SPLIT') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      const framed = frame(body.id, TOOL_DSML)
      const at = framed.indexOf('tool_calls')
      for (const piece of [framed.slice(0, at), framed.slice(at, at + 4), framed.slice(at + 4, 120), framed.slice(120)]) {
        res.write(piece)
        await new Promise(r => setTimeout(r, 5))
      }
      res.end()
      return
    }
    if (body.model === 'TOOLONG_ONCE') {
      const count = tooLongOnce.get(body.id) ?? 0
      tooLongOnce.set(body.id, count + 1)
      if (count === 0) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('Your message is too long to be processed. Please reduce the length of your message and try again.')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(frame(body.id, ANSWER))
      return
    }
    if (body.model === 'QUOTA') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('You have reached your monthly quota. Please contact the IT Service Desk.')
      return
    }
    if (body.model === 'RATELIMIT') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('Too many requests. Please slow down and try again later.')
      return
    }
    if (body.model === 'CONFLICT') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(CONFLICT)
      return
    }
    if (body.model === 'TOOLONG') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('Your message is too long to be processed. Please reduce the length of your message and try again.')
      return
    }
    // Default: framed chunked markdown.
    const framed = frame(body.id, ANSWER)
    res.writeHead(200, { 'content-type': 'text/plain' })
    for (const piece of [framed.slice(0, 20), framed.slice(20, 60), framed.slice(60)]) {
      res.write(piece)
      await new Promise(r => setTimeout(r, 5))
    }
    res.end()
    return
  }

  if (path.endsWith('/getusage')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      model: [
        { modelValue: 'GPTmini', modelName: 'GPTmini', lastUsed: false },
        { modelValue: 'GPT', modelName: 'GPT', lastUsed: true },
        { modelValue: 'DSV4', modelName: 'DSV4', lastUsed: false },
        { modelValue: 'QWen38', modelName: 'QWen38', lastUsed: false },
      ],
      quota: 15000,
      quotaLeft: 14500,
      nextQuotaUpdate: '2026-12-21T00:00:00',
      lastWordsConsumption: 1680,
    }))
    return
  }

  res.writeHead(404)
  res.end('not found')
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = /** @type {{ port: number }} */ (server.address())
const baseURL = `http://127.0.0.1:${port}/chatbot`

/** @param {unknown} error */
function failureOf(error) {
  const normalized = normalizeLlmFailure(error)
  assert.ok(normalized.message.length > 0, 'normalized message is non-empty')
  return normalized
}

/** @param {object} overrides */
function makeAdapter(overrides = {}) {
  return new CtuPortalAdapter(resolveOptions({
    baseURL,
    cookie: 'JSESSIONID=test-cookie; portal=1',
    requestTimeoutMs: 5000,
    includeSystemPrompt: false,
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
  { role: 'user', content: [{ type: 'text', text: 'How do I reset my portal password?' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Use the password reset page.' }] },
  { role: 'user', content: [{ type: 'text', text: 'And if the link expires?' }] },
]

await check('happy path streams one text block without the conversation-id frame', async () => {
  const adapter = makeAdapter()
  const chunks = await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history }))

  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.ok(chunks.some(c => c.type === 'text-delta'), 'has text deltas')
  const end = chunks.find(c => c.type === 'block-end')
  assert.ok(end, 'has block-end')
  assert.equal(end.block.type, 'text')
  assert.equal(end.block.text, ANSWER, 'block-end carries the complete answer')
  assert.ok(!end.block.text.includes(',,,'), 'the conversation-id frame is stripped')
  assert.ok(!end.block.text.includes(adapter.sessionId), 'the conversation id is not leaked into the answer')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  // The portal reports no token counts, so the adapter estimates them; the
  // chunk must land before the terminal chunk so the assembler records it.
  const usageIndex = chunks.findIndex(c => c.type === 'usage')
  assert.ok(usageIndex >= 0, 'emits an estimated usage chunk')
  assert.ok(usageIndex < chunks.length - 1, 'usage precedes the terminal finish')
  const usage = chunks[usageIndex].usage
  assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0, 'estimates both sides')
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens, 'total is the sum')

  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const message = assembler.message({ provider: 'ctu-portal', model: 'ctu-gpt5' })
  assert.deepEqual(message.content, [{ type: 'text', text: ANSWER }])
  assert.equal(assembler.finish.kind, 'stop')
})

await check('flattens the transcript into one qst and omits the system prompt by default', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history, system: 'SYSTEM-FIELD' }))
  const chat = seen.find(entry => entry.path.endsWith('/getchatresponse'))
  assert.ok(chat, 'getchatresponse was called')
  const qst = chat.body.qst
  assert.match(qst, /^User: How do I reset my portal password\?/u)
  assert.match(qst, /Assistant: Use the password reset page\./u)
  assert.match(qst, /User: And if the link expires\?/u)
  assert.ok(!qst.includes('You are a helpful assistant'), 'system message omitted by default')
  assert.ok(!qst.includes('SYSTEM-FIELD'), 'options.system omitted by default')
  assert.equal(chat.body.model, 'GPT', 'ctu-gpt5 maps to the wire value GPT')
  assert.equal(chat.body.id, adapter.sessionId)
  assert.equal(chat.body.style, '1', 'balanced thinking is the default style')
  assert.equal(chat.body.sessionOnly, false)
  assert.equal(chat.cookie, 'JSESSIONID=test-cookie; portal=1')
  assert.equal(chat.contentType, 'application/json')
  assert.match(chat.userAgent ?? '', /^deepseek-harness\//u, 'attribution user-agent present')
})

await check('includeSystemPrompt forwards the system prompt', async () => {
  seen.length = 0
  const adapter = makeAdapter({ includeSystemPrompt: true })
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history, system: 'SYSTEM-FIELD' }))
  const qst = seen.find(entry => entry.path.endsWith('/getchatresponse')).body.qst
  assert.match(qst, /^System: SYSTEM-FIELD/u)
})

await check('opens the conversation with getchathistory before asking', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history }))
  assert.deepEqual(
    seen.map(entry => entry.path.split('/').at(-1)),
    ['getchathistory', 'getchatresponse'],
  )
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['id', 'model', 'qst', 'sessionOnly', 'style'])
  assert.equal(seen[0].body.qst, 'newSession', 'the session is opened the way the portal page opens it')
  assert.equal(seen[0].body.style, '1')
  assert.equal(seen[0].body.sessionOnly, false)
  assert.deepEqual(Object.keys(seen[1].body).sort(), ['id', 'model', 'qst', 'sessionOnly', 'style'])
})

await check('opens the conversation once per id, not on every turn', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history }))
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history }))
  assert.deepEqual(
    seen.map(entry => entry.path.split('/').at(-1)),
    ['getchathistory', 'getchatresponse', 'getchatresponse'],
  )
})

await check('reopens the conversation when the model changes', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history }))
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-dsv4', messages: history }))
  assert.deepEqual(
    seen.map(entry => entry.path.split('/').at(-1)),
    ['getchathistory', 'getchatresponse', 'getchathistory', 'getchatresponse'],
  )
})

await check('thinking effort is configurable', async () => {
  seen.length = 0
  const adapter = makeAdapter({ style: 'deep', sessionOnly: true })
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-dsv4', messages: history }))
  const chat = seen.find(entry => entry.path.endsWith('/getchatresponse'))
  assert.equal(chat.body.style, '2')
  assert.equal(chat.body.sessionOnly, true)
  assert.equal(resolveOptions({ style: 'quick' }).style, '0')
  assert.equal(resolveOptions({ style: 2 }).style, '2')
  assert.equal(resolveOptions({ style: 'nonsense' }).style, '1')
})

await check('unknown model ids are forwarded verbatim', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'new-backend', messages: history }))
  assert.equal(seen.find(entry => entry.path.endsWith('/getchatresponse')).body.model, 'new-backend')
})

await check('reads a gzip-chunked framed body split mid-codepoint', async () => {
  const adapter = makeAdapter()
  const chunks = await collect(adapter.stream({ provider: 'ctu-portal', model: 'GZIP', messages: history }))
  const end = chunks.find(c => c.type === 'block-end')
  assert.equal(end.block.text, ANSWER)
})

await check('handles a conversation-id frame split across chunks', async () => {
  const adapter = makeAdapter()
  const chunks = await collect(adapter.stream({ provider: 'ctu-portal', model: 'SPLITPREFIX', messages: history }))
  const end = chunks.find(c => c.type === 'block-end')
  assert.equal(end.block.text, ANSWER)
})

await check('parses DSML tool calls into harness blocks and finishes with tool-calls', async () => {
  const adapter = makeAdapter()
  const tools = [
    {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
    },
    {
      name: 'read',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' } }, required: ['file_path'] },
    },
  ]
  const chunks = await collect(adapter.stream({ provider: 'ctu-portal', model: 'TOOLS', messages: history, tools }))
  const textEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(textEnd.block.text.trim(), "I'll inspect the project.")
  const calls = chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, 'bash')
  assert.deepEqual(JSON.parse(calls[0].arguments), { description: 'List files', command: 'pwd && ls -la' })
  assert.equal(calls[1].name, 'read')
  assert.deepEqual(JSON.parse(calls[1].arguments), { file_path: '/tmp/example.txt', offset: 3 })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const message = assembler.message({ provider: 'ctu-portal', model: 'cityu-gpt5' })
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[1].type, 'tool-call')
  assert.equal(message.content[2].type, 'tool-call')
  assert.equal(assembler.finish.kind, 'tool-calls')
})

await check('buildQuestion includes the tool catalog and correlates calls with results', async () => {
  const question = buildQuestion({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Audit this project.' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
      ] },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '/tmp/project' }] },
    ],
    tools: [{
      name: 'bash',
      description: 'Run a shell command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
  }, { includeSystemPrompt: false, maxQuestionChars: 24000, maxToolResultChars: 2000 })
  assert.match(question, /^You can use the tools below/u)
  assert.match(question, /- bash\(command\*:string\): Run a shell command\./u)
  assert.match(question, /Assistant: Let me look\./u)
  assert.match(question, /Assistant tool call bash \(call-1\):\n\{"command":"pwd"\}/u)
  assert.match(question, /Tool result \(bash, call-1\):\n\/tmp\/project/u)

  const capped = buildQuestion({
    messages: [
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'A'.repeat(500) + 'TAIL' }] },
    ],
  }, { includeSystemPrompt: false, maxQuestionChars: 24000, maxToolResultChars: 80 })
  assert.match(capped, /truncated \d+ characters/u)
  assert.ok(capped.endsWith('TAIL'), 'the end of a tool result survives')
})

await check('extractToolCalls handles ASCII markers and raw JSON values', () => {
  const parsed = extractToolCalls('Checking.\n<|DSML|tool_calls><|DSML|invoke name="grep"><|DSML|parameter name="pattern" string="true">foo</|DSML|parameter><|DSML|parameter name="include" string="false">null</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>')
  assert.equal(parsed.text, 'Checking.')
  assert.deepEqual(parsed.calls, [{ name: 'grep', arguments: { pattern: 'foo', include: null } }])
  assert.deepEqual(extractToolCalls('no calls here'), { text: 'no calls here', calls: [] })
})

await check('coerceArguments follows the tool schema', () => {
  const args = coerceArguments({ timeoutMs: '5000', command: '123' }, {
    parameters: { properties: { timeoutMs: { type: 'number' }, command: { type: 'string' } } },
  })
  assert.deepEqual(args, { timeoutMs: 5000, command: '123' })
})

await check('a plain-text portal refusal fails CONTENT_REFUSED', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'REFUSALTEXT', messages: history })),
    (error) => {
      const failure = failureOf(error)
      assert.equal(failure.code, 'CONTENT_REFUSED')
      assert.match(failure.message, /refused to answer/iu)
      return true
    },
  )
})

await check('a framed portal refusal also fails CONTENT_REFUSED', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'REFUSALFRAMED', messages: history })),
    (error) => failureOf(error).code === 'CONTENT_REFUSED',
  )
})

await check('the one-active-session guard fails INVALID_REQUEST and clears the claim', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'CONFLICT', messages: history })),
    (error) => {
      const failure = failureOf(error)
      assert.equal(failure.code, 'INVALID_REQUEST')
      assert.match(failure.message, /active chatbot session/iu)
      return true
    },
  )
  assert.equal(adapter.claimedSessionId, undefined, 'the next turn reopens the conversation')
})

await check('the portal\'s length guard fails CONTEXT_WINDOW_EXCEEDED', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'TOOLONG', messages: history })),
    (error) => failureOf(error).code === 'CONTEXT_WINDOW_EXCEEDED',
  )
})

await check('an answer without the conversation-id frame fails MALFORMED_RESPONSE', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'NOPREFIX', messages: history })),
    (error) => failureOf(error).code === 'MALFORMED_RESPONSE',
  )
})

await check('catalog exposes every model with text-only input', async () => {
  const adapter = makeAdapter()
  const models = await adapter.listModels('ctu-portal')
  assert.equal(models.length, 4)
  for (const model of models) {
    assert.equal(model.provider, 'ctu-portal')
    assert.deepEqual(model.inputModalities, ['text'])
    assert.ok(model.name.length > 0)
  }
  const resolved = await adapter.resolveModel('ctu-portal', 'ctu-dsv4')
  assert.equal(resolved.id, 'ctu-dsv4')
  assert.equal(resolved.name, 'DeepSeek V4 Flash')
  assert.deepEqual(resolved.context, { contextWindow: 4000 })
})

await check('prepareCall binds model metadata and stream', async () => {
  const adapter = makeAdapter()
  const prepared = await adapter.prepareCall('ctu-portal', 'ctu-qwen38')
  assert.equal(prepared.model.id, 'ctu-qwen38')
  const chunks = await collect(prepared.stream({ provider: 'ctu-portal', model: 'ctu-qwen38', messages: history }))
  assert.equal(chunks.at(-1).type, 'finish')
})

await check('reads quota from the same chatbot module', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  const reading = await adapter.readQuota('GPT')
  assert.equal(reading.quota, 15000)
  assert.equal(reading.quotaLeft, 14500)
  assert.equal(seen.at(-1).path, '/chatbot/getusage')
  assert.equal(seen.at(-1).body.model, 'GPT')
  assert.equal(seen.at(-1).body.style, '1')
  assert.equal(seen.at(-1).body.sessionOnly, false)
})

await check('a disclaimer is reported, not accepted silently', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'DISCLAIMER', messages: history })),
    (error) => {
      const failure = failureOf(error)
      assert.equal(failure.code, 'INVALID_REQUEST')
      assert.match(failure.message, /disclaimer/iu)
      return true
    },
  )
  assert.ok(!seen.some(entry => entry.path.endsWith('/agreeandproceed')), 'no silent consent by default')
})

await check('acceptDisclaimer acknowledges and opens the conversation', async () => {
  seen.length = 0
  const adapter = makeAdapter({ acceptDisclaimer: true })
  const chunks = await collect(adapter.stream({ provider: 'ctu-portal', model: 'DISCLAIMER', messages: history }))
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, ANSWER)
  // The portal keeps answering `showdisclaimer` on getchathistory even after
  // the acknowledgement; the page does not re-read history, and neither do we.
  assert.deepEqual(
    seen.map(entry => entry.path.split('/').at(-1)),
    ['getchathistory', 'agreeandproceed', 'getchatresponse'],
  )
})

await check('a new user record is created after consent', async () => {
  seen.length = 0
  const adapter = makeAdapter({ acceptDisclaimer: true })
  const chunks = await collect(adapter.stream({ provider: 'ctu-portal', model: 'NEWUSER', messages: history }))
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, ANSWER)
  assert.ok(seen.some(entry => entry.path.endsWith('/createnewuser')))
})

await check('missing cookie fails MISSING_CREDENTIAL', async () => {
  const adapter = new CtuPortalAdapter(resolveOptions({ baseURL, cookieEnv: 'CTU_TEST_ABSENT_COOKIE' }))
  delete process.env.CTU_TEST_ABSENT_COOKIE
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history })),
    (error) => failureOf(error).code === 'MISSING_CREDENTIAL',
  )
})

await check('env cookie is honored', async () => {
  process.env.CTU_TEST_PRESENT_COOKIE = 'ENVCOOKIE=1'
  seen.length = 0
  const adapter = new CtuPortalAdapter(resolveOptions({ baseURL, cookieEnv: 'CTU_TEST_PRESENT_COOKIE' }))
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', messages: history }))
  assert.equal(seen[0].cookie, 'ENVCOOKIE=1')
  delete process.env.CTU_TEST_PRESENT_COOKIE
})

await check('401 on the session handshake fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'AUTHFAIL', messages: history })),
    (error) => { const f = failureOf(error); assert.equal(f.status, 401); return f.code === 'INVALID_CREDENTIAL' },
  )
})

await check('AccessDenied status fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'DENIED', messages: history })),
    (error) => {
      const f = failureOf(error)
      assert.match(f.message, /denied access/iu)
      return f.code === 'INVALID_CREDENTIAL'
    },
  )
})

await check('a session handshake refusal names the status', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'REFUSED', messages: history })),
    (error) => {
      const f = failureOf(error)
      assert.match(f.message, /status "fail"/u)
      assert.match(f.message, /Close the chatbot/iu)
      return f.code === 'INVALID_REQUEST'
    },
  )
})

await check('a session conflict names the active session and the remedy', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'CONFLICT', messages: history })),
    (error) => {
      const f = failureOf(error)
      assert.match(f.message, /active chatbot session/iu)
      assert.match(f.message, /Close the chatbot/iu)
      return f.code === 'INVALID_REQUEST'
    },
  )
})

await check('empty answer fails EMPTY_RESPONSE', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'EMPTY', messages: history })),
    (error) => failureOf(error).code === 'EMPTY_RESPONSE',
  )
})

await check('login page on getchatresponse fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'HTML', messages: history })),
    (error) => failureOf(error).code === 'INVALID_CREDENTIAL',
  )
})

await check('login page on the session handshake fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'HTMLSESSION', messages: history })),
    (error) => failureOf(error).code === 'INVALID_CREDENTIAL',
  )
})

await check('SSO redirect fails INVALID_CREDENTIAL', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'REDIRECT', messages: history })),
    (error) => failureOf(error).code === 'INVALID_CREDENTIAL',
  )
})

await check('deadline fails TIMEOUT', async () => {
  const adapter = makeAdapter({ requestTimeoutMs: 200 })
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'SLOW', messages: history })),
    (error) => failureOf(error).code === 'TIMEOUT',
  )
})

await check('caller abort fails ABORTED', async () => {
  const adapter = makeAdapter({ requestTimeoutMs: 60000 })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(
    () => collect(adapter.stream({ provider: 'ctu-portal', model: 'SLOW', messages: history, signal: controller.signal })),
    (error) => failureOf(error).code === 'ABORTED',
  )
})

await check('buildQuestion compacts older actions and keeps the latest exchange', async () => {
  const tools = [{
    name: 'bash',
    description: 'Run a shell command.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  }]
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Audit this project.' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'A'.repeat(2000) }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"pwd"}' }] },
    { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'B'.repeat(2000) }] },
  ]
  const settings = {
    includeSystemPrompt: false,
    maxQuestionChars: 4000,
    maxToolResultChars: 2000,
    maxToolResultTotalChars: 600,
  }
  const question = buildQuestion({ messages, tools }, settings)
  assert.ok(question.length <= settings.maxQuestionChars, 'stays within the prompt cap')
  assert.ok(question.startsWith('You can use the tools below'), 'tool catalog is kept')
  assert.match(question, /\[earlier conversation compacted\]/u)
  assert.match(question, /Audit this project/u, 'the task is kept')
  assert.match(question, /Assistant tool call bash \(c2\)/u, 'the latest call is kept')
  assert.match(question, /Tool result \(bash, c2\)/u, 'the latest result is kept')
  assert.match(question, /B{100}/u, 'the latest result has its head')
})

await check('caps the forwarded system prompt', async () => {
  const question = buildQuestion({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'S'.repeat(5000) + 'TAIL-MARKER' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Audit.' }] },
    ],
  }, { includeSystemPrompt: true, maxQuestionChars: 12000, maxSystemPromptChars: 200 })
  assert.match(question, /^System: S{100}/u)
  assert.match(question, /\[system prompt truncated\]/u)
  assert.ok(!question.includes('TAIL-MARKER'), 'the tail beyond the cap is omitted')
})

await check('synthesizes session titles without touching the portal', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  const chunks = await collect(adapter.stream({
    provider: 'ctu-portal',
    model: 'ctu-dsv4',
    purpose: 'session-title',
    messages: [{ role: 'user', content: [{ type: 'text', text: '# Audit the fcitx5 IME\nmore detail' }] }],
  }))
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'Audit the fcitx5 IME')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(seen, [], 'no portal request for an auxiliary call')
})

await check('compacts locally without touching the portal', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  const chunks = await collect(adapter.stream({
    provider: 'ctu-portal',
    model: 'ctu-dsv4',
    purpose: 'compaction',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Audit this project.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }] },
    ],
  }))
  const text = chunks.find(c => c.type === 'block-end').block.text
  assert.match(text, /Compacted conversation/u)
  assert.match(text, /Audit this project/u)
  assert.deepEqual(seen, [], 'no portal request for an auxiliary call')
})

await check('keeps a separate portal conversation per DSH session', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', sessionId: 's1', messages: history }))
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', sessionId: 's2', messages: history }))
  await collect(adapter.stream({ provider: 'ctu-portal', model: 'ctu-gpt5', sessionId: 's1', messages: history }))
  const opens = seen.filter(entry => entry.path.endsWith('/getchathistory'))
  const chats = seen.filter(entry => entry.path.endsWith('/getchatresponse'))
  assert.equal(opens.length, 3, 'switching sessions reopens the conversation')
  assert.notEqual(opens[0].body.id, opens[1].body.id, 'different DSH sessions get different portal ids')
  assert.equal(opens[2].body.id, opens[0].body.id, 'returning to a session reuses its portal id')
  assert.equal(chats[0].body.id, opens[0].body.id)
  assert.equal(chats[1].body.id, opens[1].body.id)
  assert.equal(chats[2].body.id, opens[0].body.id)
})

await check('retries once with a smaller prompt after a length warning', async () => {
  seen.length = 0
  const adapter = makeAdapter()
  const chunks = await collect(adapter.stream({
    provider: 'ctu-portal',
    model: 'TOOLONG_ONCE',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A'.repeat(8000) }] }],
  }))
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, ANSWER)
  const chats = seen.filter(entry => entry.path.endsWith('/getchatresponse'))
  assert.equal(chats.length, 2, 'the adapter retried the request')
  assert.ok(chats[1].body.qst.length < chats[0].body.qst.length, 'the retry prompt is smaller')
})

await check('classifies quota and rate-limit text', async () => {
  for (const [model, code] of [['QUOTA', 'ACCOUNT_QUOTA'], ['RATELIMIT', 'RATE_LIMIT']]) {
    const adapter = makeAdapter()
    await assert.rejects(
      () => collect(adapter.stream({ provider: 'ctu-portal', model, messages: history })),
      (error) => failureOf(error).code === code,
    )
  }
})

await check('publishes a bounded transient retry policy', async () => {
  const policy = makeAdapter().providerRetryPolicy()
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 2)
  assert.ok(policy.retryableCodes.includes('RATE_LIMIT'))
  assert.ok(policy.retryableCodes.includes('SERVER'))
  assert.ok(policy.retryableCodes.includes('TIMEOUT'))
})

await check('forwards the system prompt and trims catalog descriptions', async () => {
  assert.equal(resolveOptions({}).includeSystemPrompt, true)
  assert.equal(resolveOptions({ includeSystemPrompt: false }).includeSystemPrompt, false)
  const optionSet = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM-RULES' }] },
      { role: 'user', content: [{ type: 'text', text: 'Audit.' }] },
    ],
    tools: [{
      name: 'bash',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, mode: { type: 'string', enum: ['fast', 'slow'] } },
        required: ['command'],
      },
    }],
  }
  const withSystem = buildQuestion(optionSet, { includeSystemPrompt: true, maxQuestionChars: 12000, maxToolResultChars: 2000 })
  assert.match(withSystem, /^System: SYSTEM-RULES/u)
  assert.match(withSystem, /- bash\(command\*:string, mode:string\(fast\|slow\)\)/u)
  assert.ok(!withSystem.includes('Run a shell command'), 'descriptions are omitted when the system prompt carries them')
  const withoutSystem = buildQuestion(optionSet, { includeSystemPrompt: false, maxQuestionChars: 12000, maxToolResultChars: 2000 })
  assert.ok(!withoutSystem.startsWith('System:'))
  assert.match(withoutSystem, /: Run a shell command\./u)
})

await check('streams a tool marker split across chunks', async () => {
  const adapter = makeAdapter()
  const tools = [{ name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }]
  const chunks = await collect(adapter.stream({ provider: 'ctu-portal', model: 'TOOLS_SPLIT', messages: history, tools }))
  const text = chunks.find(c => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(text.block.text.trim(), "I'll inspect the project.")
  assert.equal(chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').length, 2)
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
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
