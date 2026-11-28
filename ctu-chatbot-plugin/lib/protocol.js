/**
 * HTTP transport for the portal's GenAI chatbot protocol.
 *
 * Verified against the portal's own module (`/portal/modules/chatbot/mod-chatbot.js`):
 *
 *   POST {base}/getchathistory    { id, model, style, sessionOnly, qst: "newSession" }
 *   POST {base}/agreeandproceed   same body
 *   POST {base}/createnewuser     same body
 *   POST {base}/getchatresponse   { id, model, style, sessionOnly, qst } -> text/plain
 *   POST {base}/getusage          { id: "", model, style, sessionOnly, qst: "Hi" }
 *
 * The answer stream is framed as `<conversation-id>,,,<markdown>`; this module
 * strips the prefix and hands the harness only the markdown. The portal keeps
 * one active conversation per signed-in account, so the adapter opens its
 * session with `getchathistory` before the first question and then reuses the
 * id. A first-time account may be asked to accept the portal's GenAI
 * disclaimer (`status: "showdisclaimer"`) before the conversation starts.
 *
 * The sibling `/portal/api/module/kbchatbot` module speaks a similar-looking
 * `{ id, model, qst }` protocol, but it is the legacy IT knowledge-base widget:
 * it ignores the GenAI model names and answers out-of-scope questions with the
 * IT Service Desk fallback. The plugin must not send chat there.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CtuPortalError } from './errors.js'

const PRODUCT = 'deepseek-harness'
const HOME_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** Framing separator between the portal's conversation id and the answer. */
const ID_SEPARATOR = ',,,'

/** Safety cap on the conversation-id prefix; a UUID is 36 characters. */
const MAX_ID_CHARS = 1024

/** Answer characters held back before streaming, so a canned refusal is not shown as an answer. */
const REPLY_GUARD_CHARS = 512

/** The portal's IT knowledge-base fallback, returned when it will not answer. */
const PORTAL_REFUSAL = /^\s*(?:很抱歉[，,]\s*我(?:無法|无法)提供你(?:問題|问题)的答案)/u

/** The portal's one-active-conversation guard, returned as plain text. */
const ACTIVE_SESSION = /^\s*It seems you have another active Chatbot session/iu

/** A plain-text access-denied body returned instead of JSON. */
const ACCESS_DENIED_TEXT = /^\s*Access\s*denied\b/iu

/** The portal's plain-text length guard; it answers without the `,,,` frame. */
const MESSAGE_TOO_LONG = /(?:your|the)\s+message\s+is\s+too\s+long|reduce\s+the\s+length\s+of\s+your\s+message/iu

/** Plain-text account-quota or rate-limit warnings. */
const QUOTA_EXHAUSTED = /(?:quota|allowance|usage).{0,60}(?:exceed|reached|insufficient|not\s+enough|ran\s+out|used\s+up)|(?:exceed|reached|insufficient).{0,30}(?:quota|allowance)|額度|配額|用量已|超出/u
const RATE_LIMITED = /too\s+many\s+requests|rate\s+limit|slow\s+down/iu

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
 * Open (or re-open) the adapter's conversation on the portal.
 *
 * The portal's page does this with `getchathistory` and `qst: "newSession"`;
 * `startnewconversation` exists on the module too, but the page does not use it
 * to open a chat. A first-time account gets `showdisclaimer` or `newUser`
 * instead of `success`; the plugin accepts that gate only when the operator
 * opted in, because accepting a legal disclaimer is a human decision.
 * @param {object} request
 * @param {string} request.baseURL
 * @param {string} request.cookie
 * @param {string} request.id
 * @param {string} request.model
 * @param {string} request.style
 * @param {boolean} request.sessionOnly
 * @param {boolean} [request.acceptDisclaimer]
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function openConversation({
  baseURL,
  cookie,
  id,
  model,
  style,
  sessionOnly,
  acceptDisclaimer = false,
  signal,
}) {
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const { parsed, text } = await readHistory({ baseURL, cookie, id, model, style, sessionOnly, signal })
    const status = typeof parsed?.status === 'string' ? parsed.status : ''
    if (status === 'success') return parsed

    const denied = accessDeniedFailure(parsed)
    if (denied !== undefined) throw denied

    if (status === 'showdisclaimer') {
      // The portal keeps reporting `showdisclaimer` on `getchathistory` even
      // after the acknowledgement (it is the page's "show the modal" flag, not
      // a gate). Posting `agreeandproceed` is what enables the conversation;
      // do not expect the next history call to change status.
      if (!acceptDisclaimer) throw disclaimerFailure(status)
      await acknowledge({
        endpoint: 'agreeandproceed',
        baseURL,
        cookie,
        id,
        model,
        style,
        sessionOnly,
        signal,
      })
      return { ...parsed, status: 'success' }
    }

    if (status === 'newUser') {
      // A first-time account gets the disclaimer, then the page creates the
      // user record. Re-read the history afterwards so a following
      // `showdisclaimer` can be acknowledged too.
      if (!acceptDisclaimer) throw disclaimerFailure(status)
      if (attempt === 2) throw disclaimerFailure(status, true)
      await acknowledge({
        endpoint: 'createnewuser',
        baseURL,
        cookie,
        id,
        model,
        style,
        sessionOnly,
        signal,
      })
      continue
    }

    throw sessionFailure(parsed, text)
  }
  // The loop either returns, throws, or exhausts its attempts on a status the
  // portal keeps repeating; the last attempt throws above.
  throw disclaimerFailure('newUser', true)
}

