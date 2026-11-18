function useRequestMonitorFeed(ui, gameId, { autoPoll = false } = {}) {
  const [viewMode, setViewMode] = useState(gameId ? 'game' : 'all')
  const [scopeFilter, setScopeFilter] = useState('')
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [query, setQuery] = useState('')
  const [feed, setFeed] = useState({ config: null, stats: null, requests: [], version: 0 })
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')

  const refreshList = async () => {
    try {
      const res = await ui.callHost(`${RM_PLUGIN_ID}/get-state`, {
        currentGameId: gameId || '',
        viewMode: gameId ? viewMode : 'all',
        scope: scopeFilter,
        onlyErrors,
        query,
      })
      if (res) {
        setFeed(res)
        setError('')
        if (Array.isArray(res.requests) && res.requests.length > 0) {
          setSelectedId(prev => {
            if (prev && res.requests.some(item => item.id === prev)) return prev
            return res.requests[0].id
          })
        } else {
          setSelectedId('')
          setDetail(null)
        }
      }
    } catch (err) {
      setError(String(err?.message || err))
    }
  }

  useEffect(() => {
    void refreshList()
  }, [gameId, viewMode, scopeFilter, onlyErrors, query])

  useEffect(() => {
    let stopWatch = null
    if (gameId && typeof ui.watchState === 'function') {
      stopWatch = ui.watchState(gameId, 'monitor-feed', () => {
        void refreshList()
      })
    }
    let timer = null
    if (autoPoll || !gameId) {
      timer = setInterval(() => { void refreshList() }, 2000)
    }
    return () => {
      if (typeof stopWatch === 'function') stopWatch()
      if (timer) clearInterval(timer)
    }
  }, [gameId, viewMode, scopeFilter, onlyErrors, query, autoPoll])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let alive = true
    setDetailLoading(true)
    ui.callHost(`${RM_PLUGIN_ID}/get-detail`, { id: selectedId, includeRawWire: true })
      .then(res => {
        if (!alive) return
        setDetail(res?.found ? res.record : null)
        setDetailLoading(false)
      })
      .catch(() => {
        if (alive) setDetailLoading(false)
      })
    return () => { alive = false }
  }, [selectedId, feed.version])

  const saveConfig = async patch => {
    try {
      const res = await ui.callHost(`${RM_PLUGIN_ID}/save-config`, { patch })
      if (res?.config) {
        setFeed(prev => ({ ...prev, config: res.config, stats: res.stats || prev.stats }))
      }
    } catch (err) {
      setError(String(err?.message || err))
    }
  }

  const clearRecords = async () => {
    try {
      await ui.callHost(`${RM_PLUGIN_ID}/clear`, {
        targetGameId: (gameId && viewMode === 'game') ? gameId : '',
      })
      await refreshList()
    } catch (err) {
      setError(String(err?.message || err))
    }
  }

  return {
    viewMode, setViewMode,
    scopeFilter, setScopeFilter,
    onlyErrors, setOnlyErrors,
    query, setQuery,
    feed,
    selectedId, setSelectedId,
    detail, detailLoading,
    error,
    refreshList,
    saveConfig,
    clearRecords,
  }
}

function RequestListItem({ item, selected, onSelect }) {
  const badge = rmStatusBadge(item)
  const stats = item.stats || {}
  const rStats = item.responseStats || null
  const ctx = item.tavernContext || null

  return h('button', {
    type: 'button',
    className: selected ? 'rm-item selected' : 'rm-item',
    onClick: () => onSelect(item.id),
  },
    h('div', { className: 'rm-row' },
      h('div', { className: 'rm-row-left' },
        h('span', { className: `rm-badge ${badge.cls}` },
          h('span', { className: badge.pending ? 'rm-dot pending' : 'rm-dot' }),
          badge.label,
        ),
        h('strong', { style: { fontSize: '12px' } }, `#${item.seq} ${item.model || '(model)'}`),
      ),
      h('span', { className: 'rm-muted' }, rmFormatTime(item.createdAt)),
    ),
    h('div', { className: 'rm-row-left' },
      h('span', { className: 'rm-badge info' }, RM_PROTOCOL_LABELS[item.protocol] || item.protocol),
      ctx?.scope ? h('span', { className: 'rm-badge purple' }, RM_SCOPE_LABELS[ctx.scope] || ctx.scope) : null,
      ctx?.turn ? h('span', { className: 'rm-badge' }, `T${ctx.turn}`) : null,
      item.attempt > 1 ? h('span', { className: 'rm-badge warn' }, `重试#${item.attempt}`) : null,
      stats.wireUnicodeCount > 0 ? h('span', { className: 'rm-badge ok' }, '\\uXXXX') : null,
      stats.compactCodepointBlocks > 0 ? h('span', { className: 'rm-badge warn' }, '⟦U:...⟧') : null,
      stats.imageCount > 0 ? h('span', { className: 'rm-badge info' }, `图×${stats.imageCount}`) : null,
      rStats?.toolCallCount > 0 ? h('span', { className: 'rm-badge purple' }, `返工具×${rStats.toolCallCount}`) : null,
    ),
    h('div', { className: 'rm-row' },
      h('span', { className: 'rm-muted' },
        `${stats.messageCount || 0} 条 · ${rmFormatBytes(item.wireBytes)}` +
        (rStats && (rStats.textChars > 0 || rStats.thinkingChars > 0)
          ? ` → 回 ${rStats.textChars + rStats.thinkingChars} 字`
          : item.responseBytes > 0
            ? ` → ${rmFormatBytes(item.responseBytes)}`
            : ''),
      ),
      h('span', { className: 'rm-muted' }, rmFormatMs(item.durationMs)),
    ),
  )
}

