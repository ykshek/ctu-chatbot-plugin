/**
 * Live-portal verification for the portal adapter.
 *
 * Instantiates the REAL `CtuPortalAdapter` and drives its `stream()` method
 * end-to-end against the live portal, using the session cookie from the
 * CTU_PORTAL_COOKIE environment variable. This confirms the `chatbot` module
 * transport (getchathistory session handshake + framed getchatresponse) works
 * from the host process, and that the answer is not the portal's canned IT
 * Service Desk fallback (which a non-empty-text check would wrongly accept).
 *
 * Run:  CTU_PORTAL_COOKIE='<cookie header>' node verify-live-portal.mjs
 *
 * Note: makes one real chat request (consumes a little quota, opens a
 * conversation on the portal).
 */

import { CtuPortalAdapter } from './ctu-chatbot-plugin/lib/adapter.js'
import { resolveOptions } from './ctu-chatbot-plugin/lib/config.js'

// Defaults supply the endpoint, context window, deadlines, and the quota
// endpoint, so this stays correct as options are added.
const adapter = new CtuPortalAdapter(resolveOptions({
  cookieEnv: 'CTU_PORTAL_COOKIE', // cookie stays empty, so it is read from the environment
}))

console.log('adapter.sessionId (should be a UUID):', adapter.sessionId)

const options = {
  signal: AbortSignal.timeout(90000),
  model: 'ctu-dsv4', // -> wire "DSV4"
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello, what time is it?' }] },
  ],
}

console.log('Streaming an answer from the live portal...')
let answer = ''
let chunks = 0
try {
  for await (const block of adapter.stream(options)) {
    if (block.type === 'text-delta') {
      answer += block.text
      chunks++
    }
  }
} catch (err) {
  console.error('stream FAILED:', err.constructor.name, err.message)
  process.exit(1)
}

console.log('stream: OK')
console.log('chunks:', chunks)
console.log('answer length:', answer.length)
console.log('answer (first 800 chars):')
console.log(answer.slice(0, 800))
console.log('')

if (answer.trim() === '') {
  console.error('FAIL: the portal returned an empty answer')
  process.exit(1)
}
if (/很抱歉[，,]\s*我(?:無法|无法)提供你(?:問題|问题)的答案/iu.test(answer)) {
  console.error('FAIL: the portal returned its IT Service Desk fallback, not a model answer')
  process.exit(1)
}
if (answer.includes(',,,')) {
  console.error('FAIL: the conversation-id frame leaked into the answer')
  process.exit(1)
}

console.log('ADAPTER LIVE VERIFICATION: SUCCESS')
process.exit(0)
