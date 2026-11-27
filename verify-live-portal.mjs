/**
 * Live-portal verification for the CityUHK portal adapter.
 *
 * Instantiates the REAL `CityuPortalAdapter` and drives its `stream()` method
 * end-to-end against the live portal, using the session cookie from the
 * CITYU_PORTAL_COOKIE environment variable. This confirms the adapter's
 * transport (startNewConversation + chatStream) works from the host process,
 * including the UUID conversation id the portal requires.
 *
 * Run:  CITYU_PORTAL_COOKIE='<cookie header>' node verify-live-portal.mjs
 *
 * Note: makes one real chat request (consumes a little quota, opens a
 * conversation on the portal).
 */

import { CityuPortalAdapter } from './ctu-chatbot-plugin/lib/adapter.js'
import { resolveOptions } from './ctu-chatbot-plugin/lib/config.js'

// Defaults supply the endpoint, context window, deadlines, and the quota
// endpoint, so this stays correct as options are added.
const adapter = new CityuPortalAdapter(resolveOptions({
  cookieEnv: 'CITYU_PORTAL_COOKIE', // cookie stays empty, so it is read from the environment
}))

console.log('adapter.sessionId (should be a UUID):', adapter.sessionId)

const options = {
  signal: AbortSignal.timeout(90000),
  model: 'cityu-dsv4', // -> wire "DSV4"
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
console.log('ADAPTER LIVE VERIFICATION: SUCCESS')
process.exit(0)
