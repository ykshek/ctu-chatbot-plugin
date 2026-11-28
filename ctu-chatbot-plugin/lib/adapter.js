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
import { coerceArguments, extractToolCalls, findToolMarker, formatToolCatalog, longestMarkerSuffix } from './dsml.js'
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
 * Keep one tool result or tool-call argument within the prompt budget. The
 * portal rejects an oversized message outright, and a single `find` result can
 * be tens of kilobytes; keeping the head and tail preserves both the start of
 * the output and its final status line.
 * @param {string} text
 * @param {number | undefined} max
 * @param {string} [hint] - recovery guidance appended to the elision note.
 * @returns {string}
 */
function truncateToolText(text, max, hint) {
  if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0 || text.length <= max) return text
  const tail = Math.min(600, Math.max(0, Math.floor(max / 4)))
  const head = Math.max(0, max - tail)
  const omitted = text.length - head - tail
  if (omitted <= 0) return text
  const note = hint === undefined || hint === ''
    ? `…[truncated ${omitted} characters]…`
    : `…[truncated ${omitted} characters; ${hint}]…`
  return `${text.slice(0, head)}\n${note}\n${text.slice(text.length - tail)}`
}

/**
 * Render an assistant message that carries tool calls. The portal model must
 * see its earlier call (name and arguments) before the matching tool result, or
 * it cannot tell which result answers which call.
 * @param {readonly { type?: string, text?: unknown, id?: unknown, name?: unknown, arguments?: unknown }[]} content
 * @param {Map<string, string>} toolNames - call id to tool name, filled as calls are seen.
 * @returns {string}
 */
function renderAssistantWithTools(content, toolNames, settings) {
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
        const rawArgs = typeof block.arguments === 'string' && block.arguments.trim() !== ''
          ? block.arguments
          : '{}'
        const args = truncateToolText(rawArgs, (settings.maxToolResultChars ?? 2000) * 2)
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
 * @param {{ maxToolResultChars?: number }} settings
 * @param {number} [maxToolResultChars] - per-result override for a budgeted exchange.
 * @returns {string}
 */
function renderMessage(message, toolNames, settings, maxToolResultChars = settings.maxToolResultChars) {
  if (message.role === 'tool') {
    const id = typeof message.toolCallId === 'string' ? message.toolCallId : ''
    const name = (id !== '' ? toolNames.get(id) : undefined) ?? 'tool'
    const text = truncateToolText(
      contentText(message.content).trim(),
      maxToolResultChars,
      'use a narrower command or read the file with offset/limit',
    )
    const error = message.isError === true ? ' [error]' : ''
    return `Tool result (${name}${id === '' ? '' : `, ${id}`})${error}:\n${text === '' ? '[no output]' : text}`
  }
  if (message.role === 'assistant' && Array.isArray(message.content)
    && message.content.some(block => block?.type === 'tool-call')) {
    return renderAssistantWithTools(message.content, toolNames, settings)
  }
  const text = contentText(message.content).trim()
  if (text === '') return ''
  const label = ROLE_LABELS[message.role] ?? 'User'
  return `${label}: ${text}`
}

/**
 * One-line action record for a message that is no longer shown in full.
 * These records preserve the agent's progress (which files it read, which
 * commands it ran) without spending the transcript budget on old outputs.
 * @param {{ role?: string, content?: readonly any[], toolCallId?: unknown, isError?: unknown }} message
 * @param {Map<string, string>} toolNames
 * @returns {string}
 */
function compactMessage(message, toolNames) {
  const oneLine = (value, max) => {
    const text = value.replace(/\s+/gu, ' ').trim()
    if (text === '') return ''
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
  }
  if (message.role === 'tool') {
    const id = typeof message.toolCallId === 'string' ? message.toolCallId : ''
    const name = (id !== '' ? toolNames.get(id) : undefined) ?? 'tool'
    const text = oneLine(contentText(message.content), 120)
    const error = message.isError === true ? ' [error]' : ''
    return `Tool ${name}${error}: ${text === '' ? '[no output]' : text}`
  }
  if (message.role === 'assistant') {
    const parts = []
    for (const block of message.content ?? []) {
      if (block?.type === 'text' || block?.type === 'reasoning') {
        const text = oneLine(typeof block.text === 'string' ? block.text : '', 100)
        if (text !== '') parts.push(text)
      } else if (block?.type === 'tool-call') {
        const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool'
        const args = oneLine(typeof block.arguments === 'string' ? block.arguments : '', 70)
        parts.push(`${name}(${args})`)
      }
    }
    const text = oneLine(parts.join(' '), 220)
    return text === '' ? '' : `Assistant: ${text}`
  }
  const text = oneLine(contentText(message.content), 120)
  if (text === '') return ''
  return `${ROLE_LABELS[message.role] ?? 'User'}: ${text}`
}

/**
 * One line naming the available skills, kept instead of the full catalog.
 * @param {{ source?: { entries?: unknown }, content?: readonly any[] }} message
 * @returns {string}
 */
function skillSummary(message) {
  const entries = message?.source?.entries
  if (Array.isArray(entries)) {
    const names = entries
      .map(entry => entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : '')
      .filter(name => name !== '')
    if (names.length > 0) return `Skills: ${names.join(', ')}`
  }
  const text = contentText(message.content).trim().replace(/\s+/gu, ' ')
  return text === '' ? '' : `Skills: ${text.slice(0, 300)}`
}

/**
 * Build the call-id to tool-name map before rendering; an old assistant message
 * may be compacted away while its tool result is still shown.
 * @param {readonly any[]} messages
 * @returns {Map<string, string>}
 */
function collectToolNames(messages) {
  const names = new Map()
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool-call' && typeof block.id === 'string') {
        names.set(block.id, typeof block.name === 'string' && block.name !== '' ? block.name : 'tool')
      }
    }
  }
  return names
}