function RequestMonitorFilterBar({ state, gameId, showSettings, setShowSettings }) {
  const cfg = state.feed.config || {}
  const enabled = cfg.enabled !== false

  return h('div', { className: 'rm-card' },
    h('div', { className: 'rm-row' },
      h('div', { className: 'rm-row-left' },
        h('button', {
          type: 'button',
          className: enabled ? 'rm-btn active' : 'rm-btn',
          onClick: () => state.saveConfig({ enabled: !enabled }),
        }, enabled ? '● 监控中' : '○ 已暂停'),
        gameId
          ? [
              h('button', {
                key: 'game',
                type: 'button',
                className: state.viewMode === 'game' ? 'rm-btn active' : 'rm-btn',
                onClick: () => state.setViewMode('game'),
              }, '仅本局'),
              h('button', {
                key: 'all',
                type: 'button',
                className: state.viewMode === 'all' ? 'rm-btn active' : 'rm-btn',
                onClick: () => state.setViewMode('all'),
              }, '全部请求'),
            ]
          : null,
      ),
      h('div', { className: 'rm-row-left' },
        h('button', {
          type: 'button',
          className: 'rm-btn',
          onClick: () => setShowSettings(!showSettings),
        }, '设置'),
        h('button', {
          type: 'button',
          className: 'rm-btn',
          onClick: () => state.refreshList(),
        }, '刷新'),
        h('button', {
          type: 'button',
          className: 'rm-btn danger',
          onClick: () => state.clearRecords(),
        }, '清空'),
      ),
    ),
    h('div', { className: 'rm-row' },
      h('div', { style: { flex: '1 1 150px' } },
        h('input', {
          className: 'rm-input',
          type: 'search',
          value: state.query,
          placeholder: '按模型名或 URL 筛选…',
          onChange: e => state.setQuery(e.target.value),
        }),
      ),
      h('div', { className: 'rm-row-left' },
        [
          ['', '全部'],
          ['story', '正文'],
          ['background', '后台'],
        ].map(([val, label]) =>
          h('button', {
            key: val || 'all',
            type: 'button',
            className: state.scopeFilter === val && !state.onlyErrors ? 'rm-btn active' : 'rm-btn',
            onClick: () => { state.setScopeFilter(val); state.setOnlyErrors(false) },
          }, label),
        ),
        h('button', {
          type: 'button',
          className: state.onlyErrors ? 'rm-btn active' : 'rm-btn',
          onClick: () => state.setOnlyErrors(!state.onlyErrors),
        }, '仅失败'),
      ),
    ),
    showSettings
      ? h('div', { className: 'rm-block-box' },
          h('div', { className: 'rm-row' },
            h('span', null, '抓取范围：'),
            h('div', { className: 'rm-row-left' },
              h('button', {
                type: 'button',
                className: cfg.filterMode !== 'all_json_post' ? 'rm-btn active' : 'rm-btn',
                onClick: () => state.saveConfig({ filterMode: 'llm_only' }),
              }, '仅模型 API（推荐）'),
              h('button', {
                type: 'button',
                className: cfg.filterMode === 'all_json_post' ? 'rm-btn active' : 'rm-btn',
                onClick: () => state.saveConfig({ filterMode: 'all_json_post' }),
              }, '全部 JSON POST'),
            ),
          ),
          h('div', { className: 'rm-row' },
            h('span', null, '内存保留条数上限：'),
            h('div', { className: 'rm-row-left' },
              [20, 40, 80, 120].map(n =>
                h('button', {
                  key: n,
                  type: 'button',
                  className: Number(cfg.maxRecords || 40) === n ? 'rm-btn active' : 'rm-btn',
                  onClick: () => state.saveConfig({ maxRecords: n }),
                }, String(n)),
              ),
            ),
          ),
        )
      : null,
  )
}