/**
 * Read the portal's chat history and use its status as the session handshake.
 * @param {object} request
 * @returns {Promise<{ parsed: Record<string, unknown>, text: string }>}
 */
async function readHistory({ baseURL, cookie, id, model, style, sessionOnly, signal }) {
  const response = await fetch(`${baseURL}/getchathistory`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      ...attributionHeaders(),
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({ id, model, style, sessionOnly, qst: 'newSession' }),
  })
  const text = await response.text()
  if (!response.ok) throw httpFailure(response.status, text)
  if (looksLikeLoginPage(response, text)) throw loginPageFailure()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new CtuPortalError(
      'The portal returned a non-JSON session response',
      'MALFORMED_RESPONSE',
      { status: response.status, cause },
    )
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new CtuPortalError(
      'The portal returned an unrecognized session response',
      'MALFORMED_RESPONSE',
      { status: response.status },
    )
  }
  return { parsed, text }
}

/**
 * Post the disclaimer / new-user acknowledgement the portal's page sends.
 * @param {object} request
 * @param {'agreeandproceed' | 'createnewuser'} request.endpoint
 * @returns {Promise<void>}
 */
async function acknowledge({ endpoint, baseURL, cookie, id, model, style, sessionOnly, signal }) {
  const response = await fetch(`${baseURL}/${endpoint}`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      ...attributionHeaders(),
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({ id, model, style, sessionOnly, qst: 'newSession' }),
  })
  const text = await response.text()
  if (!response.ok) throw httpFailure(response.status, text)
  if (looksLikeLoginPage(response, text)) throw loginPageFailure()
  if (text.trim() === '') return
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (_notJson) {
    // The page ignores this response body; a non-JSON ack is not a failure.
    return
  }
  if (parsed !== null && typeof parsed === 'object'
    && typeof parsed.status === 'string' && parsed.status !== 'success') {
    throw sessionFailure(parsed, text)
  }
}

/**
 * Stream the portal's answer text, without the conversation-id frame.
 * @param {object} request
 * @param {string} request.baseURL
 * @param {string} request.cookie
 * @param {string} request.id
 * @param {string} request.model
 * @param {string} request.qst
 * @param {string} request.style
 * @param {boolean} request.sessionOnly
 * @param {AbortSignal} [request.signal]
 * @returns {AsyncGenerator<string, void, void>}
 */
