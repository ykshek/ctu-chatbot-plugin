/**
 * `LlmAdapter`-compatible adapter for the CityUHK portal chatbot.
 *
 * The harness only duck-types the adapter (`providerInfo`, `providerRetryPolicy`,
 * `prepareCall`, `resolveModel`, `listModels`, `stream`), so this class needs no
 * import of `@deepseek-ai/dsh-llm` and stays resolvable from the profile.
 *
 * The portal is a single-turn RAG assistant, not a chat-completions model:
 *   - every call sends one flattened `qst` string; there is no server-side memory,
 *   - there are no tools, images, reasoning channels, or usage counters,
 *   - the answer is markdown streamed as text, mapped to one text block.
 */

import { randomUUID } from 'node:crypto'
import { CityuPortalError } from './errors.js'
import { estimateTokens } from './estimate.js'
import { findModel, MODELS, wireModel } from './models.js'
import { chatStream, normalizeCookie, startNewConversation } from './protocol.js'
import { fetchAllQuotas, fetchQuota } from './quota.js'

/** Role labels used when flattening the message history into one question. */
const ROLE_LABELS = Object.freeze({
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  developer: 'Developer',
  tool: 'Tool',
})

/**
 * Project one content block to the plain text the portal can read.
 * @param {{ type?: string, text?: unknown, name?: unknown }} block
 * @returns {string}
 */
function blockText(block) {
  switch (block?.type) {
    case 'text':
    case 'reasoning':
      return typeof block.text === 'string' ? block.text : ''
    case 'tool-call':
      return typeof block.name === 'string' && block.name !== ''
        ? `[tool call: ${block.name}]`
        : '[tool call]'
    case 'image':
      return '[image]'
    case 'file':
      return '[file]'
    default:
      return ''
  }
}

