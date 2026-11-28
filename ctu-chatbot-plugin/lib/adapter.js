/**
 * `LlmAdapter`-compatible adapter for the portal chatbot.
 *
 * The harness only duck-types the adapter (`providerInfo`, `providerRetryPolicy`,
 * `prepareCall`, `resolveModel`, `listModels`, `stream`), so this class needs no
 * import of `@deepseek-ai/dsh-llm` and stays resolvable from the profile.
 *
 * The portal is a GenAI chat endpoint, not a chat-completions model:
 *   - every call sends one flattened `qst` string; the portal also keeps its
 *     own server-side transcript for the active conversation,
 *   - it has no native tool channel, so the tool catalog and DSML call syntax
 *     travel inside `qst`, and a DSML answer is translated into harness
 *     `tool-call` blocks,
 *   - there are no images, reasoning channels, or usage counters,
 *   - the answer is markdown framed as `<conversation-id>,,,<markdown>`.
 *
 * The portal's page opens a conversation with `getchathistory` and only then
 * asks questions. This adapter mirrors that lifecycle: the first turn claims
 * the conversation, later turns reuse it, and a first-time account is told to
 * accept the portal's GenAI disclaimer unless `acceptDisclaimer` is set.
 */

import { randomUUID } from 'node:crypto'
import { CtuPortalError } from './errors.js'
import { estimateTokens } from './estimate.js'
import { findModel, MODELS, wireModel } from './models.js'
import { chatStream, normalizeCookie, openConversation } from './protocol.js'
import { coerceArguments, extractToolCalls, formatToolCatalog } from './dsml.js'
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
 * Project one non-tool content block to the plain text the portal can read.
 * Tool calls are rendered by {@link renderMessage}, where their id and
 * arguments can be correlated with the tool result.
 * @param {{ type?: string, text?: unknown }} block
 * @returns {string}
 */