export async function* chatStream({ baseURL, cookie, id, model, qst, style, sessionOnly, signal }) {
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
    body: JSON.stringify({ id, model, qst, style, sessionOnly }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw httpFailure(response.status, text)
  }
  if (looksLikeLoginPage(response, '')) throw loginPageFailure()
  if (response.body === null) {
    throw new CtuPortalError(
      'The portal returned no response body',
      'EMPTY_RESPONSE',
      { status: response.status },
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  /** Text received before the `,,,` frame resolves. */
  let untagged = ''
  let framed = false
  /** Answer prefix held back so the portal's canned refusal is never shown as an answer. */
  let guard = ''
  let guardOpen = true

  /**
   * Feed decoded text through the frame and refusal screens, yielding answer
   * text once it is safe to expose.
   * @param {string} text
   * @returns {Generator<string, void, void>}
   */
  function* feed(text) {
    if (text === '') return
    let rest = text
    if (!framed) {
      untagged += rest
      const separator = untagged.indexOf(ID_SEPARATOR)
      if (separator === -1) {
        if (untagged.length > MAX_ID_CHARS) throw unframedFailure(untagged)
        return
      }
      const conversationId = untagged.slice(0, separator).trim()
      if (conversationId === '') {
        throw new CtuPortalError(
          'The portal returned an empty conversation id before its answer',
          'MALFORMED_RESPONSE',
        )
      }
      rest = untagged.slice(separator + ID_SEPARATOR.length)
      untagged = ''
      framed = true
    }
    if (rest === '') return
    if (!guardOpen) {
      yield rest
      return
    }
    guard += rest
    if (PORTAL_REFUSAL.test(guard)) throw refusalFailure(guard)
    if (guard.length >= REPLY_GUARD_CHARS) {
      const ready = guard
      guard = ''
      guardOpen = false
      yield ready
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      yield* feed(decoder.decode(value, { stream: true }))
    }
    const tail = decoder.decode()
    if (tail !== '') yield* feed(tail)
  } finally {
    try {
      await reader.cancel()
    } catch (_alreadyClosed) {
      // The body settled before cancellation; nothing left to release.
    }
  }

  if (!framed) throw unframedFailure(untagged)
  if (guard !== '') {
    if (PORTAL_REFUSAL.test(guard)) throw refusalFailure(guard)
    yield guard
  }
}

/**
 * Read the signed-in account's quota for one model.
 *
 * Quota lives in the same `chatbot` module as chat and is reported per model:
 * `model` selects which one, and the answer carries that model's allowance
 * (`quota`) and what is left (`quotaLeft`). This is the same request the
 * portal's dashboard widget issues, so it needs the same browser session
 * cookie as a chat call.
 * @param {object} request
 * @param {string} request.baseURL - root of the `chatbot` module.
 * @param {string} request.cookie
 * @param {string} request.model - wire model key, or `LAST` for the most recent one.
 * @param {string} [request.style]
 * @param {boolean} [request.sessionOnly]
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getUsage({
  baseURL,
  cookie,
  model,
  style = '1',
  sessionOnly = false,
  signal,
}) {
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
    body: JSON.stringify({ id: '', model, style, sessionOnly, qst: 'Hi' }),
  })
  const text = await response.text()
  if (!response.ok) throw httpFailure(response.status, text)
  if (looksLikeLoginPage(response, text)) throw loginPageFailure()
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new CtuPortalError(
      'The portal returned a non-JSON quota response',
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

/** @returns {CtuPortalError} */
function loginPageFailure() {
  return new CtuPortalError(
    'The portal returned its sign-in page instead of a chatbot answer. '
    + 'The session cookie is missing or expired; sign in to the portal again and copy a fresh Cookie header value.',
    'INVALID_CREDENTIAL',
  )
}

/**
 * Classify an HTTP failure into a harness failure code.
 * @param {number} status
 * @param {string} body
 * @returns {CtuPortalError}
 */
function httpFailure(status, body) {
  const detail = body.trim().slice(0, 300)
  const suffix = detail === '' ? '' : `: ${detail}`
  if (status === 401 || status === 403) {
    if (looksLikeBlockPage(body)) {
      return new CtuPortalError(
        'The portal\'s edge filter blocked the request. Sign in to the portal again and '
        + 'paste a fresh Cookie header value, including the incap_ses_* and reese84 cookies.',
        'INVALID_CREDENTIAL',
        { status },
      )
    }
    return new CtuPortalError(
      'The portal rejected the session cookie. Sign in to the portal again and copy a fresh Cookie header value.',
      'INVALID_CREDENTIAL',
      { status },
    )
  }
  if (status === 429) {
    return new CtuPortalError(
      `The portal is rate limiting requests (HTTP 429)${suffix}`,
      'RATE_LIMIT',
      { status },
    )
  }
  if (status >= 500) {
    return new CtuPortalError(
      `The portal failed (HTTP ${status})${suffix}`,
      'SERVER',
      { status },
    )
  }
  return new CtuPortalError(
    `The portal rejected the request (HTTP ${status})${suffix}`,
    'INVALID_REQUEST',
    { status },
  )
}

/**
 * The portal reports an expired or unauthorized session as a 200 JSON status
 * rather than an HTTP 401. Name it so the harness offers the credential fix
 * instead of the generic refusal text.
 * @param {unknown} parsed
 * @returns {CtuPortalError | undefined}
 */
function accessDeniedFailure(parsed) {
  const status = typeof parsed?.status === 'string' ? parsed.status : ''
  if (!/^accessdenied$/iu.test(status)) return undefined
  return new CtuPortalError(
    'The portal denied access to the chatbot. Sign in to the portal again and copy a fresh Cookie header value.',
    'INVALID_CREDENTIAL',
  )
}

/**
 * Explain why the portal would not start a conversation.
 * @param {unknown} parsed
 * @param {string} body
 * @returns {CtuPortalError}
 */
function sessionFailure(parsed, body) {
  const denied = accessDeniedFailure(parsed)
  if (denied !== undefined) return denied

  const status = typeof parsed?.status === 'string' && parsed.status !== '' ? parsed.status : undefined
  const detail = typeof parsed?.errorMsg === 'string' ? parsed.errorMsg.trim() : ''

  if (detail !== '' && /another active|close all other|active chatbot session/iu.test(detail)) {
    return sessionConflictFailure(detail)
  }

  const reason = detail !== ''
    ? detail
    : status !== undefined
      ? `the portal returned status "${status}"`
      : `the portal returned an unrecognized response (${body.trim().slice(0, 200)})`
  return new CtuPortalError(
    `The portal could not start a conversation: ${reason}. `
    + 'Close the chatbot in any other browser tab and retry; if it still fails, '
    + 'sign in to the portal again and paste a fresh Cookie header value.',
    'INVALID_REQUEST',
  )
}

/**
 * The portal's one-active-conversation guard. It arrives as plain text on the
 * answer stream, not as a JSON status.
 * @param {string} [detail]
 * @returns {CtuPortalError}
 */
function sessionConflictFailure(detail) {
  return new CtuPortalError(
    'The portal already has an active chatbot session for this account. '
    + 'Close the chatbot in your browser (or wait 5 minutes) and retry.'
    + (detail === undefined || detail === '' ? '' : ` (${detail})`),
    'INVALID_REQUEST',
  )
}

/**
 * A first-time account (or one that has not accepted the current terms) must
 * accept the portal's GenAI disclaimer before its first answer.
 * @param {string} status
 * @param {boolean} [stillShown] - the portal kept asking after the acknowledgement.
 * @returns {CtuPortalError}
 */
function disclaimerFailure(status, stillShown = false) {
  if (stillShown) {
    return new CtuPortalError(
      'The portal kept asking for its GenAI disclaimer after the acknowledgement. '
      + 'Open https://www.cityu.edu.hk/portal/category/5 and accept the disclaimer manually, then retry.',
      'INVALID_REQUEST',
    )
  }
  return new CtuPortalError(
    `The portal requires accepting its GenAI disclaimer before the first conversation (status: ${status}). `
    + 'Open https://www.cityu.edu.hk/portal/category/5, start the chatbot, and accept the disclaimer once; then retry. '
    + 'Set acceptDisclaimer: true to let the plugin accept it automatically.',
    'INVALID_REQUEST',
  )
}

/**
 * The portal's canned IT knowledge-base fallback. It is a product of the
 * legacy `kbchatbot` route or an out-of-scope question, never a usable answer.
 * @param {string} text
 * @returns {CtuPortalError}
 */
function refusalFailure(text) {
  const snippet = text.trim().slice(0, 240)
  return new CtuPortalError(
    `The portal refused to answer: ${snippet}`,
    'CONTENT_REFUSED',
  )
}

/**
 * Plain-text access-denied body, when the portal does not wrap it in JSON.
 * @returns {CtuPortalError}
 */
function accessDeniedTextFailure() {
  return new CtuPortalError(
    'The portal denied access to the chatbot. Sign in to the portal again and copy a fresh Cookie header value.',
    'INVALID_CREDENTIAL',
  )
}

/**
 * Classify a body that ended before the conversation-id frame. A normal answer
 * always starts with `<id>,,,`; an error arrives as plain text instead.
 * @param {string} text
 * @returns {CtuPortalError}
 */
function unframedFailure(text) {
  const body = text.trim()
  if (body === '') {
    return new CtuPortalError(
      'The portal returned an empty response body',
      'EMPTY_RESPONSE',
    )
  }
  if (ACTIVE_SESSION.test(body)) return sessionConflictFailure()
  if (PORTAL_REFUSAL.test(body)) return refusalFailure(body)
  if (MESSAGE_TOO_LONG.test(body)) {
    return new CtuPortalError(
      'The portal rejected the prompt as too long (it answers with a plain-text length warning). '
      + 'Lower maxQuestionChars or maxToolResultChars and retry.',
      'CONTEXT_WINDOW_EXCEEDED',
    )
  }
  if (body.length < 500 && QUOTA_EXHAUSTED.test(body)) {
    return new CtuPortalError(`The portal's quota is exhausted: ${body.slice(0, 240)}`, 'ACCOUNT_QUOTA')
  }
  if (body.length < 500 && RATE_LIMITED.test(body)) {
    return new CtuPortalError(`The portal is rate limiting requests: ${body.slice(0, 240)}`, 'RATE_LIMIT')
  }
  if (ACCESS_DENIED_TEXT.test(body) && body.length < 200) return accessDeniedTextFailure()
  return new CtuPortalError(
    `The portal returned an answer without its conversation-id prefix: ${body.slice(0, 200)}`,
    'MALFORMED_RESPONSE',
  )
}