/**
 * Index of the last assistant message; the exchange from there to the end is
 * always kept in full so the model knows what it just asked for.
 * @param {readonly any[]} messages
 * @returns {number}
 */
function findLatestStart(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index
  }
  return Math.max(0, messages.length - 1)
}

/**
 * Build the portal's single `qst` string from the harness request.
 *
 * The portal has a hard prompt-length ceiling, so the transcript is assembled
 * with an explicit budget:
 *
 *   harness system prompt (capped) + tool catalog + task/context
 *   + compact older actions + the latest assistant/tool exchange (full)
 *
 * The latest exchange is allocated a total tool-result budget and every tool
 * result gets a head/tail excerpt. Older actions become one-line records, so
 * the model knows what it already read or ran instead of restarting the task.
 * @param {{ messages?: readonly any[], system?: unknown, tools?: readonly any[] }} options
 * @param {{ includeSystemPrompt: boolean, maxQuestionChars: number, maxToolResultChars?: number, maxToolResultTotalChars?: number, maxSystemPromptChars?: number }} settings
 * @returns {string}
 */
export function buildQuestion(options, settings) {
  const allMessages = Array.isArray(options.messages) ? options.messages : []
  const toolNames = collectToolNames(allMessages)
  const maxSystem = typeof settings.maxSystemPromptChars === 'number' ? settings.maxSystemPromptChars : 2_500

  const header = []
  if (settings.includeSystemPrompt) {
    const systems = []
    if (typeof options.system === 'string' && options.system.trim() !== '') {
      systems.push(`System: ${options.system.trim()}`)
    }
    for (const message of allMessages) {
      if (message?.role !== 'system' && message?.role !== 'developer') continue
      const text = contentText(message.content).trim()
      if (text !== '') systems.push(`${ROLE_LABELS[message.role]}: ${text}`)
    }
    let system = systems.join('\n\n')
    if (maxSystem > 0 && system.length > maxSystem) {
      system = `${system.slice(0, maxSystem)}\n[system prompt truncated]`
    }
    if (system !== '') header.push(system)
  }
  const catalog = formatToolCatalog(options.tools, { descriptions: !settings.includeSystemPrompt })
  if (catalog !== '') header.push(catalog)
  const headerText = header.join('\n\n')
  const budget = settings.maxQuestionChars - headerText.length - (headerText === '' ? 0 : 2)
  if (budget <= 0) return headerText.slice(0, settings.maxQuestionChars)

  const messages = allMessages.filter(message => message?.role !== 'system' && message?.role !== 'developer')
  if (messages.length === 0) return headerText

  const latestStart = findLatestStart(messages)
  const taskParts = []
  const runtimeParts = []
  let skills = ''
  const older = []
  for (let index = 0; index < latestStart; index += 1) {
    const message = messages[index]
    const kind = message?.source?.kind
    if (kind === 'time-context') continue
    if (kind === 'skill-catalog') {
      skills = skillSummary(message)
      continue
    }
    if (kind === 'runtime-context') {
      const text = contentText(message.content).trim()
      if (text !== '') runtimeParts.push(text)
      continue
    }
    if (message.role === 'user' && (kind === 'user' || kind === undefined)) {
      const text = contentText(message.content).trim()
      if (text !== '') taskParts.push(text)
      continue
    }
    older.push(message)
  }

  let pinned = ''
  const taskText = taskParts.join('\n\n')
  if (taskText !== '') {
    pinned += `User: ${truncateToolText(taskText, Math.min(2_500, Math.max(500, Math.floor(budget / 3))), 'task truncated')}\n\n`
  }
  const runtimeText = runtimeParts.join('\n\n')
  if (runtimeText !== '') {
    pinned += `Context:\n${truncateToolText(runtimeText, Math.min(1_500, Math.max(300, Math.floor(budget / 4))), 'context truncated')}\n\n`
  }
  if (skills !== '' && pinned.length + skills.length + 2 < budget * 0.5) {
    pinned += `${skills}\n\n`
  }
  pinned = pinned.trim()

  const latest = messages.slice(latestStart)
  const latestNonTool = []
  const latestTools = []
  for (const message of latest) {
    if (message.role === 'tool') {
      latestTools.push(message)
      continue
    }
    const rendered = renderMessage(message, toolNames, settings)
    if (rendered !== '') latestNonTool.push(rendered)
  }

  const marker = '[earlier conversation compacted]'
  const pinnedLength = pinned === '' ? 0 : pinned.length + 2
  const nonToolText = latestNonTool.join('\n\n')
  const nonToolLength = nonToolText === '' ? 0 : nonToolText.length + 2
  const reserveOlder = older.length === 0 ? 0 : Math.min(1_200, Math.floor(budget / 5))
  const toolBudget = Math.max(0, budget - pinnedLength - nonToolLength - reserveOlder - (older.length === 0 ? 0 : marker.length + 2))
  const perTool = latestTools.length === 0
    ? 0
    : Math.max(80, Math.min(
      typeof settings.maxToolResultChars === 'number' ? settings.maxToolResultChars : 2_000,
      Math.floor(toolBudget / latestTools.length),
    ))

  const latestParts = []
  for (const message of latest) {
    const rendered = message.role === 'tool'
      ? renderMessage(message, toolNames, settings, perTool)
      : renderMessage(message, toolNames, settings)
    if (rendered !== '') latestParts.push(rendered)
  }

  const latestText = latestParts.join('\n\n')
  const used = pinnedLength + (latestText === '' ? 0 : latestText.length + 2)
  const remaining = Math.max(0, budget - used - (older.length === 0 ? 0 : marker.length + 2))
  const compact = []
  let compactLength = 0
  for (let index = older.length - 1; index >= 0; index -= 1) {
    const line = compactMessage(older[index], toolNames)
    if (line === '') continue
    if (compactLength + line.length + 1 > remaining) break
    compact.unshift(line)
    compactLength += line.length + 1
  }

  const body = []
  if (pinned !== '') body.push(pinned)
  if (older.length > 0) {
    body.push(compact.length === 0 ? marker : `${marker}\n${compact.join('\n')}`)
  }
  if (latestText !== '') body.push(latestText)
  const bodyText = body.join('\n\n')
  const assembled = [headerText, bodyText].filter(Boolean).join('\n\n')
  return assembled.length <= settings.maxQuestionChars
    ? assembled
    : assembled.slice(0, settings.maxQuestionChars)
}

