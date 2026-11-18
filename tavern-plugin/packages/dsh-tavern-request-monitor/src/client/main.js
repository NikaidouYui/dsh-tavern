function rmRegisterSafely(ctx, label, factory) {
  try {
    const disposable = factory()
    if (typeof disposable === 'function' && ctx && typeof ctx.effect === 'function') {
      try { ctx.effect(() => disposable, label) } catch {}
    }
    return disposable
  } catch (error) {
    try { console.warn('[dsh-tavern-request-monitor] 挂载失败：' + label, error && error.message) } catch {}
    return null
  }
}

function apply(ctx) {
  const ui = ctx && ctx.tavernUi
  if (!ui) return
  rmEnsureStyleInjected()

  let openPanel = null
  const panelHandle = rmRegisterSafely(ctx, 'request-monitor: panel', () => ui.registerPanel({
    id: RM_PANEL_ID,
    title: '真实请求监控',
    render: ({ gameId } = {}) => h(RequestMonitorPanel, { ui, gameId }),
  }))
  if (panelHandle && typeof panelHandle.open === 'function') {
    openPanel = () => panelHandle.open()
  }

  if (typeof ui.registerComposerTool === 'function') {
    rmRegisterSafely(ctx, 'request-monitor: composer tool', () => ui.registerComposerTool({
      id: RM_PANEL_ID,
      modes: ['play'],
      render: ({ sessionId } = {}) => h(RequestMonitorComposerTool, { ui, sessionId, openPanel }),
    }))
  } else if (typeof ui.registerComposerSlot === 'function') {
    rmRegisterSafely(ctx, 'request-monitor: composer slot', () => ui.registerComposerSlot({
      id: RM_PANEL_ID,
      modes: ['play'],
      render: ({ sessionId } = {}) => h(RequestMonitorComposerTool, { ui, sessionId, openPanel }),
    }))
  }
}

exports.name = RM_PLUGIN_ID
exports.inject = ['tavernUi']
exports.apply = apply
exports.RequestMonitorPanel = RequestMonitorPanel
exports.RequestMonitorOverlay = RequestMonitorOverlay
exports.RequestDetailView = RequestDetailView
exports.RequestMonitorComposerTool = RequestMonitorComposerTool
exports.__test = {
  RM_PLUGIN_ID,
  RM_PANEL_ID,
  rmFormatBytes,
  rmFormatMs,
  rmDecodeCompactCodepoints,
  rmEncodeWireUnicode,
  rmTruncatePreview,
  rmStatusBadge,
}
