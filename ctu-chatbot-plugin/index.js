/**
 * The portal chatbot — a DeepSeek Harness LLM adapter plugin.
 *
 * The GenAI chatbot (`/portal/category/5`) answers over the portal's
 * proprietary JSON + framed-markdown protocol, not an OpenAI-compatible one.
 * This bundle adapts it to the harness LLM seam as provider `ctu-portal`:
 *
 *   - `apply` registers exactly one provider route with the `llm` service;
 *   - the adapter maps harness messages onto the portal's single `qst` string,
 *     opens the portal's one active conversation, strips the `<id>,,,` answer
 *     frame, and streams the markdown back as one text block;
 *   - the same adapter reports estimated token usage, so the harness Usage and
 *     speed readings work for a provider that counts nothing;
 *   - failures carry harness failure codes so retry and UI handling behave like
 *     any other provider.
 *
 * It also exposes the account's per-model quota to the Web client over the
 * Typert Remote seam: the portal reports quota per model, so the client cannot
 * derive it from session state and needs a host round trip.
 *
 * The bundle is plain ESM with no build step. It imports only packages the host
 * installation already provides (`@deepseek-ai/dsh-typert-protocol` and `zod`),
 * which the Loader resolves for a plugin through its bare-module base URL.
 *
 * @module ctu-chatbot-plugin
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { CtuPortalAdapter } from './lib/adapter.js'
import { resolveOptions } from './lib/config.js'
import { MODELS, PROVIDER_ID, wireModel } from './lib/models.js'
import { normalizeCookie } from './lib/protocol.js'

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'llm-ctu-portal'

/**
 * The LLM seam is required; the plugin stays pending until it exists. `typert`
 * publishes the Remote registry, and `credentials` stores the portal session
 * cookie the settings page writes.
 */
export const inject = ['llm', 'typert', 'credentials']

/** Cordis service key and Remote namespace owned by this plugin. */
const SERVICE_KEY = 'ctu-quota'

/** Remote package name; the registry allows one registration per package. */
const PACKAGE = 'ctu-chatbot-plugin'

/**
 * Result codec for a method that answers with plain JSON.
 *
 * `src-json` needs no zod schema, so a method with no parameter carries no
 * builder at all; only the two value-taking methods below declare one.
 */
const JSON_RESULT = Object.freeze({ mode: 'src-json' })

/**
 * Strict codec for one string parameter.
 * @param {string} typeSymbol - stable identity of the declared type.
 * @returns {{ mode: 'strict', typeSymbol: string, create: () => unknown, jsonSchema: { type: 'string' } }}
 */
function stringCodec(typeSymbol) {
  return {
    mode: 'strict',
    typeSymbol,
    // The gateway validates with `codec.create().parse(value)`.
    create: () => z.string(),
    jsonSchema: { type: 'string' },
  }
}

/**
 * One `json` parameter carrying a string.
 * @param {string} parameter - parameter name, also its wire field.
 * @param {string} description - documentation shown to generated clients.
 * @returns {object}
 */
function stringParameter(parameter, description) {
  const typeSymbol = `${PACKAGE}#${SERVICE_KEY}:${parameter}`
  return {
    name: parameter,
    wire: parameter,
    description,
    source: 'json',
    codec: stringCodec(typeSymbol),
    strictCodec: stringCodec(typeSymbol),
  }
}

/**
 * Describe one direct Remote method.
 * @param {string} method - service method name; the gateway calls it by this name.
 * @param {readonly object[]} parameters
 * @param {string} description
 * @returns {object}
 */
function descriptor(method, parameters, description) {
  return {
    id: `${PACKAGE}#${SERVICE_KEY}/${method}`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method,
    description,
    invocation: { kind: 'direct' },
    parameters,
    result: JSON_RESULT,
  }
}

/** Every Remote method this plugin publishes, in declaration order. */
const DESCRIPTORS = Object.freeze([
  descriptor('getAuthStatus', [], 'Whether a portal session cookie is stored, and where it comes from.'),
  descriptor('getAllQuotas', [], 'Every model\'s portal quota, cached briefly.'),
  descriptor('getQuota', [stringParameter('model', 'Wire model key, or LAST for the most recently used one.')], 'One model\'s portal quota.'),
  descriptor('setCookie', [stringParameter('cookie', 'Cookie header value copied from a signed-in portal request.')], 'Store the portal session cookie and verify it.'),
  descriptor('clearCookie', [], 'Remove the stored portal session cookie.'),
])

/**
 * Reflection model for a package that publishes no generated Typert artifact.
 * The registry stores it beside the invocation descriptors; the API Gateway
 * dispatches from the descriptors alone.
 */
const REFLECTION = Object.freeze({ services: [], events: [], objects: [] })

/**
 * Publish the account's per-model portal quota to the Web client.
 *
 * Quota cannot ride a session projection: projections fold session events only,
 * so a value fetched from the portal would never invalidate. A Remote method
 * gives the client a host round trip instead, and this service is also the one
 * place that knows whether a usable cookie exists.
 */
