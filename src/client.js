/**
 * Client half source for `@moguiyu/dsh-tavily`.
 * `factory` must stay self-contained: scripts/build-client.mjs serializes it
 * with Function.prototype.toString into the window.__ModuleLoader__ bundle.
 */
export const id = '@moguiyu/dsh-tavily'

export function factory(require) {
  const react = require('react')

  const inject = ['slots']

  const ICONS = {
    eye: ['M1.5 8C1.5 8 4 3.5 8 3.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z', 'M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z'],
    eyeOff: ['M1.5 8C1.5 8 4 3.5 8 3.5c1.6 0 3 .5 4.1 1.2', 'M14.5 8C14.5 8 12 12.5 8 12.5c-1.6 0-3-.5-4.1-1.2', 'M2 2l12 12', 'M8 5.8a2.2 2.2 0 0 1 2.2 2.2'],
    pencil: ['M11.2 2.3l2.5 2.5L6 12.5l-3.3.8.8-3.3 7.7-7.7Z', 'M9.5 4l2.5 2.5'],
    trash: ['M2.5 4h11', 'M6.2 4V2.8h3.6V4', 'M4.2 4l.7 9.2h6.2L11.8 4', 'M6.5 6.5v4.2', 'M9.5 6.5v4.2'],
    check: ['M3 8.5l3.5 3.5L13 5'],
    close: ['M4 4l8 8', 'M12 4l-8 8'],
    restore: ['M8 3a5 5 0 1 0 4.9 4', 'M13.4 1.8V5H10'],
    up: ['M8 13V3', 'M4 7l4-4 4 4'],
    down: ['M8 3v10', 'M4 9l4 4 4-4']
  }

  const btn = { height: 28, borderRadius: 14, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', padding: '0 10px', cursor: 'pointer', fontSize: 12 }
  const inputStyle = { boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', width: '100%', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'var(--ds-font-family-code, monospace)' }

  function formatDate(iso) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    const pad = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  function SvgIcon({ name, size, style }) {
    const paths = ICONS[name] || []
    return react.createElement('svg', { width: size || 14, height: size || 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: style },
      paths.map((d, index) => react.createElement('path', { key: index, d: d }))
    )
  }

  function IconButton({ icon, title, onClick, disabled, danger, className }) {
    return react.createElement('button', {
      type: 'button',
      title: title,
      'aria-label': title,
      disabled: disabled,
      onClick: onClick,
      className: className || 'dts-icon-btn',
      style: { width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, flex: 'none' }
    }, react.createElement(SvgIcon, { name: icon, size: 13 }))
  }

  function UsageCircle({ percent, size, label, onClick }) {
    const radius = 15
    const circumference = 2 * Math.PI * radius
    const pct = percent != null ? Math.min(100, Math.max(0, percent)) : 0
    const dim = size || 44
    return react.createElement('button', { type: 'button', title: 'Reload usage', 'aria-label': 'Reload usage', onClick: onClick, style: { position: 'relative', width: dim, height: dim, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
      react.createElement('svg', { width: dim, height: dim, viewBox: '0 0 40 40' },
        react.createElement('circle', { cx: 20, cy: 20, r: radius, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 4 }),
        react.createElement('circle', { cx: 20, cy: 20, r: radius, fill: 'none', stroke: 'var(--dsw-alias-state-success-primary)', strokeWidth: 4, strokeLinecap: 'round', strokeDasharray: circumference, strokeDashoffset: circumference - (pct / 100) * circumference, transform: 'rotate(-90 20 20)' })
      ),
      react.createElement('span', { style: { position: 'absolute', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, label != null ? label : (percent != null ? percent + '%' : '—'))
    )
  }

  function TavilySettingsCard() {
    const [server, setServer] = react.useState(null)
    const [loadError, setLoadError] = react.useState(null)
    const [removing, setRemoving] = react.useState({})
    const [replacing, setReplacing] = react.useState({})
    const [replaceDrafts, setReplaceDrafts] = react.useState({})
    const [adds, setAdds] = react.useState([])
    const [revealed, setRevealed] = react.useState({})
    const [confirm, setConfirm] = react.useState({})
    const [busy, setBusy] = react.useState(false)
    const [notice, setNotice] = react.useState(null)
    const [usage, setUsage] = react.useState(null)
    const [usageError, setUsageError] = react.useState(null)

    const refresh = react.useCallback(async () => {
      try {
        const response = await fetch('/api/tavily-manager', { cache: 'no-store' })
        const data = await response.json()
        if (data.ok) { setServer(data) } else { setLoadError(data.error || 'Failed to load keys') }
      } catch (error) {
        setLoadError(String(error && error.message ? error.message : error))
      }
      try {
        const response = await fetch('/api/tavily-usage', { cache: 'no-store' })
        const data = await response.json()
        setUsage(data)
        setUsageError(null)
      } catch (error) {
        setUsageError(String(error && error.message ? error.message : error))
      }
    }, [])

    react.useEffect(() => { refresh() }, [refresh])

    const moveKey = async (masked, delta) => {
      if (server === null) return
      const order = server.keys.map((entry) => entry.masked)
      const from = order.indexOf(masked)
      const to = from + delta
      if (from < 0 || to < 0 || to >= order.length) return
      const next = order.slice()
      next[from] = order[to]
      next[to] = order[from]
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ order: next })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Priority update failed' }); return }
        setNotice({ ok: 'Priority updated.' })
        await refresh()
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const saveAdd = async (item) => {
      const value = item.value.trim()
      if (!value) return
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ add: [value], remove: [] })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Save failed' }); return }
        setNotice({ ok: 'Key saved.' })
        setAdds((current) => current.filter((entry) => entry.id !== item.id))
        await refresh()
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const saveRemove = async (masked) => {
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ add: [], remove: [masked] })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Delete failed' }); return }
        setNotice({ ok: 'Key removed.' })
        setConfirm((current) => Object.assign({}, current, { [masked]: false }))
        setRemoving((current) => Object.assign({}, current, { [masked]: false }))
        setRevealed((current) => Object.assign({}, current, { [masked]: false }))
        await refresh()
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const saveReplace = async (masked) => {
      const value = typeof replaceDrafts[masked] === 'string' ? replaceDrafts[masked].trim() : ''
      if (!value) return
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ add: [value], remove: [masked] })
        })
        const data = await response.json()
        if (!data.ok) { setNotice({ error: data.error || 'Update failed' }); return }
        setNotice({ ok: 'Key updated.' })
        setReplacing((current) => Object.assign({}, current, { [masked]: false }))
        setReplaceDrafts((current) => Object.assign({}, current, { [masked]: '' }))
        setRevealed((current) => Object.assign({}, current, { [masked]: false }))
        await refresh()
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const toggleReveal = async (masked) => {
      if (typeof revealed[masked] === 'string') {
        setRevealed((current) => Object.assign({}, current, { [masked]: false }))
        return
      }
      setBusy(true)
      setNotice(null)
      try {
        const response = await fetch('/api/tavily-manager?reveal=' + encodeURIComponent(masked), { cache: 'no-store' })
        const data = await response.json()
        if (data.ok) setRevealed((current) => Object.assign({}, current, { [masked]: data.value }))
        else setNotice({ error: data.error || 'Failed to reveal key' })
      } catch (error) {
        setNotice({ error: String(error && error.message ? error.message : error) })
      } finally {
        setBusy(false)
      }
    }

    const markRemoved = (masked) => {
      if (confirm[masked] !== true) {
        setConfirm((current) => Object.assign({}, current, { [masked]: true }))
        return
      }
      setConfirm((current) => Object.assign({}, current, { [masked]: false }))
      setRemoving((current) => Object.assign({}, current, { [masked]: true }))
      setRevealed((current) => Object.assign({}, current, { [masked]: false }))
      saveRemove(masked)
    }

    const restore = (masked) => {
      setRemoving((current) => Object.assign({}, current, { [masked]: false }))
      setConfirm((current) => Object.assign({}, current, { [masked]: false }))
    }

    const startReplace = (masked) => {
      setReplacing((current) => Object.assign({}, current, { [masked]: true }))
      setReplaceDrafts((current) => Object.assign({}, current, { [masked]: '' }))
      setNotice(null)
    }

    const cancelReplace = (masked) => {
      setReplacing((current) => Object.assign({}, current, { [masked]: false }))
      setReplaceDrafts((current) => Object.assign({}, current, { [masked]: '' }))
    }

    const headStyle = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
    const cellStyle = { padding: '8px', verticalAlign: 'top' }
    const keysReadOnly = server !== null && server.writable !== undefined && server.writable.keys === false

    // The Plugins page draws the title, the icon, and the crumb — the
    // `plugins.bundle.config` contract puts the form alone in the entry — so
    // this renders no card chrome, no second heading, and no collapse.
    return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 } },
      react.createElement('style', null, '.dts-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.dts-icon-btn:disabled{opacity:.4;cursor:default}.dts-icon-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}'),
      react.createElement(react.Fragment, null,
              react.createElement('p', { style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } },
                'Keys are tried in the order shown, top first; the green dot marks the primary key. A key that returns 401/429/432/433 is skipped for that call and the next key is tried. Built-in web_search is unaffected.'
              ),
              keysReadOnly &&
                react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                  'Read-only: these keys come from the environment that launched dsh, so this card cannot change them. Unset TAVILY_API_KEYS / TAVILY_API_KEY in that shell and restart dsh to manage keys here.'
                ),
              loadError !== null && react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, String(loadError)),
              react.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
                react.createElement('thead', null,
                  react.createElement('tr', null,
                    react.createElement('th', { style: headStyle }, 'Key'),
                    react.createElement('th', { style: headStyle }, 'Usage'),
                    react.createElement('th', { style: headStyle }, 'Saved'),
                    react.createElement('th', { style: headStyle }, 'Actions')
                  )
                ),
                react.createElement('tbody', null,
                  (server !== null ? server.keys : []).map((key, index) => {
                    const masked = key.masked
                    const isRemoved = removing[masked] === true
                    const isReplacing = replacing[masked] === true
                    const isRevealed = typeof revealed[masked] === 'string'
                    const usageRow = usage !== null && usage.ok === true
                      ? (usage.perKey.find((row) => row.masked === masked) || usage.perKey[index])
                      : null
                    const pct = usageRow && usageRow.ok && usageRow.planLimit != null && usageRow.planLimit > 0 && usageRow.planUsage != null
                      ? Math.min(100, Math.round((usageRow.planUsage / usageRow.planLimit) * 100))
                      : null
                    return react.createElement('tr', { key: masked, style: { borderBottom: '1px solid var(--dsw-alias-border-l2)', opacity: isRemoved ? 0.45 : 1 } },
                      react.createElement('td', { style: Object.assign({}, cellStyle, { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12, wordBreak: 'break-all' }) },
                        isReplacing
                          ? react.createElement('textarea', {
                              style: Object.assign({}, inputStyle, { minHeight: 32, resize: 'vertical' }),
                              placeholder: 'New key value (leave blank to keep)',
                              value: replaceDrafts[masked] || '',
                              onChange: (event) => setReplaceDrafts((current) => Object.assign({}, current, { [masked]: event.target.value })),
                              disabled: busy
                            })
                          : react.createElement('span', null,
                              isRevealed ? revealed[masked] : masked,
                              key.primary === true && !isRemoved && react.createElement('span', {
                                title: 'Primary — the first key tried',
                                style: { display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: 'var(--dsw-alias-state-success-primary)', marginLeft: 8, verticalAlign: 'middle', flex: 'none' }
                              })
                            )
                      ),
                      react.createElement('td', { style: cellStyle },
                        react.createElement(UsageCircle, { percent: pct, label: pct != null ? pct + '%' : (usageRow && usageRow.ok && usageRow.planUsage != null ? String(usageRow.planUsage) : '—'), onClick: refresh })
                      ),
                      react.createElement('td', { style: Object.assign({}, cellStyle, { color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }) }, formatDate(key.savedAt)),
                      react.createElement('td', { style: cellStyle },
                        isReplacing
                          ? react.createElement('span', { style: { display: 'inline-flex', gap: 2 } },
                              react.createElement(IconButton, { icon: 'check', title: 'Save key', onClick: () => saveReplace(masked), disabled: busy || (typeof replaceDrafts[masked] === 'string' ? replaceDrafts[masked].trim().length === 0 : true) }),
                              react.createElement(IconButton, { icon: 'close', title: 'Cancel', onClick: () => cancelReplace(masked), disabled: busy })
                            )
                          : react.createElement('span', { style: { display: 'inline-flex', gap: 2 } },
                              !isRemoved && react.createElement(IconButton, { icon: 'up', title: 'Move up (higher priority)', onClick: () => moveKey(masked, -1), disabled: busy || keysReadOnly || index === 0 }),
                              !isRemoved && react.createElement(IconButton, { icon: 'down', title: 'Move down (lower priority)', onClick: () => moveKey(masked, 1), disabled: busy || keysReadOnly || index === server.keys.length - 1 }),
                              !isRemoved && react.createElement(IconButton, { icon: isRevealed ? 'eyeOff' : 'eye', title: isRevealed ? 'Hide key' : 'Show key', onClick: () => toggleReveal(masked), disabled: busy }),
                              !isRemoved && react.createElement(IconButton, { icon: 'pencil', title: 'Edit', onClick: () => startReplace(masked), disabled: busy }),
                              react.createElement(IconButton, {
                                icon: isRemoved ? 'restore' : (confirm[masked] === true ? 'check' : 'trash'),
                                // A key the launching environment supplies is read-only, so the
                                // server would refuse. Say so on the control instead.
                                title: key.removable === false
                                  ? 'Read-only: this key comes from the environment that launched dsh. Unset it there and restart dsh to change it here.'
                                  : (isRemoved ? 'Restore' : (confirm[masked] === true ? 'Click again to confirm' : 'Delete')),
                                danger: !isRemoved,
                                className: isRemoved ? 'dts-icon-btn' : 'dts-icon-btn dts-icon-btn-danger',
                                onClick: () => isRemoved ? restore(masked) : markRemoved(masked),
                                disabled: busy || (key.removable === false && !isRemoved)
                              })
                            )
                      )
                    )
                  }),
                  adds.map((item) => react.createElement('tr', { key: item.id, style: { borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
                    react.createElement('td', { style: cellStyle },
                      react.createElement('input', {
                        style: inputStyle,
                        placeholder: 'New key value',
                        value: item.value,
                        onChange: (event) => setAdds((current) => current.map((entry) => entry.id === item.id ? Object.assign({}, entry, { value: event.target.value }) : entry)),
                        onKeyDown: (event) => { if (event.key === 'Enter') saveAdd(item) },
                        disabled: busy
                      })
                    ),
                    react.createElement('td', { style: cellStyle }, '—'),
                    react.createElement('td', { style: cellStyle }, '—'),
                    react.createElement('td', { style: cellStyle },
                      react.createElement('span', { style: { display: 'inline-flex', gap: 2 } },
                        react.createElement(IconButton, { icon: 'check', title: 'Save key', onClick: () => saveAdd(item), disabled: busy || item.value.trim().length === 0 }),
                        react.createElement(IconButton, { icon: 'trash', title: 'Remove', danger: true, onClick: () => setAdds((current) => current.filter((entry) => entry.id !== item.id)), disabled: busy })
                      )
                    )
                  ))
                )
              ),
              react.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                react.createElement('button', { type: 'button', style: btn, onClick: () => setAdds((current) => [...current, { id: 'add-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), value: '' }]), disabled: busy || keysReadOnly }, '+ Add key'),
              ),
              notice !== null && react.createElement('p', { style: { margin: 0, fontSize: 12, color: notice.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, notice.ok ? notice.ok : String(notice.error)),
              usageError !== null && react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, String(usageError)),
              usage !== null && usage.ok === false && react.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, String(usage.error))
            )
    )
  }

  // The entry the Plugins page renders. The contract asks for two views:
  // `summary` for the one-liner under the title, and `page` for the form with
  // its own save control. The page supplies the title, icon, and crumb, so the
  // summary is a plain string and the page view is the form alone — matching
  // how the shipped cards (WebSearchCard and friends) are written.
  function TavilyCard(props) {
    if (props && props.view === 'summary') {
      return 'Manage Tavily API keys and the order they are tried in. The built-in web_search is never replaced.'
    }
    return react.createElement(TavilySettingsCard, null)
  }

  function apply(ctx) {
    // ONE slot. 0.1.6-alpha.2 moved plugin configuration to the sidebar
    // Plugins page and retired `settings.plugin.item`. This package no longer
    // registers a settings namespace, so the retired keyed slot has no key it
    // could claim. On rc.7 through 0.1.6-alpha.1 the tools and routes work but
    // this card has no host — see `docs/agents/plugin-design.md`.
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      // Keyed by the bundle's package name. The Plugins page renders this on
      // the @moguiyu/dsh-tavily bundle page, between its description and rows.
      key: '@moguiyu/dsh-tavily',
      id: '@moguiyu/dsh-tavily'
    }, TavilyCard))
  }

  return { apply, inject }
}