/**
 * Flatten a message's content blocks into one text run.
 * @param {readonly { type?: string }[] | undefined} content
 * @returns {string}
 */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    const text = blockText(block)
    if (text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Build the portal's single `qst` string from the harness request.
 *
 * The portal has no conversation memory: a follow-up such as "double that
 * number" is answered from the knowledge base alone. Replaying the transcript
 * inside the one question is what makes multi-turn references resolvable.
 * @param {{ messages?: readonly { role?: string, content?: readonly { type?: string }[] }[], system?: unknown }} options
 * @param {{ includeSystemPrompt: boolean, maxQuestionChars: number }} settings
 * @returns {string}
 */
export function buildQuestion(options, settings) {
  const turns = []
  if (settings.includeSystemPrompt && typeof options.system === 'string' && options.system.trim() !== '') {
    turns.push(`System: ${options.system.trim()}`)
  }
  for (const message of options.messages ?? []) {
    const text = contentText(message.content).trim()
    if (text === '') continue
    if (!settings.includeSystemPrompt && (message.role === 'system' || message.role === 'developer')) continue
    const label = ROLE_LABELS[message.role] ?? 'User'
    turns.push(`${label}: ${text}`)
  }
  if (turns.length === 0) return ''
  const question = turns.join('\n\n')
  if (question.length <= settings.maxQuestionChars) return question
  return `[earlier conversation truncated]\n\n${question.slice(question.length - settings.maxQuestionChars)}`
}

/**
 * Recognize a redirect rejected by `fetch({ redirect: 'error' })`. Returning
 * the sign-in page as a redirect means the session cookie went stale.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRedirectFailure(error) {
  const textOf = (value) => (value instanceof Error ? value.message : '')
  return /redirect/iu.test(textOf(error)) || /redirect/iu.test(textOf(error?.cause))
}

/**
 * @typedef {object} AdaptedOptions
 * @property {string} baseURL
 * @property {string} quotaBaseURL
 * @property {string} cookie
 * @property {string} cookieEnv
 * @property {string} sessionId
 * @property {number} contextWindow
 * @property {number} requestTimeoutMs
 * @property {number} maxQuestionChars
 * @property {boolean} includeSystemPrompt
 */

export class CityuPortalAdapter {
  /**
   * @param {AdaptedOptions} options - normalized plugin config.
   * @param {{ credentialReader?: () => Promise<string | undefined> }} [auth] - reads the stored session cookie.
   */
  constructor(options, auth = {}) {
    /** @type {AdaptedOptions} */
    this.options = options
    /** Reads the cookie the settings page stored; absent in a headless install. */
    this.credentialReader = auth.credentialReader
    /** Stable conversation id for this adapter generation. */
    this.sessionId = options.sessionId !== '' ? options.sessionId : randomUUID()
    /** Conversation id the portal has already been asked to claim, if any. */
    this.claimedSessionId = undefined
  }

  /**
   * @param {string} provider
   * @returns {{ id: string, name: string }}
   */
  providerInfo(provider) {
    return { id: provider, name: 'CityUHK Portal Chatbot' }
  }

  /**
   * No provider-specific retry policy: the harness defaults apply.
   * @returns {undefined}
   */
  providerRetryPolicy() {
    return undefined
  }

  /**
   * @param {string} provider
   * @returns {Promise<readonly { provider: string, id: string, name: string, description: string, inputModalities: readonly string[] }[]>}
   */
  async listModels(provider) {
    return MODELS.map(entry => ({
      provider,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      inputModalities: ['text'],
    }))
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<{ provider: string, id: string, name: string, description?: string, inputModalities: readonly string[], context: { contextWindow: number } }>}
   */
  async resolveModel(provider, model) {
    const entry = findModel(model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry === undefined ? {} : { description: entry.description }),
      inputModalities: ['text'],
      context: { contextWindow: this.options.contextWindow },
    }
  }

  /**
   * Bind this generation's model metadata to its stream entry point, so a
   * mid-flight config reload cannot mix two generations.
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ model: object, stream: (options: any) => AsyncIterable<object> }>}
   */
  async prepareCall(provider, model, signal) {
    signal?.throwIfAborted()
    const resolved = await this.resolveModel(provider, model)
    signal?.throwIfAborted()
    return {
      model: resolved,
      stream: options => this.stream(options),
    }
  }

  /**
   * @param {any} options - harness `GenerateOptions`.
   * @returns {AsyncGenerator<object, void, void>}
   */
  async * stream(options) {
    const controller = new AbortController()
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal])
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.options.requestTimeoutMs)

    try {
      signal.throwIfAborted()
      const cookie = await this.resolveCookie()
      const question = buildQuestion(options, this.options)
      if (question === '') {
        throw new CityuPortalError(
          'CityUHK portal adapter received no text to ask',
          'INVALID_REQUEST',
        )
      }
      const model = wireModel(options.model)

      // The portal's own widget claims a conversation once, on load, and then
      // asks questions against that id; only its "clear conversation" button
      // calls `startnewconversation` again. Claiming on every turn trips the
      // portal's one-active-session guard for no benefit, so claim only when
      // the id changes (first turn of a process, or after a failed claim).
      if (this.claimedSessionId !== this.sessionId) {
        await startNewConversation({
          baseURL: this.options.baseURL,
          cookie,
          id: this.sessionId,
          model,
          signal,
        })
        this.claimedSessionId = this.sessionId
      }

      const chunks = []
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for await (const delta of chatStream({
        baseURL: this.options.baseURL,
        cookie,
        id: this.sessionId,
        model,
        qst: question,
        signal,
      })) {
        chunks.push(delta)
        yield { type: 'text-delta', index: 0, text: delta }
      }
      const answer = chunks.join('')
      if (answer.trim() === '') {
        throw new CityuPortalError(
          'CityUHK portal returned an empty answer',
          'EMPTY_RESPONSE',
        )
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      // The portal reports no prompt or completion counts, so the harness would
      // leave the Usage pill empty and the decode-speed figure blank. Emitting
      // an estimate before the terminal chunk fills both; it is labelled as an
      // estimate everywhere it is shown.
      const inputTokens = estimateTokens(question)
      const outputTokens = estimateTokens(answer)
      yield {
        type: 'usage',
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (error instanceof CityuPortalError) throw error
      if (timedOut) {
        throw new CityuPortalError(
          `CityUHK portal did not answer within ${Math.round(this.options.requestTimeoutMs / 1000)}s`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new CityuPortalError('CityUHK portal request aborted', 'ABORTED', { cause: error })
      }
      if (isRedirectFailure(error)) {
        throw new CityuPortalError(
          'CityUHK portal redirected the request instead of answering. '
          + 'The session cookie is missing or expired; sign in to the portal again and copy a fresh Cookie header value.',
          'INVALID_CREDENTIAL',
          { cause: error },
        )
      }
      throw new CityuPortalError('CityUHK portal transport failed', 'TRANSPORT', { cause: error })
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  /**
   * Resolve the session cookie: an explicit config value first, then the
   * credential the bundle page stored, then the named environment variable.
   * Resolved per request, so a cookie saved on the bundle page takes effect on
   * the next call without a restart.
   * @returns {Promise<string>}
   */
  async resolveCookie() {
    const direct = normalizeCookie(this.options.cookie)
    if (direct !== '') return direct
    if (this.credentialReader !== undefined) {
      const stored = await this.credentialReader()
      const fromStore = typeof stored === 'string' ? normalizeCookie(stored) : ''
      if (fromStore !== '') return fromStore
    }
    const envValue = process.env[this.options.cookieEnv]
    const fromEnv = typeof envValue === 'string' ? normalizeCookie(envValue) : ''
    if (fromEnv !== '') return fromEnv
    throw new CityuPortalError(
      `No CityUHK portal session cookie is configured. Paste one into the plugin's settings `
      + `(Plugins → Installed plugins → CityUHK portal chatbot), or set the ${this.options.cookieEnv} environment variable.`,
      'MISSING_CREDENTIAL',
    )
  }

  /**
   * Read one model's quota through this adapter's credentials.
   * @param {string} model - wire model key.
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('./quota.js').QuotaReading>}
   */
  async readQuota(model, signal) {
    return fetchQuota({
      baseURL: this.options.quotaBaseURL,
      cookie: await this.resolveCookie(),
      model,
      signal,
    })
  }

  /**
   * Read every model's quota.
   * @param {AbortSignal} [signal]
   * @returns {Promise<Awaited<ReturnType<typeof fetchAllQuotas>>>}
   */
  async readAllQuotas(signal) {
    return fetchAllQuotas({
      baseURL: this.options.quotaBaseURL,
      cookie: await this.resolveCookie(),
      signal,
    })
  }
}
