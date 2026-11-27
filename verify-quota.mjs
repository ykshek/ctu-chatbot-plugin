/**
 * Local verification for the quota/usage changes (not shipped, not in git).
 *
 * Exercises the real adapter against a mock portal:
 *   - `stream()` emits an estimated `usage` chunk before the terminal finish;
 *   - `readQuota()` / `readAllQuotas()` shape the portal payload;
 *   - the credential reader supplies the cookie when config has none;
 *   - a missing cookie fails with MISSING_CREDENTIAL.
 */

import { createServer } from 'node:http'
import { CityuPortalAdapter } from './ctu-chatbot-plugin/lib/adapter.js'
import { resolveOptions } from './ctu-chatbot-plugin/lib/config.js'

const QUOTAS = { GPTmini: 45000, GPT: 15000, DSV4: 90000, QWen38: 90000 }

const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const url = req.url ?? ''
    if (url.endsWith('/kbchatbot/startnewconversation')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'success' }))
      return
    }
    if (url.endsWith('/kbchatbot/getchatresponse')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('Hello ')
      res.end('from the mock portal.')
      return
    }
    if (url.endsWith('/chatbot/getusage')) {
      const { model } = JSON.parse(body || '{}')
      const key = model === 'LAST' ? 'DSV4' : model
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: Object.keys(QUOTAS).map(wire => ({
          modelValue: wire,
          modelName: wire,
          lastUsed: wire === 'DSV4',
        })),
        quota: QUOTAS[key] ?? 0,
        quotaLeft: (QUOTAS[key] ?? 0) - 500,
        nextQuotaUpdate: '2026-12-21T00:00:00',
        lastWordsConsumption: 1680,
      }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = /** @type {{ port: number }} */ (server.address())
const base = `http://127.0.0.1:${port}`
const quotaBase = `http://127.0.0.1:${port}/chatbot`

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// 1. Usage chunk from a chat call.
{
  const adapter = new CityuPortalAdapter(resolveOptions({ baseURL: `${base}/kbchatbot`, quotaBaseURL: quotaBase, cookie: 'a=b' }))
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'cityu-dsv4', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }] })) {
    chunks.push(chunk)
  }
  const usageIndex = chunks.findIndex(c => c.type === 'usage')
  const finishIndex = chunks.findIndex(c => c.type === 'finish')
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  console.log('1. stream usage chunk')
  check('usage chunk emitted', usageIndex >= 0, chunks.map(c => c.type))
  check('usage precedes finish', usageIndex >= 0 && finishIndex > usageIndex, { usageIndex, finishIndex })
  const usage = usageIndex >= 0 ? chunks[usageIndex].usage : undefined
  check('input tokens estimated', Number.isInteger(usage?.inputTokens) && usage.inputTokens > 0, usage)
  check('output tokens estimated', Number.isInteger(usage?.outputTokens) && usage.outputTokens > 0, usage)
  check('total is the sum', usage?.totalTokens === usage?.inputTokens + usage?.outputTokens, usage)
  check('answer text intact', text === 'Hello from the mock portal.', text)
}

// 2. One model's quota.
{
  const adapter = new CityuPortalAdapter(resolveOptions({ baseURL: `${base}/kbchatbot`, quotaBaseURL: quotaBase, cookie: 'a=b' }))
  const reading = await adapter.readQuota('GPT')
  console.log('2. readQuota')
  check('quota read', reading.quota === 15000, reading.quota)
  check('quotaLeft read', reading.quotaLeft === 14500, reading.quotaLeft)
  check('reset date kept as the portal wrote it', reading.nextQuotaUpdate === '2026-12-21', reading.nextQuotaUpdate)
  check('catalog carried', reading.catalog.length === 4, reading.catalog)
  check('lastUsed resolved', reading.lastUsedModel === 'DSV4', reading.lastUsedModel)
  check('not unlimited', reading.unlimited === false, reading.unlimited)
}

// 3. Every model's quota.
{
  const adapter = new CityuPortalAdapter(resolveOptions({ baseURL: `${base}/kbchatbot`, quotaBaseURL: quotaBase, cookie: 'a=b', quotaCacheMs: 1000 }))
  const answer = await adapter.readAllQuotas()
  console.log('3. readAllQuotas')
  const wires = Object.keys(answer.readings)
  check('four readings', wires.length === 4, wires)
  check('per-model values differ', answer.readings.GPT.quota === 15000 && answer.readings.DSV4.quota === 90000,
    { GPT: answer.readings.GPT.quota, DSV4: answer.readings.DSV4.quota })
  check('catalog from the response', answer.models.length === 4, answer.models)
}

// 4. Cookie from the credential reader (bundle page path).
{
  let reads = 0
  const adapter = new CityuPortalAdapter(
    resolveOptions({ baseURL: `${base}/kbchatbot`, quotaBaseURL: quotaBase }),
    { credentialReader: async () => { reads += 1; return 'stored=1' } },
  )
  const reading = await adapter.readQuota('GPTmini')
  console.log('4. credential reader')
  check('reader consulted', reads > 0, reads)
  check('quota read through stored cookie', reading.quota === 45000, reading.quota)
}

// 5. No cookie anywhere.
{
  const adapter = new CityuPortalAdapter(resolveOptions({ baseURL: `${base}/kbchatbot`, quotaBaseURL: quotaBase, cookieEnv: 'CTU_VERIFY_ABSENT' }))
  console.log('5. missing credential')
  try {
    await adapter.readQuota('GPT')
    check('throws when unconfigured', false)
  } catch (error) {
    check('throws MISSING_CREDENTIAL', error.code === 'MISSING_CREDENTIAL', error.code)
    check('message names the bundle page', /Plugins → Installed plugins → CityUHK portal chatbot/u.test(error.message), error.message.slice(0, 140))
  }
}

server.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