/**
 * Resolve one DSH session's key. `sessionId` is process-local; the fallback
 * covers one-shot and auxiliary requests.
 * @param {{ sessionId?: unknown }} options
 * @returns {string}
 */
function sessionKey(options) {
  return typeof options?.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : 'default'
}

/**
 * Synthesize a session title locally. A `session-title` request is an
 * auxiliary call: routing it through the portal would consume quota, pollute
 * the agent's only conversation, and (because the title instruction is a
 * system prompt) produce a task answer rather than a title.
 * @param {{ messages?: readonly any[] }} options
 * @returns {string}
 */
function titleFrom(options) {
  for (const message of options.messages ?? []) {
    if (message?.role !== 'user') continue
    const text = contentText(message.content).trim()
    if (text === '') continue
    const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
    const clean = line.replace(/[#*`>_]/gu, '').replace(/\s+/gu, ' ').trim()
    if (clean === '') continue
    return clean.length <= 60 ? clean : `${clean.slice(0, 57).trimEnd()}…`
  }
  return 'New session'
}

/**
 * Build a deterministic compaction summary locally. The portal has one active
 * conversation and a small prompt limit, so sending the compaction request
 * through it would both pollute the agent and likely exceed the limit.
 * @param {{ messages?: readonly any[] }} options
 * @param {{ maxQuestionChars: number, maxToolResultChars: number }} settings
 * @returns {string}
 */
function compactionFrom(options, settings) {
  const transcript = buildQuestion({ messages: options.messages ?? [], tools: [] }, {
    includeSystemPrompt: false,
    maxQuestionChars: Math.min(4_000, settings.maxQuestionChars),
    maxToolResultChars: settings.maxToolResultChars,
  })
  return transcript === ''
    ? 'No prior conversation to compact.'
    : `Compacted conversation (latest state):\n\n${transcript}`
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
 * @property {number} maxToolResultChars
 * @property {number} maxToolResultTotalChars
 * @property {number} maxSystemPromptChars
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
    /** Conversation id used by the default conversation. */
    this.sessionId = options.sessionId !== '' ? options.sessionId : randomUUID()
    /**
     * Per-DSH-session portal conversations. The portal allows one active
     * conversation per account, so these are opened serially and the active id
     * is tracked separately.
     * @type {Map<string, { id: string, claimed: boolean, model: string | undefined }>}
     */
    this.sessions = new Map()
    /** Portal conversation currently open on the account, if any. */
    this.activePortalId = undefined
    /** Serializes portal requests; the portal itself allows one active conversation. */
    this.portalLock = Promise.resolve()
  }

  /**
   * Compatibility view of the default conversation's claim state.
   * @returns {string | undefined}
   */
  get claimedSessionId() {
    const state = this.sessions.get('default')
    return state?.claimed === true ? state.id : undefined
  }

  /**
   * Compatibility view of the default conversation's claimed model.
   * @returns {string | undefined}
   */
  get claimedModel() {
    return this.sessions.get('default')?.model
  }

  /**
   * Resolve one DSH session's portal conversation state.
   * @param {string} key
   * @returns {{ id: string, claimed: boolean, model: string | undefined }}
   */
  sessionState(key) {
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = {
        id: key === 'default' ? this.sessionId : randomUUID(),
        claimed: false,
        model: undefined,
      }
      this.sessions.set(key, state)
    }
    return state
  }

  /**
   * Serialize portal access. Tool execution happens between model calls, so the
   * lock only spans the portal request and its answer, not the whole turn.
   * @returns {Promise<() => void>}
   */
  async acquirePortal() {
    const previous = this.portalLock
    let release
    this.portalLock = new Promise(resolve => { release = resolve })
    await previous
    return release
  }

  /**
   * @param {string} provider
   * @returns {{ id: string, name: string }}
   */
  providerInfo(provider) {
    return { id: provider, name: 'The portal chatbot' }
  }

  /**
   * Retry the transient portal failures the adapter classifies. The portal is
   * a browser-session API, so a short bounded backoff is safer than a long
   * retry storm.
   * @returns {{ mode: 'normal', initialDelayMs: number, maxDelayMs: number, jitterRatio: number, maxRetries: number, retryableCodes: readonly string[] }}
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      initialDelayMs: 500,
      maxDelayMs: 8_000,
      jitterRatio: 0.1,
      maxRetries: 2,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE', 'MALFORMED_RESPONSE'],
    })
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

      // Auxiliary calls must not touch the agent's only portal conversation.
      // Titles are synthesized locally; compaction produces a deterministic
      // summary rather than sending a second model request through the portal.
      const purpose = typeof options.purpose === 'string' ? options.purpose : ''
      if (purpose === 'session-title') {
        yield* this.localAnswer(titleFrom(options))
        return
      }
      if (purpose === 'compaction') {
        yield* this.localAnswer(compactionFrom(options, this.options))
        return
      }

      const cookie = await this.resolveCookie()
      const model = wireModel(options.model)
      const state = this.sessionState(sessionKey(options))
      const { style, sessionOnly, acceptDisclaimer } = this.options

      const release = await this.acquirePortal()
      try {
        yield* this.portalAnswer({
          options,
          signal,
          cookie,
          model,
          state,
          style,
          sessionOnly,
          acceptDisclaimer,
        })
      } finally {
        release()
      }
    } catch (error) {
      if (error instanceof CtuPortalError) {
        // The portal's one-active-session guard means the next attempt must
        // open the conversation again, after the user closes the other tab.
        if (error.code === 'INVALID_REQUEST' && /active chatbot session/iu.test(error.message)) {
          const state = this.sessions.get(sessionKey(options))
          if (state !== undefined) {
            state.claimed = false
            state.model = undefined
          }
          this.activePortalId = undefined
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
   * Answer a local (non-portal) auxiliary request.
   * @param {string} text
   * @returns {AsyncGenerator<object, void, void>}
   */
  async * localAnswer(text) {
    const answer = text.trim() === '' ? 'No separate response is needed.' : text
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    const outputTokens = estimateTokens(answer)
    yield {
      type: 'usage',
      usage: { inputTokens: 0, outputTokens, totalTokens: outputTokens },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * Open this session's portal conversation and stream one answer, parsing a
   * DSML tool block into harness tool-call chunks as the text arrives.
   * @param {object} context
   * @returns {AsyncGenerator<object, void, void>}
   */
  async * portalAnswer({ options, signal, cookie, model, state, style, sessionOnly, acceptDisclaimer }) {
    if (this.activePortalId !== state.id || !state.claimed || state.model !== model) {
      await openConversation({
        baseURL: this.options.baseURL,
        cookie,
        id: state.id,
        model,
        style,
        sessionOnly,
        acceptDisclaimer,
        signal,
      })
      state.claimed = true
      state.model = model
      this.activePortalId = state.id
    }

    let question = buildQuestion(options, this.options)
    if (question === '') {
      throw new CtuPortalError('The portal adapter received no text to ask', 'INVALID_REQUEST')
    }

    let answer = ''
    let emitted = 0
    let markerAt = -1
    let textStarted = false
    let textContent = ''
    let calls = []

    // One retry with a smaller transcript if the portal's length guard fires.
    // The guard is an unframed body, so no text was emitted when it throws.
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      answer = ''
      emitted = 0
      markerAt = -1
      textStarted = false
      textContent = ''
      calls = []
      try {
        for await (const delta of chatStream({
          baseURL: this.options.baseURL,
          cookie,
          id: state.id,
          model,
          qst: question,
          style,
          sessionOnly,
          signal,
        })) {
          answer += delta
          if (markerAt !== -1) continue

          const at = findToolMarker(answer)
          if (at !== -1) {
            const text = answer.slice(emitted, at)
            if (text !== '') {
              if (!textStarted) {
                textStarted = true
                yield { type: 'block-start', index: 0, blockType: 'text' }
              }
              textContent += text
              yield { type: 'text-delta', index: 0, text }
            }
            emitted = at
            markerAt = at
            continue
          }

          // Hold back a suffix that could become the tool marker, so a marker
          // split across portal chunks is never shown as visible text.
          const safe = answer.length - longestMarkerSuffix(answer)
          if (safe > emitted) {
            const text = answer.slice(emitted, safe)
            if (!textStarted) {
              textStarted = true
              yield { type: 'block-start', index: 0, blockType: 'text' }
            }
            textContent += text
            yield { type: 'text-delta', index: 0, text }
            emitted = safe
          }
        }
        break
      } catch (error) {
        if (attempt === 0 && error instanceof CtuPortalError && error.code === 'CONTEXT_WINDOW_EXCEEDED') {
          question = buildQuestion(options, {
            ...this.options,
            maxQuestionChars: Math.max(4_000, Math.floor(question.length * 0.6)),
          })
          continue
        }
        throw error
      }
    }

    if (answer.trim() === '') {
      throw new CtuPortalError('The portal returned an empty answer', 'EMPTY_RESPONSE')
    }

    if (markerAt === -1) {
      const tail = answer.slice(emitted)
      if (tail !== '') {
        if (!textStarted) {
          textStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        textContent += tail
        yield { type: 'text-delta', index: 0, text: tail }
      }
    } else {
      const parsed = extractToolCalls(answer)
      calls = parsed.calls
      if (calls.length === 0) {
        // The marker was incomplete or malformed: preserve the raw remainder
        // as text rather than dropping the model's output.
        const tail = answer.slice(emitted)
        if (tail !== '') {
          if (!textStarted) {
            textStarted = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          textContent += tail
          yield { type: 'text-delta', index: 0, text: tail }
        }
      }
    }

    if (textStarted) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: textContent } }
    }

    const toolByName = new Map()
    for (const tool of options.tools ?? []) {
      if (tool !== null && typeof tool === 'object' && typeof tool.name === 'string') {
        toolByName.set(tool.name, tool)
      }
    }

    let index = textStarted ? 1 : 0
    for (const call of calls) {
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
      reason: { kind: calls.length > 0 ? 'tool-calls' : 'stop' },
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
