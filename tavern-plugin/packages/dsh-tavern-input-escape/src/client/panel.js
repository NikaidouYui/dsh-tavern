const IE_PLUGIN_ID = 'dsh-tavern-input-escape'
const IE_PANEL_ID = 'input-escape'

const IE_MODES = [
  {
    value: 'json_escape',
    title: '一 · JSON \\uXXXX 整包转义',
    sub: '0 额外 Token。在 HTTP 发送层转写非 ASCII，网关无法明文匹配，后端自动无损还原。',
  },
  {
    value: 'compact',
    title: '二 · 紧凑码点转义 ⟦U:HEX ...⟧',
    sub: '仅将本轮玩家输入的汉字/字母转成 Unicode 码点并附解码提示，保留历史原文。',
  },
  {
    value: 'hybrid_image',
    title: '三 · 输入转图片（PNG）',
    sub: '通过浏览器 Canvas 将本轮输入绘制为白底黑字图片，以多模态附件替代文本发送。',
  },
  {
    value: 'full_armor',
    title: '四 · 深度破盾（高危词全上下文码点 + 整包转义）',
    sub: '扫描全部非系统消息的高危词转为 ⟦U:...⟧，并叠加整包 \\uXXXX 转义（必要时再开）。',
  },
]

const IE_MODE_LABELS = {
  off: '已关闭',
  json_escape: '整包 \\uXXXX',
  compact: '紧凑码点 ⟦U:...⟧',
  hybrid_image: '输入转图片',
  full_armor: '深度破盾',
}

const IE_THINKING_OPTIONS = [
  ['passthrough', '保持 DSH 原样（默认）'],
  ['auto_low', '正文轮次自动锁低思考 (low)'],
  ['low', '强制 low'],
  ['medium', '强制 medium'],
  ['high', '强制 high'],
  ['xhigh', '强制 xhigh'],
]

const ieHandledRenderIds = new Set()

async function ieHandleRenderRequest(ui, sessionId, payload) {
  if (!payload || !payload.requestId || !payload.text) return
  if (ieHandledRenderIds.has(payload.requestId)) return
  ieHandledRenderIds.add(payload.requestId)
  if (ieHandledRenderIds.size > 64) {
    const first = ieHandledRenderIds.values().next().value
    if (first) ieHandledRenderIds.delete(first)
  }
  try {
    const pages = ieRenderTextToImagePages(payload.text)
    for (const page of pages) {
      await ui.callHost(`${IE_PLUGIN_ID}/upload-image-page`, {
        gameId: sessionId,
        requestId: payload.requestId,
        pageIndex: page.pageIndex,
        totalPages: page.totalPages,
        mediaType: page.mediaType,
        base64: page.base64,
      })
    }
  } catch (error) {
    try { console.warn('[dsh-tavern-input-escape] 输入转图片渲染失败:', error && error.message) } catch {}
  }
}