function blockText(block) {
  switch (block?.type) {
    case 'text':
    case 'reasoning':
      return typeof block.text === 'string' ? block.text : ''
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
 * Render an assistant message that carries tool calls. The portal model must
 * see its earlier call (name and arguments) before the matching tool result, or
 * it cannot tell which result answers which call.
 * @param {readonly { type?: string, text?: unknown, id?: unknown, name?: unknown, arguments?: unknown }[]} content
 * @param {Map<string, string>} toolNames - call id to tool name, filled as calls are seen.
 * @returns {string}
 */
function renderAssistantWithTools(content, toolNames) {
  const parts = []
  let text = []
  const flush = () => {
    const joined = text.join('').trim()
    if (joined !== '') parts.push(`Assistant: ${joined}`)
    text = []
  }
  for (const block of content) {
    switch (block?.type) {
      case 'text':
      case 'reasoning':
        if (typeof block.text === 'string') text.push(block.text)
        break
      case 'tool-call': {
        flush()
        const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'unknown'
        const id = typeof block.id === 'string' ? block.id : ''
        if (id !== '') toolNames.set(id, name)
        const args = typeof block.arguments === 'string' && block.arguments.trim() !== ''
          ? block.arguments
          : '{}'
        parts.push(`Assistant tool call ${name}${id === '' ? '' : ` (${id})`}:\n${args}`)
        break
      }
      case 'image':
        text.push('[image]')
        break
      case 'file':
        text.push('[file]')
        break
      default:
        break
    }
  }
  flush()
  return parts.join('\n\n')
}

/**
 * Render one harness message for the portal's text-only prompt.
 * @param {{ role?: string, content?: readonly any[], toolCallId?: unknown, isError?: unknown }} message
 * @param {Map<string, string>} toolNames
 * @returns {string}
 */
function renderMessage(message, toolNames) {
  if (message.role === 'tool') {
    const id = typeof message.toolCallId === 'string' ? message.toolCallId : ''
    const name = (id !== '' ? toolNames.get(id) : undefined) ?? 'tool'
    const text = contentText(message.content).trim()
    const error = message.isError === true ? ' [error]' : ''
    return `Tool result (${name}${id === '' ? '' : `, ${id}`})${error}:\n${text === '' ? '[no output]' : text}`
  }
  if (message.role === 'assistant' && Array.isArray(message.content)
    && message.content.some(block => block?.type === 'tool-call')) {
    return renderAssistantWithTools(message.content, toolNames)
  }
  const text = contentText(message.content).trim()
  if (text === '') return ''
  const label = ROLE_LABELS[message.role] ?? 'User'
  return `${label}: ${text}`
}

/**
 * Build the portal's single `qst` string from the harness request.
 *
 * The portal has no native tool field and no conversation memory of its own
 * prompt shape, so the question carries three things, in order: the optional
 * harness system prompt, the tool catalog and DSML call syntax, and the
 * flattened transcript. Tool calls and tool results are rendered with their
 * call ids so the model can correlate them on the next turn.
 * @param {{ messages?: readonly any[], system?: unknown, tools?: readonly any[] }} options
 * @param {{ includeSystemPrompt: boolean, maxQuestionChars: number }} settings
 * @returns {string}
 */
export function buildQuestion(options, settings) {
  const header = []
  if (settings.includeSystemPrompt && typeof options.system === 'string' && options.system.trim() !== '') {
    header.push(`System: ${options.system.trim()}`)
  }
  const catalog = formatToolCatalog(options.tools)
  if (catalog !== '') header.push(catalog)

  const turns = []
  const toolNames = new Map()
  for (const message of options.messages ?? []) {
    if (!settings.includeSystemPrompt && (message.role === 'system' || message.role === 'developer')) continue
    const rendered = renderMessage(message, toolNames)
    if (rendered !== '') turns.push(rendered)
  }

  const headerText = header.join('\n\n')
  const bodyText = turns.join('\n\n')
  if (headerText === '' && bodyText === '') return ''
  const marker = '[earlier conversation truncated]'
  const separator = headerText !== '' && bodyText !== '' ? 2 : 0
  const budget = settings.maxQuestionChars - headerText.length - separator
  if (bodyText.length <= budget) return [headerText, bodyText].filter(Boolean).join('\n\n')
  if (budget <= marker.length) {
    return headerText !== '' ? headerText : bodyText.slice(bodyText.length - settings.maxQuestionChars)
  }
  const kept = bodyText.slice(bodyText.length - (budget - marker.length))
  return [headerText, `${marker}\n\n${kept}`].filter(Boolean).join('\n\n')
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
 * @property {string} style
 * @property {boolean} sessionOnly
 * @property {boolean} acceptDisclaimer
 * @property {number} contextWindow
 * @property {number} requestTimeoutMs
 * @property {number} maxQuestionChars
 * @property {boolean} includeSystemPrompt
 */

export class CtuPortalAdapter {
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
    /** Wire model the claimed conversation belongs to; the portal binds a conversation to one model. */
    this.claimedModel = undefined
  }

  /**
   * @param {string} provider
   * @returns {{ id: string, name: string }}
   */
  providerInfo(provider) {
    return { id: provider, name: 'The portal chatbot' }
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
        throw new CtuPortalError(
          'The portal adapter received no text to ask',
          'INVALID_REQUEST',
        )
      }
      const model = wireModel(options.model)
      const { style, sessionOnly, acceptDisclaimer } = this.options

      // The portal's page opens a conversation with `getchathistory` and then
      // asks questions against that id. Claiming on every turn would fight its
      // one-active-session guard, so claim only when the id or the model
      // changes (the first turn of a process, a model switch, or after the
      // portal reported the session gone).
      if (this.claimedSessionId !== this.sessionId || this.claimedModel !== model) {
        await openConversation({
          baseURL: this.options.baseURL,
          cookie,
          id: this.sessionId,
          model,
          style,
          sessionOnly,
          acceptDisclaimer,
          signal,
        })
        this.claimedSessionId = this.sessionId
        this.claimedModel = model
      }

      const answerParts = []
      for await (const delta of chatStream({
        baseURL: this.options.baseURL,
        cookie,
        id: this.sessionId,
        model,
        qst: question,
        style,
        sessionOnly,
        signal,
      })) {
        answerParts.push(delta)
      }
      const answer = answerParts.join('')
      if (answer.trim() === '') {
        throw new CtuPortalError(
          'The portal returned an empty answer',
          'EMPTY_RESPONSE',
        )
      }

      // The portal has no native tool channel: a DeepSeek-backed answer may
      // contain DSML markup. Buffer the answer, strip the markup, and emit a
      // text block plus one tool-call block per invoke. A `tool-calls` finish
      // makes the harness execute them and call this provider again with the
      // results.
      const parsed = extractToolCalls(answer)
      const toolByName = new Map()
      for (const tool of options.tools ?? []) {
        if (tool !== null && typeof tool === 'object' && typeof tool.name === 'string') {
          toolByName.set(tool.name, tool)
        }
      }

      let index = 0
      // A plain answer is passed through exactly; only the DSML preamble is
      // trimmed by the parser. Check emptiness separately so trailing
      // whitespace survives.
      const text = parsed.text
      if (text.trim() !== '') {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text }
        yield { type: 'block-end', index, block: { type: 'text', text } }
        index += 1
      }
      for (const call of parsed.calls) {
        coerceArguments(call.arguments, toolByName.get(call.name))
        const id = `call-${randomUUID()}`
        const args = JSON.stringify(call.arguments)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id, name: call.name, arguments: args },
        }
        index += 1
      }

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
      yield {
        type: 'finish',
        reason: { kind: parsed.calls.length > 0 ? 'tool-calls' : 'stop' },
      }
    } catch (error) {
      if (error instanceof CtuPortalError) {
        // The portal's one-active-session guard means the next attempt must
        // open the conversation again, after the user closes the other tab.
        if (error.code === 'INVALID_REQUEST' && /active chatbot session/iu.test(error.message)) {
          this.claimedSessionId = undefined
          this.claimedModel = undefined
        }
        throw error
      }
      if (timedOut) {
        throw new CtuPortalError(
          `The portal did not answer within ${Math.round(this.options.requestTimeoutMs / 1000)}s`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new CtuPortalError('The portal request aborted', 'ABORTED', { cause: error })
      }
      if (isRedirectFailure(error)) {
        throw new CtuPortalError(
          'The portal redirected the request instead of answering. '
          + 'The session cookie is missing or expired; sign in to the portal again and copy a fresh Cookie header value.',
          'INVALID_CREDENTIAL',
          { cause: error },
        )
      }
      throw new CtuPortalError('The portal transport failed', 'TRANSPORT', { cause: error })
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
    throw new CtuPortalError(
      `No portal session cookie is configured. Paste one into the plugin's settings `
      + `(Plugins → Installed plugins → The portal chatbot), or set the ${this.options.cookieEnv} environment variable.`,
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
