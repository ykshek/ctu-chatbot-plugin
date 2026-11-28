/**
 * HTTP transport for the CityUHK portal's proprietary chatbot protocol.
 *
 * Verified against the portal's own widget (`/portal/js/kb-chatbot.js`):
 *
 *   POST {base}/startnewconversation   { id, model }            -> JSON status
 *   POST {base}/getchatresponse        { id, model, qst }      -> text/plain stream
 *
 * There is no OpenAI-compatible surface: the body is a single plain-text
 * `qst`, the reply is raw markdown streamed as a (gzip) `text/plain` body, and
 * authentication is the portal's browser session cookie rather than an API
 * key. The portal tracks one active conversation per signed-in user, so every
 * call first claims the conversation with the adapter's own `id`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CityuPortalError } from './errors.js'

const PRODUCT = 'deepseek-harness'
const HOME_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/**
 * The harness version, read from the installation manifest when the process
 * exposes its install directory. Kept local so the bundle imports no DSH
 * package at runtime; a missing directory degrades the User-Agent to the
 * product token alone rather than failing the request.
 * @returns {string | undefined}
 */
function harnessVersion() {
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir !== 'string' || installDir === '') return undefined
  try {
    const manifest = /** @type {{ version?: unknown }} */ (JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
  } catch (_unreadableManifest) {
    return undefined
  }
}

const VERSION = harnessVersion()

/**
 * RFC 9110 product token appended by a launching app, mirroring
 * `DSH_USER_AGENT_SUFFIX` handling in `dsh-llm/src/attribution.ts`.
 * @returns {string | undefined}
 */
function launchSuffix() {
  const value = process.env.DSH_USER_AGENT_SUFFIX
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The attribution `user-agent` header every provider request must carry.
 * Mirrors `attributionHeaders()` from `@deepseek-ai/dsh-llm`.
 * @returns {Record<string, string>}
 */
export function attributionHeaders() {
  const base = VERSION === undefined ? PRODUCT : `${PRODUCT}/${VERSION}`
  const suffix = launchSuffix()
  return {
    'user-agent': `${base} (+${HOME_URL})${suffix === undefined ? '' : ` ${suffix}`}`,
  }
}

/**
 * Accept a raw `Cookie` header value, a `Cookie:`-prefixed paste, or the value
 * copied from a browser's request headers.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeCookie(raw) {
  const value = raw.trim()
  if (value === '') return ''
  return value.replace(/^cookie\s*:\s*/iu, '').trim()
}

/**
 * Claim the single active portal conversation for this adapter id.
 * @param {object} request
 * @param {string} request.baseURL
 * @param {string} request.cookie
 * @param {string} request.id
 * @param {string} request.model
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<void>}
 */
export async function startNewConversation({ baseURL, cookie, id, model, signal }) {
  const response = await fetch(`${baseURL}/startnewconversation`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      ...attributionHeaders(),
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({ id, model }),
  })
  const text = await response.text()
  if (!response.ok) throw httpFailure(response.status, text)
  if (looksLikeLoginPage(response, text)) throw loginPageFailure()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new CityuPortalError(
      'CityUHK portal returned a non-JSON session response',
      'MALFORMED_RESPONSE',
      { status: response.status, cause },
    )
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.status !== 'success') {
    throw sessionFailure(parsed, text)
  }
}

/**
 * Stream the portal's answer text.
 * @param {object} request
 * @param {string} request.baseURL
 * @param {string} request.cookie
 * @param {string} request.id
 * @param {string} request.model
 * @param {string} request.qst
 * @param {AbortSignal} [request.signal]
 * @returns {AsyncGenerator<string, void, void>}
 */
export async function* chatStream({ baseURL, cookie, id, model, qst, signal }) {
  const response = await fetch(`${baseURL}/getchatresponse`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      ...attributionHeaders(),
      accept: 'text/plain, */*',
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({ id, model, qst }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw httpFailure(response.status, text)
  }
  if (looksLikeLoginPage(response, '')) throw loginPageFailure()
  if (response.body === null) {
    throw new CityuPortalError(
      'CityUHK portal returned no response body',
      'EMPTY_RESPONSE',
      { status: response.status },
    )
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const text = decoder.decode(value, { stream: true })
      if (text !== '') yield text
    }
    const tail = decoder.decode()
    if (tail !== '') yield tail
  } finally {
    try {
      await reader.cancel()
    } catch (_alreadyClosed) {
      // The body settled before cancellation; nothing left to release.
    }
  }
}

