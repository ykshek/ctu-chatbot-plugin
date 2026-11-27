/**
 * CityUHK Portal Chatbot — Web client half.
 *
 * Two surfaces, both owned by this plugin:
 *
 *   1. the configuration of its own bundle page in Plugins → Installed
 *      plugins → CityUHK portal chatbot, where the portal session cookie is
 *      pasted and every model's remaining quota is listed;
 *   2. a composer-dock pill showing the selected model's remaining quota, so
 *      the figure sits beside the harness performance readings.
 *
 * Plain ESM with no build step: the client module loader supplies `require`
 * for the platform modules (`react`, `zod`). Quota lives on the Host — the
 * portal reports it per model and no session projection can carry it — so both
 * surfaces call the Remote methods that the plugin's `index.js` publishes.
 */

window.__ModuleLoader__.load({
  id: 'ctu-chatbot-plugin',
  factory(require) {
    const React = require('react')
    const { z } = require('zod')

    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Must match the Host service key in `index.js`. */
    const SERVICE_KEY = 'ctu-quota'
    /** Must match the package name the Host registers its descriptors under. */
    const PACKAGE = 'ctu-chatbot-plugin'
    /** Provider route the pill belongs to; any other selection hides it. */
    const PROVIDER_ID = 'cityu-portal'
    /** Refresh cadence for the pill, matching the portal widget's own freshness. */
    const POLL_MS = 30_000
    /** Locale namespace for every string this half renders. */
    const NS = 'ctu-chatbot'

    const JSON_RESULT = Object.freeze({ mode: 'src-json' })

    /** English copy; the plugin ships no other locale yet. */
    const en = {
      settings: {
        sessionTitle: 'Portal session',
        checking: 'Checking the stored cookie…',
        configured: 'Session cookie configured ({source}).',
        configuredNoSource: 'Session cookie configured.',
        missing: 'No session cookie stored. Paste one below to sign in.',
        help: 'Sign in at www.cityu.edu.hk/portal, open the browser developer tools, copy the value of the Cookie request header from any portal request, and paste it here. It includes the incap_ses_* and reese84 cookies, so paste the whole header value rather than a single cookie.',
        placeholder: 'Cookie: .AspNetCore.Cookies=...',
        save: 'Save',
        saving: 'Saving…',
        clear: 'Clear',
        saved: 'Cookie saved and verified against the portal.',
        cleared: 'Stored cookie removed.',
        rejected: 'The portal rejected that cookie.',
        saveFailed: 'Could not save the cookie.',
        clearFailed: 'Could not remove the stored cookie.',
        statusFailed: 'Could not read the stored cookie status.',
        quotasTitle: 'Model quotas',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        quotasHint: 'Each model on the portal has its own allowance. The figures come from the portal and are not estimates.',
        quotasFailed: 'Could not read the portal quota.',
        quotasEmpty: 'No quota information available yet.',
        loading: 'Loading…',
        unlimited: 'unlimited',
        noQuota: '—',
        columnModel: 'Model',
        columnLeft: 'Left',
        columnQuota: 'Quota',
        columnResets: 'Resets',
      },
      pill: {
        reading: 'Quota: …',
        unavailable: 'Quota: —',
        unlimited: 'Quota: unlimited',
        leftOfQuota: 'Quota: {left} / {quota}',
        titleReading: 'Reading the portal quota…',
        titleLeftOf: '{model}: {left} of {quota} left',
        titleWithReset: '{model}: {left} of {quota} left · resets {resets}',
        titleUnlimited: '{model} has no finite portal quota',
        titleNoQuota: 'The portal reports no per-model quota for {model}',
      },
    }

    /**
     * Strict codec for one string parameter. The Client validates arguments
     * with this before sending, and the Host validates them again on arrival.
     * @param {string} typeSymbol
     */
    function stringCodec(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol,
        create: () => z.string(),
        jsonSchema: { type: 'string' },
      }
    }

    /** One `json` parameter carrying a string. */
    function stringParameter(name, description) {
      const typeSymbol = `${PACKAGE}#${SERVICE_KEY}:${name}`
      return {
        name,
        wire: name,
        description,
        source: 'json',
        codec: stringCodec(typeSymbol),
        strictCodec: stringCodec(typeSymbol),
      }
    }

    /** Describe one direct Remote method. */
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

    /** Mirror of the Host descriptor list; both halves must agree. */
    const DESCRIPTORS = [
      descriptor('getAuthStatus', [], 'Whether a portal session cookie is stored, and where it comes from.'),
      descriptor('getAllQuotas', [], 'Every model\'s portal quota, cached briefly.'),
      descriptor('getQuota', [stringParameter('model', 'Wire model key, or LAST for the most recently used one.')], 'One model\'s portal quota.'),
      descriptor('setCookie', [stringParameter('cookie', 'Cookie header value copied from a signed-in portal request.')], 'Store the portal session cookie and verify it.'),
      descriptor('clearCookie', [], 'Remove the stored portal session cookie.'),
    ]

    /**
     * Call one Remote method, folding every failure shape into the same result
     * so components never unwrap a thrown error.
     * @param {any} ctx - client context owning the namespace service.
     * @param {string} method
     * @param {unknown} [argument]
     */
    async function callRemote(ctx, method, argument) {
      const service = ctx.get(`remote.${SERVICE_KEY}`)
      if (service === undefined) {
        return { ok: false, error: { message: 'The CityUHK portal chatbot host service is not available.' } }
      }
      try {
        return argument === undefined
          ? await service[method]()
          : await service[method](argument)
      } catch (error) {
        return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
      }
    }

    /**
     * Render a token count the way the rest of the dock does.
     * @param {unknown} value
     */
    function formatCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toLocaleString('en-US')
    }

    const pillStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.35em',
      padding: '0.1em 0.5em',
      borderRadius: '0.75em',
      fontSize: '0.75em',
      lineHeight: '1.5',
      color: 'var(--dsh-text-secondary, #8b8b8b)',
      whiteSpace: 'nowrap',
      cursor: 'default',
    }

    const sectionStyle = { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.25rem 0' }
    const rowStyle = { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }
    const fieldStyle = {
      flex: '1 1 20rem',
      minWidth: '12rem',
      padding: '0.45rem 0.6rem',
      borderRadius: '0.375rem',
      border: '1px solid var(--dsh-border-default, #3a3a3a)',
      background: 'var(--dsh-surface-sunken, transparent)',
      color: 'inherit',
      font: 'inherit',
    }
    const buttonStyle = {
      padding: '0.45rem 0.9rem',
      borderRadius: '0.375rem',
      border: '1px solid var(--dsh-border-default, #3a3a3a)',
      background: 'var(--dsh-surface-raised, transparent)',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
    }
    const hintStyle = { fontSize: '0.85em', color: 'var(--dsh-text-secondary, #8b8b8b)', margin: 0 }
    const dangerStyle = { ...hintStyle, color: 'var(--dsh-danger, #e5534b)' }
    const tableStyle = { borderCollapse: 'collapse', width: '100%', fontSize: '0.9em' }
    const cellStyle = { padding: '0.3rem 0.5rem', borderBottom: '1px solid var(--dsh-border-subtle, #2c2c2c)', textAlign: 'left' }
    const numberCellStyle = { ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

    /**
     * Per-model quota table. A failed row keeps its own marker so one
     * unavailable model does not blank the others.
     * @param {{ quotas: any, busy: boolean, error: string | null, onRefresh: () => void, t: any }}
     */
    function QuotaTable({ quotas, busy, error, onRefresh, t }) {
      const models = quotas !== null && quotas !== undefined && Array.isArray(quotas.models) ? quotas.models : []
      const readings = quotas !== null && quotas !== undefined && typeof quotas.readings === 'object' && quotas.readings !== null
        ? quotas.readings
        : {}
      return h('section', { style: sectionStyle },
        h('div', { style: rowStyle },
          h('strong', null, t('settings.quotasTitle')),
          h('button', { type: 'button', style: buttonStyle, onClick: onRefresh, disabled: busy },
            busy ? t('settings.refreshing') : t('settings.refresh')),
        ),
        h('p', { style: hintStyle }, t('settings.quotasHint')),
        error === null ? null : h('p', { style: dangerStyle }, error),
        models.length === 0
          ? h('p', { style: hintStyle }, busy ? t('settings.loading') : t('settings.quotasEmpty'))
          : h('table', { style: tableStyle },
            h('thead', null,
              h('tr', null,
                h('th', { style: cellStyle }, t('settings.columnModel')),
                h('th', { style: numberCellStyle }, t('settings.columnLeft')),
                h('th', { style: numberCellStyle }, t('settings.columnQuota')),
                h('th', { style: cellStyle }, t('settings.columnResets')),
              ),
            ),
            h('tbody', null,
              models.map(model => {
                const reading = readings[model.wire]
                const failed = reading !== undefined && typeof reading.error === 'string'
                const unlimited = !failed && reading !== undefined && reading.unlimited === true
                const left = failed || reading === undefined || unlimited ? t('settings.noQuota') : formatCount(reading.quotaLeft)
                const quota = failed || reading === undefined || unlimited ? t('settings.noQuota') : formatCount(reading.quota)
                const resets = failed || reading === undefined || reading.nextQuotaUpdate === undefined
                  ? t('settings.noQuota')
                  : reading.nextQuotaUpdate
                return h('tr', { key: model.wire },
                  h('td', { style: cellStyle }, model.label),
                  h('td', { style: numberCellStyle }, unlimited ? t('settings.unlimited') : left),
                  h('td', { style: numberCellStyle }, quota),
                  h('td', { style: cellStyle }, resets),
                )
              }),
            ),
          ),
      )
    }

    /**
     * Plugins → Installed plugins → CityUHK portal chatbot: the bundle page's
     * configuration section, which stores the session cookie and reads every
     * model's remaining quota.
     *
     * The page draws the title, icon, and crumb itself, so this entry renders
     * the form alone. `view` is always `page` for a bundle's configuration.
     */
    function PortalSettings({ call, t }) {
      const [status, setStatus] = useState(null)
      const [cookie, setCookie] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [failure, setFailure] = useState(null)
      const [quotas, setQuotas] = useState(null)
      const [quotasBusy, setQuotasBusy] = useState(false)
      const [quotasError, setQuotasError] = useState(null)

      const refreshQuotas = useCallback(async () => {
        setQuotasBusy(true)
        setQuotasError(null)
        const answer = await call('getAllQuotas')
        setQuotasBusy(false)
        if (answer?.ok === true) setQuotas(answer.value)
        else setQuotasError(answer?.error?.message ?? t('settings.quotasFailed'))
      }, [call, t])

      const refreshStatus = useCallback(async () => {
        const answer = await call('getAuthStatus')
        if (answer?.ok === true) setStatus(answer.value)
        else setFailure(answer?.error?.message ?? t('settings.statusFailed'))
      }, [call, t])

      useEffect(() => {
        void refreshStatus()
        void refreshQuotas()
      }, [refreshStatus, refreshQuotas])

      const save = useCallback(async () => {
        setBusy(true)
        setNotice(null)
        setFailure(null)
        const answer = await call('setCookie', cookie)
        setBusy(false)
        const value = answer?.ok === true ? answer.value : undefined
        if (value?.status !== undefined) setStatus(value.status)
        if (value?.ok === true) {
          setCookie('')
          setNotice(t('settings.saved'))
          void refreshQuotas()
          return
        }
        setFailure(value?.error ?? answer?.error?.message ?? t('settings.rejected'))
      }, [call, cookie, refreshQuotas, t])

      const clear = useCallback(async () => {
        setBusy(true)
        setNotice(null)
        setFailure(null)
        const answer = await call('clearCookie')
        setBusy(false)
        const value = answer?.ok === true ? answer.value : undefined
        if (value?.status !== undefined) setStatus(value.status)
        if (value?.ok === true) {
          setNotice(t('settings.cleared'))
          return
        }
        setFailure(answer?.error?.message ?? t('settings.clearFailed'))
      }, [call, t])

      let statusText = t('settings.checking')
      if (status !== null && status !== undefined) {
        statusText = status.configured === true
          ? (status.source === undefined
            ? t('settings.configuredNoSource')
            : t('settings.configured', { source: status.source }))
          : t('settings.missing')
      }

      return h('div', { style: sectionStyle },
        h('section', { style: sectionStyle },
          h('strong', null, t('settings.sessionTitle')),
          h('p', { style: hintStyle }, statusText),
          h('p', { style: hintStyle }, t('settings.help')),
          h('div', { style: rowStyle },
            h('input', {
              type: 'password',
              style: fieldStyle,
              value: cookie,
              placeholder: t('settings.placeholder'),
              autoComplete: 'off',
              spellCheck: false,
              onChange: event => setCookie(event.target.value),
            }),
            h('button', { type: 'button', style: buttonStyle, onClick: save, disabled: busy || cookie.trim() === '' },
              busy ? t('settings.saving') : t('settings.save')),
            h('button', { type: 'button', style: buttonStyle, onClick: clear, disabled: busy }, t('settings.clear')),
          ),
          notice === null ? null : h('p', { style: hintStyle }, notice),
          failure === null ? null : h('p', { style: dangerStyle }, failure),
        ),
        h(QuotaTable, { quotas, busy: quotasBusy, error: quotasError, onRefresh: refreshQuotas, t }),
      )
    }

    /**
     * Composer-dock pill: the selected model's remaining portal quota.
     *
     * Hidden unless the session's model selection belongs to this provider, so
     * it never claims a quota for a model it does not serve. The full breakdown
     * lives on the plugin's bundle page; one reading keeps the dock quiet.
     */
    function QuotaPill({ useProjection, call, t }) {
      const projection = useProjection('modelSelection')
      const selection = projection?.pending ?? projection?.lastUsed ?? null
      const provider = selection?.provider
      const model = selection?.model
      const [reading, setReading] = useState(null)
      const [failure, setFailure] = useState(null)

      useEffect(() => {
        if (provider !== PROVIDER_ID || typeof model !== 'string' || model === '') return undefined
        let live = true
        const load = async () => {
          const answer = await call('getQuota', model)
          if (!live) return
          if (answer?.ok === true) {
            setReading(answer.value)
            setFailure(null)
          } else {
            setFailure(answer?.error?.message ?? t('pill.unavailable'))
          }
        }
        void load()
        const timer = setInterval(() => { void load() }, POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [provider, model, call, t])

      if (provider !== PROVIDER_ID) return null

      let text = t('pill.reading')
      let title = t('pill.titleReading')
      if (failure !== null) {
        text = t('pill.unavailable')
        title = failure
      } else if (reading !== null && reading !== undefined) {
        if (reading.unlimited === true) {
          text = t('pill.unlimited')
          title = t('pill.titleUnlimited', { model: reading.label })
        } else if (reading.metered === true && typeof reading.quota === 'number') {
          text = t('pill.leftOfQuota', {
            left: formatCount(reading.quotaLeft),
            quota: formatCount(reading.quota),
          })
          title = reading.nextQuotaUpdate === undefined
            ? t('pill.titleLeftOf', {
              model: reading.label,
              left: formatCount(reading.quotaLeft),
              quota: formatCount(reading.quota),
            })
            : t('pill.titleWithReset', {
              model: reading.label,
              left: formatCount(reading.quotaLeft),
              quota: formatCount(reading.quota),
              resets: reading.nextQuotaUpdate,
            })
        } else {
          // A model the portal does not meter (its default route) reports no
          // allowance at all; saying so beats implying unlimited credit.
          text = t('pill.unavailable')
          title = t('pill.titleNoQuota', { model: reading.label })
        }
      }

      return h('span', { style: pillStyle, title, 'data-composer-stat': 'ctu-quota' }, text)
    }

    return {
      name: 'ctu-chatbot-plugin',
      inject: ['slots', 'remote', 'locale'],
      async apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en }), 'ctu-chatbot-plugin: locale dictionary')

        // Mount the Host-declared methods, then hand components a caller that
        // reads the namespace service lazily: the service only exists after
        // this mount, so it cannot be a static `inject` entry.
        const dispose = await ctx.remote.$mount({ package: PACKAGE, descriptors: DESCRIPTORS })
        ctx.effect(() => dispose, 'ctu-chatbot-plugin: quota Remote mount')
        const call = (method, argument) => callRemote(ctx, method, argument)

        // The bundle's own configuration belongs on its bundle page, not in
        // Settings: keyed by this package name, it renders between the page's
        // description and its rows while the Plugins panel is mounted.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
          locale: NS,
          inject: () => ({ call }),
        }, PortalSettings))

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'ctu-quota',
          order: 2,
          locale: NS,
          inject: () => ({ call }),
        }, QuotaPill))
      },
    }
  },
})
