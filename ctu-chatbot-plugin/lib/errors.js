/**
 * Provider-neutral failure raised by the CityUHK portal adapter.
 *
 * The harness turns a thrown adapter error into a terminal `finish` chunk by
 * reading the error's own `failure` data property (verified in
 * `dsh-llm/src/adapter-failure.ts`: cross-package copies preserve own data but
 * not class identity). Carrying both `code` and `failure` as ordinary own
 * properties therefore yields a fully classified `LlmFailure` while keeping
 * this bundle independent of any specific harness package copy.
 *
 * Codes mirror `LLM_FAILURE_CODES` in `@deepseek-ai/dsh-llm`; only codes that
 * are meaningful for a session-cookie chatbot endpoint are used. A canned
 * portal refusal is `CONTENT_REFUSED`, not `INVALID_REQUEST`.
 */

/**
 * @typedef {object} CityuFailure
 * @property {string} message
 * @property {string} code
 * @property {number} [status]
 * @property {string} [requestId]
 * @property {number} [providerRetryAfterMs]
 */

/** @typedef {{ cause?: unknown, status?: number, requestId?: string, retryAfterMs?: number }} CityuErrorOptions */

/**
 * An error the LLM runtime can normalize without importing the harness copy.
 */
export class CityuPortalError extends Error {
  /**
   * @param {string} message - non-empty user-facing description.
   * @param {string} code - one of the harness `LLM_FAILURE_CODES`.
   * @param {CityuErrorOptions} [options]
   */
  constructor(message, code, options = {}) {
    const { cause, status, requestId, retryAfterMs } = options
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CityuPortalError'
    this.code = code
    /** @type {CityuFailure} */
    this.failure = Object.freeze({
      message,
      code,
      ...isHttpStatus(status) ? { status } : {},
      ...isNonEmptyString(requestId) ? { requestId } : {},
      ...isPositiveFinite(retryAfterMs) ? { providerRetryAfterMs: retryAfterMs } : {},
    })
  }
}

/** @param {unknown} value */
function isHttpStatus(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/** @param {unknown} value */
function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
