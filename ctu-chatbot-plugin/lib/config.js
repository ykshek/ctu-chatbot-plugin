/**
 * Configuration defaults and normalization for the CityUHK portal adapter.
 *
 * The plugin deliberately exports no `Config` schema: cordis only validates a
 * plugin `Config` through `~standard`, which would require a schemastery
 * dependency, and this bundle is meant to run from the profile's own
 * node_modules with no runtime imports of DSH packages. `resolveOptions`
 * applies the same defaults and clamping a schema would.
 */

/** Portal chatbot API root (the widget appends `api/module/kbchatbot/...`). */
export const DEFAULT_BASE_URL = 'https://www.cityu.edu.hk/portal/api/module/kbchatbot'

/**
 * Quota API root.
 *
 * Quota lives in the portal's `chatbot` module, not the `kbchatbot` module the
 * chat protocol uses, so it needs its own endpoint rather than one derived by
 * appending a path to `baseURL`.
 */
export const DEFAULT_QUOTA_BASE_URL = 'https://www.cityu.edu.hk/portal/api/module/chatbot'

/** How long a quota reading stays fresh before a surface refetches it. */
export const DEFAULT_QUOTA_CACHE_MS = 30_000

/** Environment variable a bare installation reads the session cookie from. */
export const DEFAULT_COOKIE_ENV = 'CITYU_PORTAL_COOKIE'

/** Conservative declared context so the harness compacts before the portal truncates. */
export const DEFAULT_CONTEXT_WINDOW = 32_000

/** Full-request deadline; the portal streams a typical answer in a few seconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** Safety cap on the flattened transcript sent as the portal's single `qst` string. */
export const DEFAULT_MAX_QUESTION_CHARS = 24_000

/**
 * @typedef {object} CityuOptions
 * @property {string} baseURL
 * @property {string} quotaBaseURL
 * @property {string} cookie - literal cookie value, when configured.
 * @property {string} cookieEnv - credential reference and environment variable read when `cookie` is empty.
 * @property {string} sessionId - conversation id; empty means a fresh UUID per process.
 * @property {number} contextWindow
 * @property {number} requestTimeoutMs
 * @property {number} maxQuestionChars
 * @property {number} quotaCacheMs
 * @property {boolean} includeSystemPrompt
 */

/**
 * Normalize the loader-supplied config object.
 * @param {Record<string, unknown> | undefined} raw
 * @returns {CityuOptions}
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
    contextWindow: positiveInteger(config.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxQuestionChars: positiveInteger(config.maxQuestionChars) ?? DEFAULT_MAX_QUESTION_CHARS,
    quotaCacheMs: positiveInteger(config.quotaCacheMs) ?? DEFAULT_QUOTA_CACHE_MS,
    includeSystemPrompt: config.includeSystemPrompt === true,
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
 * Strip a trailing slash so endpoint joining is unambiguous.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBaseURL(value) {
  const candidate = positiveString(value) ?? DEFAULT_BASE_URL
  return candidate.endsWith('/') ? candidate.slice(0, -1) : candidate
}

/**
 * Swap the chat module for the quota module when a custom `baseURL` follows the
 * portal's own layout, so one override moves both endpoints together.
 * @param {string} baseURL
 * @returns {string}
 */
function deriveQuotaBaseURL(baseURL) {
  if (!baseURL.endsWith('/kbchatbot')) return DEFAULT_QUOTA_BASE_URL
  return `${baseURL.slice(0, -'/kbchatbot'.length)}/chatbot`
}