/**
 * Read the signed-in account's quota for one model.
 *
 * The portal reports quota per model, not per account: `model` selects which
 * one, and the answer carries that model's allowance (`quota`) and what is left
 * (`quotaLeft`). This is the same request the portal's own dashboard widget
 * issues, so it needs the same browser session cookie as a chat call.
 * @param {object} request
 * @param {string} request.baseURL - root of the `chatbot` module, not `kbchatbot`.
 * @param {string} request.cookie
 * @param {string} request.model - wire model key, or `LAST` for the most recent one.
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getUsage({ baseURL, cookie, model, signal }) {
  const response = await fetch(`${baseURL}/getusage`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      ...attributionHeaders(),
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie,
    },
    // `getusage` ignores the conversation fields; the widget sends its own
    // option object, and `id` may stay empty because no conversation is read.
    body: JSON.stringify({ id: '', model, style: '1', sessionOnly: false, qst: 'Hi' }),
  })
  const text = await response.text()
  if (!response.ok) throw httpFailure(response.status, text)
  if (looksLikeLoginPage(response, text)) throw loginPageFailure()
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new CityuPortalError(
      'CityUHK portal returned a non-JSON quota response',
      'MALFORMED_RESPONSE',
      { status: response.status, cause },
    )
  }
}

/**
 * Detect the sign-in page an unauthenticated request is bounced to. The portal
 * API answers JSON/text; HTML means the session cookie went stale and the
 * request followed the SSO flow instead.
 * @param {Response} response
 * @param {string} body
 * @returns {boolean}
 */
function looksLikeLoginPage(response, body) {
  const contentType = response.headers.get('content-type') ?? ''
  if (/text\/html/iu.test(contentType)) return true
  return /<!doctype html|<html[\s>]/iu.test(body.slice(0, 512))
}

/**
 * Detect the portal's edge filter (Incapsula) block page. It answers HTML with
 * an incident id even for API calls, so a stale or filtered cookie looks like a
 * generic failure unless it is named: the fix is a fresh Cookie header, not a
 * retry and not a server-error report.
 * @param {string} body
 * @returns {boolean}
 */
function looksLikeBlockPage(body) {
  return /incident_id|_incapsula_resource/iu.test(body.slice(0, 4096))
}

/** @returns {CityuPortalError} */
function loginPageFailure() {
  return new CityuPortalError(
    'CityUHK portal returned its sign-in page instead of a chatbot answer. '
    + 'The session cookie is missing or expired; sign in to the portal again and copy a fresh Cookie header value.',
    'INVALID_CREDENTIAL',
  )
}

/**
 * Classify an HTTP failure into a harness failure code.
 * @param {number} status
 * @param {string} body
 * @returns {CityuPortalError}
 */
function httpFailure(status, body) {
  const detail = body.trim().slice(0, 300)
  const suffix = detail === '' ? '' : `: ${detail}`
  if (status === 401 || status === 403) {
    if (looksLikeBlockPage(body)) {
      return new CityuPortalError(
        'CityUHK portal\'s edge filter blocked the request. Sign in to the portal again and '
        + 'paste a fresh Cookie header value, including the incap_ses_* and reese84 cookies.',
        'INVALID_CREDENTIAL',
        { status },
      )
    }
    return new CityuPortalError(
      'CityUHK portal rejected the session cookie. Sign in to the portal again and copy a fresh Cookie header value.',
      'INVALID_CREDENTIAL',
      { status },
    )
  }
  if (status === 429) {
    return new CityuPortalError(
      `CityUHK portal is rate limiting requests (HTTP 429)${suffix}`,
      'RATE_LIMIT',
      { status },
    )
  }
  if (status >= 500) {
    return new CityuPortalError(
      `CityUHK portal failed (HTTP ${status})${suffix}`,
      'SERVER',
      { status },
    )
  }
  return new CityuPortalError(
    `CityUHK portal rejected the request (HTTP ${status})${suffix}`,
    'INVALID_REQUEST',
    { status },
  )
}

/**
 * The portal reports an expired or unauthorized session as a 200 JSON status
 * rather than an HTTP 401. Name it so the harness offers the credential fix
 * instead of the generic refusal text.
 * @param {unknown} parsed
 * @returns {CityuPortalError | undefined}
 */
function accessDeniedFailure(parsed) {
  const status = typeof parsed?.status === 'string' ? parsed.status : ''
  if (!/^accessdenied$/iu.test(status)) return undefined
  return new CityuPortalError(
    'CityUHK portal denied access to the chatbot. Sign in to the portal again and copy a fresh Cookie header value.',
    'INVALID_CREDENTIAL',
  )
}

/**
 * Explain why the portal would not start a conversation, calling out the
 * one-active-session rule that is the usual cause.
 * @param {unknown} parsed
 * @param {string} body
 * @returns {CityuPortalError}
 */
function sessionFailure(parsed, body) {
  const denied = accessDeniedFailure(parsed)
  if (denied !== undefined) return denied

  const status = typeof parsed?.status === 'string' && parsed.status !== '' ? parsed.status : undefined
  const detail = typeof parsed?.errorMsg === 'string' ? parsed.errorMsg.trim() : ''

  if (detail !== '' && /another active|close all other|active chatbot session/iu.test(detail)) {
    return new CityuPortalError(
      'CityUHK portal already has an active chatbot session for this account. '
      + 'Close the portal chatbot in your browser (or sign out of other devices) and retry.',
      'INVALID_REQUEST',
    )
  }

  const reason = detail !== ''
    ? detail
    : status !== undefined
      ? `the portal returned status "${status}"`
      : `the portal returned an unrecognized response (${body.trim().slice(0, 200)})`
  return new CityuPortalError(
    `CityUHK portal could not start a conversation: ${reason}. `
    + 'Close the portal chatbot in any other browser tab and retry; if it still fails, '
    + 'sign in to the portal again and paste a fresh Cookie header value.',
    'INVALID_REQUEST',
  )
}
