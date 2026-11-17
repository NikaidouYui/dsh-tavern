function ieRegisterSafely(ctx, label, factory) {
  try {
    const disposable = factory()
    if (typeof disposable === 'function' && ctx && typeof ctx.effect === 'function') {
      try { ctx.effect(() => disposable, label) } catch {}
    }
    return disposable
  } catch (error) {
    try { console.warn('[dsh-tavern-input-escape] 挂载失败：' + label, error && error.message) } catch {}
    return null
  }
}

function apply(ctx) {
  const ui = ctx && ctx.tavernUi
  if (!ui) return
  ieEnsureStyleInjected()

  let openPanel = null
  const panelHandle = ieRegisterSafely(ctx, 'input-escape: panel', () => ui.registerPanel({
    id: IE_PANEL_ID,
    title: '输入转义与防路由',
    render: ({ gameId } = {}) => h(InputEscapePanel, { ui, gameId }),
  }))
  if (panelHandle && typeof panelHandle.open === 'function') {
    openPanel = () => panelHandle.open()
  }

  if (typeof ui.registerComposerTool === 'function') {
    ieRegisterSafely(ctx, 'input-escape: composer tool', () => ui.registerComposerTool({
      id: IE_PANEL_ID,
      modes: ['play'],
      render: ({ sessionId } = {}) => h(InputEscapeComposerTool, { ui, sessionId, openPanel }),
    }))
  } else if (typeof ui.registerComposerSlot === 'function') {
    ieRegisterSafely(ctx, 'input-escape: composer slot', () => ui.registerComposerSlot({
      id: IE_PANEL_ID,
      modes: ['play'],
      render: ({ sessionId } = {}) => h(InputEscapeComposerTool, { ui, sessionId, openPanel }),
    }))
  }

  if (typeof ui.registerStatusSection === 'function') {
    ieRegisterSafely(ctx, 'input-escape: status section', () => ui.registerStatusSection({
      id: 'input-escape-status',
      title: '输入转义与防路由',
      render: ({ gameId } = {}) => h(InputEscapeStatusSection, { ui, gameId }),
    }))
  }
}

exports.name = IE_PLUGIN_ID
exports.inject = ['tavernUi']
exports.apply = apply
exports.InputEscapePanel = InputEscapePanel
exports.InputEscapeComposerTool = InputEscapeComposerTool
exports.InputEscapeStatusSection = InputEscapeStatusSection
exports.__test = {
  IE_PLUGIN_ID,
  IE_PANEL_ID,
  IE_MODES,
  IE_MODE_LABELS,
  ieWrapLines,
  iePaginate,
  ieRenderTextToImagePages,
}