export class CtuQuotaService extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
   * @param {{ adapter: CtuPortalAdapter, cookieEnv: string }} config
   */
  constructor(ctx, config) {
    super(ctx, SERVICE_KEY)
    this.adapter = config.adapter
    /** Credential reference: the same name a headless install reads from the environment. */
    this.cookieEnv = config.cookieEnv
    /** @type {{ at: number, value: object | undefined }} */
    this.cache = { at: 0, value: undefined }
  }

  /**
   * Report cookie presence for the settings page without exposing the value.
   * @returns {Promise<object>}
   */
  async getAuthStatus() {
    const info = await this.ctx.credentials.describe(this.cookieEnv)
    return {
      configured: info.configured === true,
      source: info.source,
      writable: info.writable === true,
      masked: info.masked,
      credentialName: this.cookieEnv,
    }
  }

  /**
   * Read one model's quota. Accepts either the harness model id the client
   * selects with or a raw portal wire key, because the settings table names
   * wire models while the composer pill names the selected harness model.
   * @param {string} model - harness model id or wire model key.
   * @returns {Promise<object>}
   */
  async getQuota(model) {
    return this.adapter.readQuota(wireModel(model))
  }

  /**
   * Read every model's quota, reusing the last answer until it expires.
   * @returns {Promise<object>}
   */
  async getAllQuotas() {
    const ttl = this.adapter.options.quotaCacheMs
    if (this.cache.value !== undefined && Date.now() - this.cache.at < ttl) {
      return { ...this.cache.value, cached: true }
    }
    const answer = await this.adapter.readAllQuotas()
    const value = { ...answer, cached: false, fetchedAt: new Date().toISOString() }
    this.cache = { at: Date.now(), value }
    return value
  }

  /**
   * Store the session cookie and prove it works before reporting success.
   * @param {string} cookie - pasted Cookie header value.
   * @returns {Promise<object>}
   */
  async setCookie(cookie) {
    const value = normalizeCookie(typeof cookie === 'string' ? cookie : '')
    if (value === '') {
      return { ok: false, error: 'Paste the Cookie header value from a signed-in portal request.' }
    }
    await this.ctx.credentials.set(this.cookieEnv, value)
    this.cache = { at: 0, value: undefined }
    return this.probe()
  }

  /**
   * Remove the stored cookie; an environment fallback becomes effective again.
   * @returns {Promise<object>}
   */
  async clearCookie() {
    await this.ctx.credentials.unset(this.cookieEnv)
    this.cache = { at: 0, value: undefined }
    return { ok: true, status: await this.getAuthStatus() }
  }

  /**
   * Verify the configured cookie against the portal's own quota call.
   *
   * Chat and quota share the `chatbot` module now, so `getusage` is both the
   * reachability probe and the quota read; no separate chat-history probe is
   * needed, and no conversation is opened just to test a cookie.
   * @returns {Promise<object>}
   */
  async probe() {
    const status = await this.getAuthStatus()
    try {
      const quota = await this.adapter.readQuota('LAST')
      return { ok: true, quota, status }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        status,
      }
    }
  }
}

/**
 * Register the portal provider, the quota Remote methods, and the credential
 * reader the adapter resolves cookies through.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {Record<string, unknown> | undefined} config - loader-supplied config.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const adapter = new CtuPortalAdapter(options, {
    // Read through the credential seam per request, so a cookie saved on the
    // plugin's bundle page reaches the next call without restarting the plugin.
    credentialReader: async () => (await ctx.credentials.resolve(options.cookieEnv))?.value,
  })
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  ctx.plugin(CtuQuotaService, { adapter, cookieEnv: options.cookieEnv })
  // The API Gateway dispatches from `typert.local`, the registry a package
  // publishes its invocation descriptors into; `typert.remotes` is the
  // separate client/offline registry and serves no route. The package ships no
  // generated Typert artifact, so it registers its hand-written descriptors
  // directly and publishes an empty reflection model.
  ctx.effect(() => {
    // The registry allows one registration per package and throws on a repeat.
    // A reload normally disposes the previous generation first, but a generation
    // that is still live already publishes exactly these descriptors, so adopt it
    // instead of failing the whole plugin over the duplicate.
    const held = DESCRIPTORS.every(descriptor =>
      ctx.typert.local.get(`${descriptor.namespace}/${descriptor.method}`)?.id === descriptor.id)
    if (held) return () => {}
    return ctx.typert.register({
      package: PACKAGE,
      face: 'host',
      schemas: [],
      model: REFLECTION,
      invocations: DESCRIPTORS,
    })
  }, 'ctu-chatbot-plugin: quota Remote methods')
  ctx.logger?.info?.(
    `llm-ctu-portal: registered provider "${PROVIDER_ID}" with `
    + `${MODELS.length} models (cookie credential ${options.cookieEnv})`,
  )
}