function RequestMonitorOverlay({ ui, gameId, initialSelectedId = '', close }) {
  const state = useRequestMonitorFeed(ui, gameId, { autoPoll: true })
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    if (initialSelectedId) state.setSelectedId(initialSelectedId)
  }, [initialSelectedId])

  const requests = state.feed.requests || []

  return h('div', { className: 'rm-overlay', onClick: e => { if (e.target === e.currentTarget) close() } },
    h('div', { className: 'rm-modal' },
      h('div', { className: 'rm-modal-head' },
        h('div', { className: 'rm-row-left' },
          h('span', { className: 'rm-title' }, '真实外发请求监控台'),
          h('span', { className: 'rm-badge info' }, `${requests.length} 条可见`),
          state.feed.stats?.totalApproxBytes
            ? h('span', { className: 'rm-muted' }, `缓存占用 ${rmFormatBytes(state.feed.stats.totalApproxBytes)}`)
            : null,
        ),
        h('button', { type: 'button', className: 'rm-btn', onClick: close }, '关闭 (Esc)'),
      ),
      h('div', { className: 'rm-modal-body' },
        h('div', { className: 'rm-modal-side' },
          h(RequestMonitorFilterBar, { state, gameId, showSettings, setShowSettings }),
          state.error ? h('div', { className: 'rm-badge err' }, state.error) : null,
          h('div', { className: 'rm-modal-scroll' },
            h('div', { className: 'rm-list' },
              requests.length === 0
                ? h('div', { className: 'rm-card' }, h('span', { className: 'rm-muted' }, '暂无符合条件的请求记录'))
                : requests.map(item =>
                    h(RequestListItem, {
                      key: item.id,
                      item,
                      selected: state.selectedId === item.id,
                      onSelect: id => state.setSelectedId(id),
                    }),
                  ),
            ),
          ),
        ),
        h('div', { className: 'rm-modal-main' },
          h(RequestDetailView, { ui, record: state.detail, loading: state.detailLoading, compact: false }),
        ),
      ),
    ),
  )
}

function openRequestMonitorOverlay(ui, gameId, initialSelectedId = '') {
  if (typeof ui.openOverlay !== 'function') return null
  return ui.openOverlay({
    gameId: gameId || undefined,
    dismissible: true,
    render: ({ close }) => h(RequestMonitorOverlay, { ui, gameId, initialSelectedId, close }),
  })
}

function RequestMonitorPanel({ ui, gameId }) {
  const state = useRequestMonitorFeed(ui, gameId, { autoPoll: false })
  const [showSettings, setShowSettings] = useState(false)
  const requests = state.feed.requests || []

  return h('div', { className: 'rm-root' },
    h('div', { className: 'rm-row' },
      h('div', { className: 'rm-row-left' },
        h('span', { className: 'rm-title' }, '真实请求监控'),
        h('span', { className: 'rm-badge' }, `${requests.length} 条`),
      ),
      typeof ui.openOverlay === 'function'
        ? h('button', {
            type: 'button',
            className: 'rm-btn primary',
            onClick: () => openRequestMonitorOverlay(ui, gameId, state.selectedId),
          }, '↗ 全屏精读')
        : null,
    ),
    h(RequestMonitorFilterBar, { state, gameId, showSettings, setShowSettings }),
    state.error ? h('div', { className: 'rm-badge err' }, state.error) : null,
    h('div', { className: 'rm-list', style: { maxHeight: '220px', overflowY: 'auto' } },
      requests.length === 0
        ? h('div', { className: 'rm-card' }, h('span', { className: 'rm-muted' }, '发送对话后将在此捕获真实发往模型接口的 HTTP 请求。'))
        : requests.map(item =>
            h(RequestListItem, {
              key: item.id,
              item,
              selected: state.selectedId === item.id,
              onSelect: id => state.setSelectedId(id),
            }),
          ),
    ),
    h(RequestDetailView, { ui, record: state.detail, loading: state.detailLoading, compact: true }),
  )
}

function RequestMonitorComposerTool({ ui, sessionId, openPanel }) {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      ui.callHost(`${RM_PLUGIN_ID}/get-state`, { currentGameId: sessionId || '', viewMode: 'all' })
        .then(res => { if (alive && res?.stats) setStats(res.stats) })
        .catch(() => {})
    }
    load()
    let stopWatch = null
    if (sessionId && typeof ui.watchState === 'function') {
      stopWatch = ui.watchState(sessionId, 'monitor-feed', next => {
        if (alive && next?.stats) setStats(next.stats)
      })
    }
    return () => {
      alive = false
      if (typeof stopWatch === 'function') stopWatch()
    }
  }, [ui, sessionId])

  const latest = stats?.latest
  const dotColor = !latest
    ? '#9ca3af'
    : (latest.state === 'pending' || latest.state === 'aborted')
      ? '#f59e0b'
      : (latest.state === 'error' || (latest.statusCode || 0) >= 400)
        ? '#ef4444'
        : '#10a37f'

  const handleClick = () => {
    if (typeof ui.openOverlay === 'function') {
      openRequestMonitorOverlay(ui, sessionId, latest?.id || '')
    } else if (typeof openPanel === 'function') {
      openPanel()
    }
  }

  const titleText = stats?.totalRecords
    ? `真实请求监控（已捕获 ${stats.totalRecords} 条）`
    : '真实请求监控（点击打开监控台）'

  return h('button', {
    type: 'button',
    className: 'rm-tool-btn',
    title: titleText,
    'aria-label': titleText,
    onClick: handleClick,
  },
    h('svg', {
      width: 15,
      height: 15,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
      h('polyline', { points: '22 12 18 12 15 21 9 3 6 12 2 12' }),
    ),
    h('span', {
      style: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: dotColor,
        display: 'inline-block',
      },
    }),
  )
}
