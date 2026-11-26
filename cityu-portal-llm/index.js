/**
 * CityUHK Portal Chatbot — a DeepSeek Harness LLM adapter plugin.
 *
 * The CityUHK IT-portal chatbot (`/portal/category/5`) answers over a
 * proprietary JSON + streamed-markdown protocol, not an OpenAI-compatible one.
 * This bundle adapts it to the harness LLM seam as provider `cityu-portal`:
 *
 *   - `apply` registers exactly one provider route with the `llm` service;
 *   - the adapter maps harness messages onto the portal's single `qst` string,
 *     claims the portal's one active conversation, and streams the markdown
 *     answer back as one text block;
 *   - failures carry harness failure codes so retry and UI handling behave like
 *     any other provider.
 *
 * The bundle imports no `@deepseek-ai/*` package at runtime, so it resolves
 * from the profile's own node_modules without a duplicate harness install.
 *
 * @module @local/cityu-portal-llm
 */

import { CityuPortalAdapter } from './lib/adapter.js'
import { resolveOptions } from './lib/config.js'
import { MODELS, PROVIDER_ID } from './lib/models.js'

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'llm-cityu-portal'

/** The LLM seam is required; the plugin stays pending until it exists. */
export const inject = ['llm']

/**
 * Register the CityUHK provider with the host LLM runtime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {Record<string, unknown> | undefined} config - loader-supplied config.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const adapter = new CityuPortalAdapter(options)
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  ctx.logger?.info?.(
    `llm-cityu-portal: registered provider "${PROVIDER_ID}" with `
    + `${MODELS.length} models (cookie from ${options.cookieEnv})`,
  )
}
