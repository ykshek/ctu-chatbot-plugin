/**
 * Configuration defaults and normalization for the portal adapter.
 *
 * The plugin deliberately exports no `Config` schema: cordis only validates a
 * plugin `Config` through `~standard`, which would require a schemastery
 * dependency, and this bundle is meant to run from the profile's own
 * node_modules with no runtime imports of DSH packages. `resolveOptions`
 * applies the same defaults and clamping a schema would.
 */

/**
 * Portal chatbot API root.
 *
 * The GenAI chatbot page and every model it offers live in the portal's
 * `chatbot` module. The sibling `kbchatbot` module is the legacy IT
 * knowledge-base widget: it ignores the GenAI model names and answers
 * out-of-scope questions with the IT Service Desk fallback.
 */
export const DEFAULT_BASE_URL = 'https://www.cityu.edu.hk/portal/api/module/chatbot'

/**
 * Quota API root.
 *
 * Quota is served from the same `chatbot` module as chat, so the default is the
 * chat root. The option remains for a portal whose layout differs.
 */
export const DEFAULT_QUOTA_BASE_URL = DEFAULT_BASE_URL

/** The portal's thinking-effort value: `0` quick, `1` balanced, `2` deep. */
export const DEFAULT_STYLE = '1'

/** How long a quota reading stays fresh before a surface refetches it. */
export const DEFAULT_QUOTA_CACHE_MS = 30_000

/** Environment variable a bare installation reads the session cookie from. */
export const DEFAULT_COOKIE_ENV = 'CTU_PORTAL_COOKIE'

/**
 * Declared context for harness compaction.
 *
 * The portal rejects a prompt somewhere above 12k characters (~3k tokens), so
 * a 32k-token declaration would let the conversation grow far past the real
 * limit before DSH compacts. The adapter also caps the prompt itself; this
 * value makes the harness plan for the same budget.
 */
export const DEFAULT_CONTEXT_WINDOW = 4_000

/** Full-request deadline; the portal streams a typical answer in a few seconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** Safety cap on the flattened transcript sent as the portal's single `qst` string. */
export const DEFAULT_MAX_QUESTION_CHARS = 12_000

/** Cap on one tool result rendered into the prompt; the portal rejects oversized messages. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 2_000

/**
 * @typedef {object} CtuOptions
 * @property {string} baseURL
 * @property {string} quotaBaseURL
 * @property {string} cookie - literal cookie value, when configured.
 * @property {string} cookieEnv - credential reference and environment variable read when `cookie` is empty.
 * @property {string} sessionId - conversation id; empty means a fresh UUID per process.
 * @property {string} style - portal thinking effort: `0` quick, `1` balanced, `2` deep.
 * @property {boolean} sessionOnly - ask the portal to show only the current session.
 * @property {boolean} acceptDisclaimer - accept the portal's GenAI disclaimer automatically.
 * @property {number} contextWindow
 * @property {number} requestTimeoutMs
 * @property {number} maxQuestionChars
 * @property {number} maxToolResultChars
 * @property {number} quotaCacheMs
 * @property {boolean} includeSystemPrompt
 */

/**
 * Normalize the loader-supplied config object.
 * @param {Record<string, unknown> | undefined} raw
 * @returns {CtuOptions}
 */
export function resolveOptions(raw) {
  const config = raw ?? {}
  const baseURL = normalizeBaseURL(positiveString(config.baseURL) ?? DEFAULT_BASE_URL)
  return Object.freeze({
    baseURL,
    quotaBaseURL: normalizeBaseURL(positiveString(config.quotaBaseURL) ?? deriveQuotaBaseURL(baseURL)),
    cookie: typeof config.cookie === 'string' ? config.cookie.trim() : '',
    cookieEnv: positiveString(config.cookieEnv) ?? DEFAULT_COOKIE_ENV,
    sessionId: positiveString(config.sessionId) ?? '',
    style: normalizeStyle(config.style),
    sessionOnly: config.sessionOnly === true,
    acceptDisclaimer: config.acceptDisclaimer === true,
    contextWindow: positiveInteger(config.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxQuestionChars: positiveInteger(config.maxQuestionChars) ?? DEFAULT_MAX_QUESTION_CHARS,
    maxToolResultChars: positiveInteger(config.maxToolResultChars) ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
    quotaCacheMs: positiveInteger(config.quotaCacheMs) ?? DEFAULT_QUOTA_CACHE_MS,
    includeSystemPrompt: config.includeSystemPrompt !== false,
  })
}

/** @param {unknown} value */
function positiveString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Normalize the portal's thinking-effort value. The page's radios use `0`, `1`
 * and `2`; readable names are accepted for configuration.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeStyle(value) {
  if (value === 0 || value === '0') return '0'
  if (value === 1 || value === '1') return '1'
  if (value === 2 || value === '2') return '2'
  if (typeof value !== 'string') return DEFAULT_STYLE
  switch (value.trim().toLowerCase()) {
    case 'quick':
    case 'quick reply':
      return '0'
    case 'balanced':
    case 'balanced thinking':
      return '1'
    case 'deep':
    case 'deep thinking':
      return '2'
    default:
      return DEFAULT_STYLE
  }
}

/**
 * Strip a trailing slash so endpoint joining is unambiguous.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBaseURL(value) {
  const candidate = positiveString(value) ?? DEFAULT_BASE_URL
  return candidate.endsWith('/') ? candidate.slice(0, -1) : candidate
}

/**
 * Follow the portal's module layout when a custom `baseURL` is used. Chat and
 * quota share the `chatbot` module; a legacy `kbchatbot` override still gets
 * the sibling quota root so one setting keeps both endpoints on one portal.
 * @param {string} baseURL
 * @returns {string}
 */
function deriveQuotaBaseURL(baseURL) {
  if (baseURL.endsWith('/kbchatbot')) return `${baseURL.slice(0, -'/kbchatbot'.length)}/chatbot`
  if (baseURL.endsWith('/chatbot')) return baseURL
  return DEFAULT_QUOTA_BASE_URL
}
