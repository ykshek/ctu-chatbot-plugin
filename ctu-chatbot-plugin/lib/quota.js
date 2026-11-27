/**
 * Per-model quota for the CityUHK portal chatbot account.
 *
 * The portal does not have one account-wide allowance: each model on the
 * dashboard carries its own `quota` / `quotaLeft` pair, read from
 * `api/module/chatbot/getusage` with the model named in the request body. The
 * dashboard widget issues the same request whenever its model selector
 * changes, which is why a single call returns the selected model's figures plus
 * the catalog of every model and its `lastUsed` flag.
 *
 * This module normalizes that payload. It never decides when to refresh: the
 * caller owns the cache and the request cadence.
 */

import { MODELS } from './models.js'
import { getUsage } from './protocol.js'

/**
 * Wire models that carry a quota, in dashboard order.
 *
 * `IT-Portal` is the portal's default route and is absent from the dashboard's
 * quota selector, so it is deliberately excluded rather than reported as zero.
 */
export const QUOTA_MODELS = Object.freeze(
  MODELS
    .filter(entry => entry.wire !== 'IT-Portal')
    .map(entry => Object.freeze({
      wire: entry.wire,
      label: entry.name.replace(/^CityUHK\s+/u, ''),
    })),
)

/** Pause between per-model requests, so one refresh never looks like a burst. */
const DEFAULT_GAP_MS = 350

/**
 * @typedef {object} QuotaReading
 * @property {string} model - wire model the reading belongs to.
 * @property {string} label - display name from the portal, falling back to the catalog.
 * @property {boolean} metered - whether the portal lists this model in its quota catalog.
 * @property {number | undefined} quota - the model's allowance.
 * @property {number | undefined} quotaLeft - what the account has left.
 * @property {boolean} unlimited - true when a metered model reports no finite allowance.
 * @property {string | undefined} nextQuotaUpdate - reset instant as the portal words it.
 * @property {number | undefined} lastWordsConsumption - last conversation's portal "words".
 * @property {Array<{ wire: string, label: string, lastUsed: boolean }>} catalog - every model the portal listed.
 * @property {string | undefined} lastUsedModel - the model the portal marks `lastUsed`.
 */

/**
 * Shape one `getusage` payload.
 * @param {Record<string, unknown>} payload - raw portal response.
 * @param {string} requestedModel - the wire model that was asked for.
 * @returns {QuotaReading}
 */
export function normalizeQuota(payload, requestedModel) {
  const catalog = catalogOf(payload)
  const listed = catalog.find(entry => entry.wire === requestedModel)
  const quota = positiveNumber(payload.quota)
  const quotaLeft = positiveNumber(payload.quotaLeft)
  // The portal lists the models it meters. A model absent from that list — the
  // default `IT-Portal` route, say — has no allowance to report, which is not
  // the same fact as an unlimited one.
  const metered = listed !== undefined
  return {
    model: requestedModel,
    label: listed?.label
      ?? QUOTA_MODELS.find(entry => entry.wire === requestedModel)?.label
      ?? requestedModel,
    metered,
    quota,
    quotaLeft,
    // The widget renders "unlimited" when the allowance reaches its ceiling; a
    // metered model that answers without a count is the only signal we get.
    unlimited: metered && quota === undefined,
    nextQuotaUpdate: dateText(payload.nextQuotaUpdate),
    lastWordsConsumption: positiveNumber(payload.lastWordsConsumption),
    catalog,
    lastUsedModel: catalog.find(entry => entry.lastUsed)?.wire,
  }
}

/**
 * Read one model's quota.
 * @param {object} request
 * @param {string} request.baseURL - root of the `chatbot` module.
 * @param {string} request.cookie
 * @param {string} request.model
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<QuotaReading>}
 */
export async function fetchQuota({ baseURL, cookie, model, signal }) {
  return normalizeQuota(await getUsage({ baseURL, cookie, model, signal }), model)
}

/**
 * Read every model's quota, one request at a time.
 *
 * A single model failing (a transient edge block, say) leaves the other
 * readings intact; the caller renders the failures per row instead of losing
 * the whole table.
 * @param {object} request
 * @param {string} request.baseURL
 * @param {string} request.cookie
 * @param {AbortSignal} [request.signal]
 * @param {number} [request.gapMs]
 * @returns {Promise<{ models: Array<{ wire: string, label: string }>, readings: Record<string, QuotaReading | { model: string, error: string }> }>}
 */
export async function fetchAllQuotas({ baseURL, cookie, signal, gapMs = DEFAULT_GAP_MS }) {
  const readings = {}
  /** @type {Array<{ wire: string, label: string }>} */
  let catalog = []
  for (const [index, entry] of QUOTA_MODELS.entries()) {
    if (index > 0) await pause(gapMs, signal)
    try {
      const reading = await fetchQuota({ baseURL, cookie, model: entry.wire, signal })
      readings[entry.wire] = reading
      if (catalog.length === 0 && reading.catalog.length > 0) {
        catalog = reading.catalog.map(item => ({ wire: item.wire, label: item.label }))
      }
    } catch (error) {
      readings[entry.wire] = {
        model: entry.wire,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return {
    models: catalog.length > 0 ? catalog : QUOTA_MODELS.map(entry => ({ ...entry })),
    readings,
  }
}

/**
 * Project the portal's `model` array into the catalog shape.
 * @param {Record<string, unknown>} payload
 * @returns {Array<{ wire: string, label: string, lastUsed: boolean }>}
 */
function catalogOf(payload) {
  const listed = Array.isArray(payload.model) ? payload.model : []
  const catalog = []
  for (const entry of listed) {
    if (entry === null || typeof entry !== 'object') continue
    const record = /** @type {Record<string, unknown>} */ (entry)
    const wire = typeof record.modelValue === 'string' ? record.modelValue : ''
    if (wire === '') continue
    catalog.push({
      wire,
      label: typeof record.modelName === 'string' && record.modelName !== '' ? record.modelName : wire,
      lastUsed: record.lastUsed === true,
    })
  }
  return catalog
}

/**
 * Keep a positive finite count, dropping the portal's empty placeholders.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Render the reset field, which the portal sends either as an ISO instant or as
 * a dash-separated date, as plain calendar text.
 *
 * The ISO branch takes the date it already carries: parsing it into a `Date`
 * and re-serializing would shift the day for any timezone ahead of UTC.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function dateText(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const isoDate = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/u.exec(trimmed)
  if (isoDate !== null) return isoDate[1]
  return trimmed
}

/**
 * Wait between requests, ending early when the caller aborts.
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function pause(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    if (signal?.aborted === true) {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
