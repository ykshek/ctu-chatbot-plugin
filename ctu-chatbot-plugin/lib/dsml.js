/**
 * DSML tool-call parsing and reporting for the portal chatbot.
 *
 * The portal only accepts a single text `qst`; it has no native tool channel.
 * A DeepSeek-backed portal model therefore emits the same DSML markup the
 * harness's own DeepSeek adapter understands:
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="bash">
 *   <｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * This module turns that markup into harness tool-call blocks and renders the
 * tool catalog and the resulting transcript back into the portal's `qst`.
 */

/** Opening-tag prefix; accepts U+FF5C (the model's fullwidth bar) and ASCII `|`. */
const OPEN = String.raw`<\s*[|｜]\s*DSML\s*[|｜]\s*`

/** Closing-tag prefix. */
const CLOSE = String.raw`<\/\s*[|｜]\s*DSML\s*[|｜]\s*`

/**
 * @typedef {object} ParsedToolCall
 * @property {string} name
 * @property {Record<string, unknown>} arguments
 */

/**
 * @typedef {object} ParsedAnswer
 * @property {string} text - the answer outside the tool-call block
 * @property {ParsedToolCall[]} calls
 */

/**
 * Extract tool calls from one portal answer. Text outside the tool block is
 * preserved; an answer without a complete block is returned unchanged.
 * @param {string} answer
 * @returns {ParsedAnswer}
 */
export function extractToolCalls(answer) {
  const open = new RegExp(`${OPEN}tool_calls\\s*>`, 'u').exec(answer)
  if (open === null) return { text: answer, calls: [] }

  const closePattern = new RegExp(`${CLOSE}tool_calls\\s*>`, 'gu')
  closePattern.lastIndex = open.index + open[0].length
  const close = closePattern.exec(answer)
  if (close === null) return { text: answer, calls: [] }

  const body = answer.slice(open.index + open[0].length, close.index)
  const calls = parseInvokes(body)
  if (calls.length === 0) return { text: answer, calls: [] }

  const before = answer.slice(0, open.index).trim()
  const after = answer.slice(close.index + close[0].length).trim()
  return {
    text: [before, after].filter(part => part !== '').join('\n\n'),
    calls,
  }
}

/**
 * Parse every `<invoke>` in one tool-call block.
 * @param {string} body
 * @returns {ParsedToolCall[]}
 */
function parseInvokes(body) {
  const pattern = new RegExp(`${OPEN}invoke\\s+([^>]*?)\\s*>([\\s\\S]*?)${CLOSE}invoke\\s*>`, 'gu')
  const calls = []
  for (const match of body.matchAll(pattern)) {
    const name = attribute(match[1], 'name')
    if (name === undefined || name === '') continue
    calls.push({ name, arguments: parseParameters(match[2]) })
  }
  return calls
}

/**
 * Parse the `<parameter>` elements inside one invoke.
 * @param {string} body
 * @returns {Record<string, unknown>}
 */
function parseParameters(body) {
  const pattern = new RegExp(`${OPEN}parameter\\s+([^>]*?)\\s*>([\\s\\S]*?)${CLOSE}parameter\\s*>`, 'gu')
  /** @type {Record<string, unknown>} */
  const args = {}
  for (const match of body.matchAll(pattern)) {
    const name = attribute(match[1], 'name')
    if (name === undefined || name === '') continue
    const value = match[2]
    args[name] = attribute(match[1], 'string') === 'false' ? jsonValue(value) : value
  }
  return args
}

/**
 * Read one XML-style attribute with either quote style.
 * @param {string} source
 * @param {string} name
 * @returns {string | undefined}
 */
function attribute(source, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu')
  const match = pattern.exec(source)
  if (match === null) return undefined
  return match[1] ?? match[2]
}

/**
 * Parse a `string="false"` value as JSON, falling back to the raw text.
 * @param {string} value
 * @returns {unknown}
 */
function jsonValue(value) {
  try {
    return JSON.parse(value)
  } catch (_notJson) {
    return value
  }
}

/**
 * Coerce textual arguments against a tool's JSON schema. The model marks some
 * values as strings even when the schema wants a number, boolean, or object;
 * that would otherwise be rejected by the tool's validator.
 * @param {Record<string, unknown>} args
 * @param {{ parameters?: { properties?: Record<string, { type?: unknown }> } } | undefined} tool
 * @returns {Record<string, unknown>}
 */
export function coerceArguments(args, tool) {
  const properties = tool?.parameters?.properties
  if (properties === undefined || properties === null || typeof properties !== 'object') return args
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue
    const type = /** @type {{ type?: unknown } | undefined} */ (properties[key])?.type
    if (type === 'number' || type === 'integer' || type === 'boolean' || type === 'object' || type === 'array') {
      const parsed = jsonValue(value)
      if (parsed !== value) args[key] = parsed
    }
  }
  return args
}

/**
 * Render the harness's tool declarations as portal text.
 *
 * The portal has no native `tools` field, so the catalog and the call syntax
 * must travel inside the one `qst` string. Signatures keep the prompt small:
 * the full JSON Schema for the default toolset is ~32k characters, while the
 * compact signatures plus short descriptions are a few thousand. The full
 * schema is not sent to the model; the adapter coerces common scalar types and
 * the harness validates the final call.
 * @param {readonly { name?: unknown, description?: unknown, parameters?: unknown }[] | undefined} tools
 * @returns {string}
 */
export function formatToolCatalog(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const lines = [
    'You can use the tools below. To call one or more tools, emit one tool-call block:',
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="TOOL_NAME">',
    '<｜DSML｜parameter name="ARGUMENT" string="true">VALUE</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜tool_calls>',
    'Use string="false" for JSON numbers, booleans, objects, and arrays. Put no Markdown fence around the block. '
      + 'After a tool result arrives, continue the task: call more tools or give the final answer.',
    'Available tools:',
  ]
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || tool.name === '') continue
    const description = typeof tool.description === 'string'
      ? tool.description.replace(/\s+/gu, ' ').trim().slice(0, 80)
      : ''
    lines.push(`- ${tool.name}(${signature(tool.parameters)}): ${description}`)
  }
  return lines.join('\n')
}

/**
 * Render one tool's parameters as `name*:type` pairs.
 * @param {unknown} parameters
 * @returns {string}
 */
function signature(parameters) {
  if (parameters === null || typeof parameters !== 'object') return ''
  const properties = /** @type {{ properties?: unknown, required?: unknown }} */ (parameters).properties
  if (properties === null || typeof properties !== 'object') return ''
  const required = new Set(Array.isArray(/** @type {{ required?: unknown }} */ (parameters).required)
    ? /** @type {{ required?: unknown }} */ (parameters).required
    : [])
  const parts = []
  for (const [name, value] of Object.entries(properties)) {
    const type = value !== null && typeof value === 'object'
      ? /** @type {{ type?: unknown }} */ (value).type
      : undefined
    parts.push(`${name}${required.has(name) ? '*' : ''}${typeof type === 'string' ? `:${type}` : ''}`)
  }
  return parts.join(', ')
}
