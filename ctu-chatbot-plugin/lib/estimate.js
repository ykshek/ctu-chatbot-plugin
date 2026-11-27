/**
 * Token estimation for a provider that reports no token counts.
 *
 * The CityUHK portal streams answer text and reports consumption only in its
 * own "words" unit on the dashboard; it never returns prompt or completion
 * tokens. The harness, however, only fills the Usage pill, the decode-time
 * figure, and tokens-per-second from a `usage` chunk the adapter emits. This
 * module supplies that estimate.
 *
 * The ratio is the same ~4 characters per token the harness uses for its own
 * context breakdown, so the numbers stay comparable with the context meter.
 * They are estimates, not billed counts, and every surface that shows them
 * says so.
 */

/** Characters per token assumed by the harness estimators. */
const CHARS_PER_TOKEN = 4

/**
 * Estimate the token count of one text run.
 * @param {unknown} text
 * @returns {number} zero for empty input, otherwise at least one.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  return Math.max(1, Math.round(text.length / CHARS_PER_TOKEN))
}