function useInputEscapeState(ui, gameId) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setError('')
    ui.callHost(`${IE_PLUGIN_ID}/get-state`, { gameId: gameId || '' })
      .then(res => { if (alive && res) setState(res) })
      .catch(err => { if (alive) setError(String(err?.message || err)) })

    let stopWatch = null
    if (gameId && typeof ui.watchState === 'function') {
      stopWatch = ui.watchState(gameId, 'status', next => {
        if (alive && next) setState(next)
      })
    }
    return () => {
      alive = false
      if (typeof stopWatch === 'function') stopWatch()
    }
  }, [ui, gameId])

  const saveGlobal = async patch => {
    setBusy(true)
    setError('')
    try {
      const next = await ui.callHost(`${IE_PLUGIN_ID}/save-global-config`, { gameId: gameId || '', patch })
      if (next && next.effective) setState(next)
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const saveGame = async patch => {
    if (!gameId) return
    setBusy(true)
    setError('')
    try {
      const next = await ui.callHost(`${IE_PLUGIN_ID}/save-game-override`, { gameId, patch })
      if (next) setState(next)
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  return { state, busy, error, saveGlobal, saveGame }
}

function IeSwitch({ checked, disabled, onChange, label }) {
  return h('input', {
    type: 'checkbox',
    checked: Boolean(checked),
    disabled: Boolean(disabled),
    'aria-label': label || '开关',
    onChange: e => onChange(Boolean(e.target.checked)),
    style: { width: 16, height: 16, cursor: disabled ? 'not-allowed' : 'pointer' },
  })
}

function InputEscapePanel({ ui, gameId }) {
  const { state, busy, error, saveGlobal, saveGame } = useInputEscapeState(ui, gameId)
  if (!state) {
    return h('div', { className: 'ie-panel' }, error ? h('div', { className: 'ie-card' }, '加载失败：' + error) : '正在读取配置…')
  }
  const g = state.globalConfig || {}
  const eff = state.effective || {}
  const tel = state.telemetry

  return h('div', { className: 'ie-panel' },
    h('div', { className: 'ie-card' },
      h('div', { className: 'ie-head-row' },
        h('div', null,
          h('div', { className: 'ie-title' }, '输入转义与防路由'),
          h('div', { className: 'ie-desc' }, '不改存档原文，仅在模型发包副本生效'),
        ),
        h('span', { className: 'ie-badge ' + (eff.enabled ? '' : 'off') },
          h('span', { className: 'ie-dot' }),
          eff.enabled ? (eff.inputEscapeEnabled ? (IE_MODE_LABELS[eff.inputMode] || eff.inputMode) : '仅防路由') : '已暂停'
        )
      ),
      !state.supported ? h('div', { className: 'ie-badge warn' }, '当前酒馆宿主缺少 requestRewriter 接口，请升级 dsh-tavern') : null,
      error ? h('div', { className: 'ie-badge warn' }, error) : null,
      h('div', { className: 'ie-row' },
        h('div', { className: 'ie-row-main' },
          h('span', { className: 'ie-row-label' }, '全局总开关'),
          h('span', { className: 'ie-row-note' }, '关闭后所有对话直接透传，0 额外开销')
        ),
        h(IeSwitch, { checked: g.enabled, disabled: busy, label: '全局总开关', onChange: val => saveGlobal({ enabled: val }) })
      ),
      gameId ? h('div', { className: 'ie-row' },
        h('div', { className: 'ie-row-main' },
          h('span', { className: 'ie-row-label' }, '本局启用策略'),
          h('span', { className: 'ie-row-note' }, '可针对当前对话单独开关')
        ),
        h('select', {
          className: 'ie-select',
          disabled: busy,
          value: state.gameOverride?.override || 'inherit',
          onChange: e => saveGame({ override: e.target.value }),
        },
          h('option', { value: 'inherit' }, '跟随全局'),
          h('option', { value: 'enabled' }, '本局强制开启'),
          h('option', { value: 'disabled' }, '本局暂停')
        )
      ) : null
    ),

    h('div', { className: 'ie-card' },
      h('div', { className: 'ie-row' },
        h('div', { className: 'ie-row-main' },
          h('span', { className: 'ie-title' }, '输入转义'),
          h('span', { className: 'ie-row-note' }, '出现场外拒答或拦截时选用对应转义梯度')
        ),
        h(IeSwitch, { checked: g.inputEscapeEnabled, disabled: busy, label: '输入转义开关', onChange: val => saveGlobal({ inputEscapeEnabled: val }) })
      ),
      g.inputEscapeEnabled ? h(Fragment, null,
        h('div', { className: 'ie-modes' },
          IE_MODES.map(mode => h('button', {
            key: mode.value,
            type: 'button',
            disabled: busy,
            className: 'ie-mode-btn' + (g.inputMode === mode.value ? ' active' : ''),
            onClick: () => saveGlobal({ inputMode: mode.value }),
          },
            h('div', { className: 'ie-mode-title' }, mode.title),
            h('div', { className: 'ie-mode-sub' }, mode.sub)
          ))
        ),
        g.inputMode === 'json_escape' ? h('div', { className: 'ie-row' },
          h('div', { className: 'ie-row-main' },
            h('span', { className: 'ie-row-label' }, 'JSON 转义范围'),
            h('span', { className: 'ie-row-note' }, '整包 \\uXXXX 最稳；仅转义本轮输入更精准')
          ),
          h('select', {
            className: 'ie-select',
            disabled: busy,
            value: g.wireEscapeScope || 'full',
            onChange: e => saveGlobal({ wireEscapeScope: e.target.value }),
          },
            h('option', { value: 'full' }, '整包全量转义'),
            h('option', { value: 'input_only' }, '仅本轮用户输入')
          )
        ) : null
      ) : null
    ),

    h('div', { className: 'ie-card' },
      h('div', { className: 'ie-row' },
        h('div', { className: 'ie-row-main' },
          h('span', { className: 'ie-title' }, '防路由与分类器清洗'),
          h('span', { className: 'ie-row-note' }, '打散路由指纹、温和化触发词、降权 System 消息')
        ),
        h(IeSwitch, { checked: g.antiRouteEnabled, disabled: busy, label: '防路由开关', onChange: val => saveGlobal({ antiRouteEnabled: val }) })
      ),
      g.antiRouteEnabled ? h(Fragment, null,
        h('div', { className: 'ie-row' },
          h('div', { className: 'ie-row-main' },
            h('span', { className: 'ie-row-label' }, '动态 Session-ID 指纹'),
            h('span', { className: 'ie-row-note' }, '每次请求注入随机 SID 与 user/seed 打散路由')
          ),
          h(IeSwitch, { checked: g.dynamicSessionId, disabled: busy, label: '动态指纹', onChange: val => saveGlobal({ dynamicSessionId: val }) })
        ),
        h('div', { className: 'ie-row' },
          h('div', { className: 'ie-row-main' },
            h('span', { className: 'ie-row-label' }, '分类器脱敏清洗'),
            h('span', { className: 'ie-row-note' }, '还原注音/零宽字符，温和化 +55/+419/+701 特征词')
          ),
          h(IeSwitch, { checked: g.classifierSanitize, disabled: busy, label: '分类器脱敏', onChange: val => saveGlobal({ classifierSanitize: val }) })
        ),
        h('div', { className: 'ie-row' },
          h('div', { className: 'ie-row-main' },
            h('span', { className: 'ie-row-label' }, 'System 消息降权合并'),
            h('span', { className: 'ie-row-note' }, '将预设 System 转为 User 参考，System 槽仅留中立头')
          ),
          h(IeSwitch, { checked: g.demoteSystem, disabled: busy, label: 'System 降权', onChange: val => saveGlobal({ demoteSystem: val }) })
        ),
        h('div', { className: 'ie-row' },
          h('div', { className: 'ie-row-main' },
            h('span', { className: 'ie-row-label' }, '伪造历史轮次收敛'),
            h('span', { className: 'ie-row-note' }, '移除对抗安全诱饵，收敛前置伪造 assistant')
          ),
          h(IeSwitch, { checked: g.normalizePreHistory, disabled: busy, label: '收敛伪造轮次', onChange: val => saveGlobal({ normalizePreHistory: val }) })
        ),
        h('div', { className: 'ie-row' },
          h('div', { className: 'ie-row-main' },
            h('span', { className: 'ie-row-label' }, '思考等级控制'),
            h('span', { className: 'ie-row-note' }, 'Gemini 4 思考过高易自我审查；可锁定 low')
          ),
          h('select', {
            className: 'ie-select',
            disabled: busy,
            value: g.thinkingMode || 'passthrough',
            onChange: e => saveGlobal({ thinkingMode: e.target.value }),
          },
            IE_THINKING_OPTIONS.map(([val, label]) => h('option', { key: val, value: val }, label))
          )
        ),
        h('div', { className: 'ie-row' },
          h('div', { className: 'ie-row-main' },
            h('span', { className: 'ie-row-label' }, '生效作用域'),
            h('span', { className: 'ie-row-note' }, '后台结算/压缩仅做轻量脱敏，不改写结构')
          ),
          h('select', {
            className: 'ie-select',
            disabled: busy,
            value: g.scopeMode || 'story_only',
            onChange: e => saveGlobal({ scopeMode: e.target.value }),
          },
            h('option', { value: 'story_only' }, '仅游玩正文'),
            h('option', { value: 'story_and_background' }, '正文 + 后台轻量防路由')
          )
        ),
        h('div', { className: 'ie-row' },
          h('div', { className: 'ie-row-main' },
            h('span', { className: 'ie-row-label' }, '权重稀释参考垫片（慎开）'),
            h('span', { className: 'ie-row-note' }, '额外注入约 6400 字无害静物垫片，会增加 Token 消耗')
          ),
          h(IeSwitch, { checked: g.dilutionPaddingEnabled, disabled: busy, label: '权重稀释垫片', onChange: val => saveGlobal({ dilutionPaddingEnabled: val }) })
        )
      ) : null
    ),

    tel ? h('div', { className: 'ie-card' },
      h('div', { className: 'ie-head-row' },
        h('span', { className: 'ie-title' }, '最近一次请求遥测'),
        h('span', { className: 'ie-desc' }, '第 ' + tel.turn + ' 轮 · ' + (tel.scope || 'story'))
      ),
      h('div', { className: 'ie-telemetry' },
        h('span', null, '输入模式：' + (IE_MODE_LABELS[tel.inputMode] || tel.inputMode)),
        h('span', null, 'JSON 转义：' + (tel.wireEscape || '无')),
        h('span', null, '匹配方式：' + (tel.inputMethod || '-')),
        h('span', null, '转义/图片：' + (tel.imagePages > 0 ? tel.imagePages + ' 页图' : (tel.inputMatches + ' 处'))),
        h('span', null, '高危词破盾：' + (tel.fullArmorHits || 0) + ' 处'),
        h('span', null, 'System 降权：' + (tel.antiRoute?.demotedSystems || 0) + ' 处'),
        h('span', null, '分类器脱敏：' + (tel.antiRoute?.sanitizedTexts || 0) + ' 段'),
        h('span', null, 'Session 指纹：' + (tel.antiRoute?.sessionIdTag ? '已注入' : '未注入'))
      ),
      tel.fallbackReason ? h('div', { className: 'ie-badge warn' }, '已降级回退：' + tel.fallbackReason) : null
    ) : null
  )
}

function InputEscapeComposerTool({ ui, sessionId, openPanel }) {
  const [open, setOpen] = useState(false)
  const { state, busy, saveGlobal, saveGame } = useInputEscapeState(ui, sessionId)

  // 无论面板是否打开，始终在活跃聊天页面后台监听宿主的图片渲染请求
  useEffect(() => {
    if (!sessionId || typeof ui.watchState !== 'function') return
    return ui.watchState(sessionId, 'render-request', payload => {
      void ieHandleRenderRequest(ui, sessionId, payload)
    })
  }, [ui, sessionId])

  const eff = state?.effective
  const active = Boolean(eff?.enabled)
  const modeLabel = !active ? '已关闭' : (eff?.inputEscapeEnabled ? (IE_MODE_LABELS[eff.inputMode] || eff.inputMode) : '仅防路由')

  return h('div', { className: 'ie-tool-wrap' },
    h('button', {
      type: 'button',
      className: 'ie-tool-btn',
      title: '输入转义与防路由（' + modeLabel + '）',
      'aria-label': '输入转义与防路由（' + modeLabel + '）',
      onClick: () => setOpen(v => !v),
    },
      h('span', { style: { fontSize: 15, lineHeight: 1 } }, '🛡️'),
      h('span', { className: 'ie-tool-dot' + (active ? '' : ' off') })
    ),
    open ? h('div', { className: 'ie-popover' },
      h('div', { className: 'ie-head-row' },
        h('span', { className: 'ie-title' }, '输入转义 · ' + modeLabel),
        h('button', { className: 'ie-chip', type: 'button', onClick: () => setOpen(false) }, '收起')
      ),
      state ? h(Fragment, null,
        h('div', { className: 'ie-row' },
          h('span', { className: 'ie-row-label' }, '全局总开关'),
          h(IeSwitch, { checked: state.globalConfig?.enabled, disabled: busy, label: '全局总开关', onChange: val => saveGlobal({ enabled: val }) })
        ),
        h('div', { className: 'ie-row' },
          h('span', { className: 'ie-row-label' }, '防路由清洗'),
          h(IeSwitch, { checked: state.globalConfig?.antiRouteEnabled, disabled: busy, label: '防路由清洗', onChange: val => saveGlobal({ antiRouteEnabled: val }) })
        ),
        h('div', { className: 'ie-seg' },
          IE_MODES.map(mode => h('button', {
            key: mode.value,
            type: 'button',
            disabled: busy,
            className: 'ie-chip' + (state.globalConfig?.inputMode === mode.value ? ' active' : ''),
            onClick: () => saveGlobal({ inputEscapeEnabled: true, inputMode: mode.value }),
          }, IE_MODE_LABELS[mode.value]))
        ),
        sessionId ? h('div', { className: 'ie-row' },
          h('span', { className: 'ie-row-label' }, '本局覆盖'),
          h('select', {
            className: 'ie-select',
            disabled: busy,
            value: state.gameOverride?.override || 'inherit',
            onChange: e => saveGame({ override: e.target.value }),
          },
            h('option', { value: 'inherit' }, '跟随全局'),
            h('option', { value: 'enabled' }, '强制开启'),
            h('option', { value: 'disabled' }, '本局暂停')
          )
        ) : null,
        typeof openPanel === 'function' ? h('button', {
          type: 'button',
          className: 'ie-chip',
          onClick: () => { setOpen(false); openPanel() },
        }, '打开完整设置面板…') : null
      ) : h('div', { className: 'ie-desc' }, '读取状态中…')
    ) : null
  )
}

function InputEscapeStatusSection({ ui, gameId }) {
  const { state } = useInputEscapeState(ui, gameId)
  if (!state) return h('div', { className: 'ie-desc' }, '正在加载输入转义状态…')
  const eff = state.effective || {}
  const tel = state.telemetry
  return h('div', { className: 'ie-card' },
    h('div', { className: 'ie-head-row' },
      h('span', { className: 'ie-row-label' }, '当前生效状态'),
      h('span', { className: 'ie-badge ' + (eff.enabled ? '' : 'off') },
        eff.enabled ? (eff.inputEscapeEnabled ? (IE_MODE_LABELS[eff.inputMode] || eff.inputMode) : '仅防路由') : '已暂停'
      )
    ),
    h('div', { className: 'ie-desc' },
      '防路由：' + (eff.antiRouteEnabled ? '已启用' : '未启用') +
      ' · 本局策略：' + (eff.gameOverride === 'enabled' ? '强制开启' : eff.gameOverride === 'disabled' ? '本局暂停' : '跟随全局')
    ),
    tel ? h('div', { className: 'ie-desc' },
      '最近第 ' + tel.turn + ' 轮：' + (IE_MODE_LABELS[tel.inputMode] || tel.inputMode) +
      (tel.imagePages > 0 ? ' · 生成 ' + tel.imagePages + ' 页图片' : '') +
      (tel.antiRoute?.demotedSystems ? ' · 降权 ' + tel.antiRoute.demotedSystems + ' 段 System' : '')
    ) : null
  )
}
