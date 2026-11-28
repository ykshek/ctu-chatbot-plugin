/**
 * Harness-facing model catalog for the portal chatbot.
 *
 * The portal selects its answer backend with a single `model` string. These
 * ids are the model selector's own values; the catalog maps readable harness
 * ids onto them. An id that is not in the catalog is forwarded verbatim, so a
 * newly added portal backend can be used before this bundle is updated.
 */

/** Provider route owned by this plugin. */
export const PROVIDER_ID = 'ctu-portal'

/** Model selected when a request does not name one. */
export const DEFAULT_MODEL_ID = 'ctu-dsv4'

/**
 * @typedef {object} ModelEntry
 * @property {string} id - harness-facing model id.
 * @property {string} wire - exact `model` value the portal expects.
 * @property {string} name - display name.
 * @property {string} description - one-line capability note.
 */

/** @type {readonly ModelEntry[]} */
export const MODELS = Object.freeze([
  Object.freeze({
    id: 'ctu-gpt5-mini',
    wire: 'GPTmini',
    name: 'GPT-5 mini',
    description: 'GenAI chatbot answered by GPT-5 mini. Tool calls use DSML.',
  }),
  Object.freeze({
    id: 'ctu-gpt5',
    wire: 'GPT',
    name: 'GPT-5.2',
    description: 'GenAI chatbot answered by GPT-5.2. Tool calls use DSML.',
  }),
  Object.freeze({
    id: 'ctu-dsv4',
    wire: 'DSV4',
    name: 'DeepSeek V4 Flash',
    description: 'GenAI chatbot answered by DeepSeek V4 Flash. Tool calls use DSML.',
  }),
  Object.freeze({
    id: 'ctu-qwen38',
    wire: 'QWen38',
    name: 'Qwen3.8 Flash',
    description: 'GenAI chatbot answered by Qwen3.8-Flash-Next. Tool calls use DSML.',
  }),
])

/**
 * Find a catalog entry.
 * @param {string} id - harness-facing model id.
 * @returns {ModelEntry | undefined}
 */
export function findModel(id) {
  return MODELS.find(entry => entry.id === id)
}

/**
 * Map a harness model id to the portal's `model` value.
 * @param {string} id - harness-facing model id or a raw portal value.
 * @returns {string}
 */
export function wireModel(id) {
  return findModel(id)?.wire ?? id
}
