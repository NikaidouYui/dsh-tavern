function rmCopyButton({ label, getText }) {
  const [copied, setCopied] = useState(false)
  return h('button', {
    type: 'button',
    className: copied ? 'rm-btn active' : 'rm-btn',
    onClick: async () => {
      try {
        const text = await getText()
        await rmCopyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch {}
    },
  }, copied ? '已复制 ✓' : label)
}

function rmMessageCard({ msg, searchQuery, decodeCompact, showWireEscaped, forceExpand, onZoomImage }) {
  const [localExpanded, setLocalExpanded] = useState(null)
  const effectiveExpanded = localExpanded !== null ? localExpanded : forceExpand

  const roleLabel = msg.role ? msg.role.toUpperCase() : 'UNKNOWN'
  const roleClass = `rm-msg role-${msg.role || 'user'}`

  const copyMsgText = () => {
    return (msg.parts || []).map(part => {
      if (part.type === 'text') return decodeCompact ? rmDecodeCompactCodepoints(part.text) : part.text
      if (part.type === 'thinking') return `[Thinking]\n${part.text}`
      if (part.type === 'tool_call') return `[ToolCall ${part.name}]\n${part.argsText}`
      if (part.type === 'tool_result') return `[ToolResult ${part.name || part.callId}]\n${part.contentText}`
      if (part.type === 'image') return `[Image ${part.mediaType}]`
      return ''
    }).filter(Boolean).join('\n\n')
  }

  return h('div', { className: roleClass },
    h('div', { className: 'rm-row' },
      h('div', { className: 'rm-row-left' },
        h('span', { className: 'rm-badge' }, `#${msg.index} · ${roleLabel}`),
        h('span', { className: 'rm-muted' }, `${msg.charCount} 字 · ~${msg.estimatedTokens} tok`),
        msg.hasImage ? h('span', { className: 'rm-badge info' }, '含图片') : null,
        msg.hasTool ? h('span', { className: 'rm-badge purple' }, '工具') : null,
        msg.hasThinking ? h('span', { className: 'rm-badge warn' }, '思考') : null,
        ...(msg.hints || []).map(hint => h('span', { key: hint, className: 'rm-badge' }, hint)),
      ),
      h('div', { className: 'rm-row-left' },
        h(rmCopyButton, { label: '复制', getText: copyMsgText }),
        h('button', {
          type: 'button',
          className: 'rm-btn',
          onClick: () => setLocalExpanded(!effectiveExpanded),
        }, effectiveExpanded ? '收起' : '展开'),
      ),
    ),
    ...(msg.parts || []).map((part, idx) => {
      if (part.type === 'text') {
        let display = part.text || ''
        if (decodeCompact && part.compactCodepointBlocks > 0) {
          display = rmDecodeCompactCodepoints(display)
        }
        if (showWireEscaped) {
          display = rmEncodeWireUnicode(display)
        }
        const searchHit = Boolean(searchQuery && display.toLowerCase().includes(searchQuery.toLowerCase()))
        const isOpen = effectiveExpanded || searchHit
        const preview = isOpen ? { text: display, truncated: false } : rmTruncatePreview(display, 10, 720)
        return h('div', { key: idx, className: 'rm-prose' },
          rmHighlightText(preview.text, searchQuery),
          preview.truncated
            ? h('div', { style: { marginTop: '6px' } },
                h('button', {
                  type: 'button',
                  className: 'rm-btn primary',
                  onClick: () => setLocalExpanded(true),
                }, `展开全文（共 ${display.length} 字 / ${part.lineCount} 行）`),
              )
            : null,
        )
      }
      if (part.type === 'thinking') {
        return h('div', { key: idx, className: 'rm-block-box' },
          h('div', { className: 'rm-row' },
            h('span', { className: 'rm-badge warn' }, part.redacted ? 'Thinking（已加密摘要）' : 'Thinking / Reasoning'),
            part.signature ? h('span', { className: 'rm-muted rm-mono' }, `sig:${part.signature.slice(0, 16)}…`) : null,
          ),
          effectiveExpanded
            ? h('pre', { className: 'rm-pre' }, rmHighlightText(part.text || '', searchQuery))
            : h('div', { className: 'rm-muted' }, `${(part.text || '').slice(0, 140)}${(part.text || '').length > 140 ? '…' : ''}`),
        )
      }
      if (part.type === 'image') {
        return h('div', { key: idx, className: 'rm-block-box' },
          h('div', { className: 'rm-row' },
            h('span', { className: 'rm-badge info' }, `多模态图片 · ${part.mediaType}`),
            part.byteSize ? h('span', { className: 'rm-muted' }, rmFormatBytes(part.byteSize)) : null,
          ),
          part.src
            ? h('div', { className: 'rm-img-wrap' },
                h('img', {
                  className: 'rm-img-thumb',
                  src: part.src,
                  alt: part.mediaType,
                  onClick: () => onZoomImage && onZoomImage(part.src),
                }),
                h('span', { className: 'rm-muted' }, '点击图片可放大预览'),
              )
            : h('span', { className: 'rm-muted' }, '（无法预览的图片地址）'),
        )
      }
      if (part.type === 'tool_call') {
        return h('div', { key: idx, className: 'rm-block-box' },
          h('div', { className: 'rm-row' },
            h('span', { className: 'rm-badge purple' }, `Tool Call · ${part.name || 'unknown'}`),
            part.id ? h('span', { className: 'rm-muted rm-mono' }, part.id) : null,
          ),
          h('pre', { className: 'rm-pre' }, rmHighlightText(part.argsText || '{}', searchQuery)),
        )
      }
      if (part.type === 'tool_result') {
        const preview = effectiveExpanded ? { text: part.contentText, truncated: false } : rmTruncatePreview(part.contentText, 8, 500)
        return h('div', { key: idx, className: 'rm-block-box' },
          h('div', { className: 'rm-row' },
            h('span', { className: part.isError ? 'rm-badge err' : 'rm-badge info' },
              `Tool Result · ${part.name || part.callId || 'result'}${part.isError ? ' (ERROR)' : ''}`),
          ),
          h('pre', { className: 'rm-pre' }, rmHighlightText(preview.text || '', searchQuery)),
        )
      }
      return null
    }),
  )
}

function RequestDetailView({ ui, record, loading, compact = false }) {
  const [tab, setTab] = useState('messages')
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [decodeCompact, setDecodeCompact] = useState(true)
  const [showWireEscaped, setShowWireEscaped] = useState(false)
  const [expandAll, setExpandAll] = useState(false)
  const [prettyWire, setPrettyWire] = useState(true)
  const [rawCharLimit, setRawCharLimit] = useState(60000)
  const [zoomSrc, setZoomSrc] = useState('')
  const [toolSearch, setToolSearch] = useState('')

  useEffect(() => {
    setRawCharLimit(60000)
  }, [record?.id])

  if (loading) {
    return h('div', { className: 'rm-card' }, h('span', { className: 'rm-muted' }, '正在加载真实请求详情…'))
  }
  if (!record) {
    return h('div', { className: 'rm-card' },
      h('div', { className: 'rm-title' }, '选择一条真实请求查看'),
      h('div', { className: 'rm-muted' }, '发送一轮对话或触发后台任务后，实际发往模型服务的 HTTP 请求会实时出现在这里。'),
    )
  }

  const parsed = record.parsed || {}
  const stats = parsed.stats || {}
  const ctx = record.tavernContext || null
  const badge = rmStatusBadge(record)
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []

  const filteredMessages = messages.filter(msg => {
    if (roleFilter !== 'all' && msg.role !== roleFilter) {
      if (!(roleFilter === 'assistant' && msg.role === 'model')) return false
    }
    if (!searchQuery.trim()) return true
    const needle = searchQuery.trim().toLowerCase()
    return (msg.parts || []).some(part => {
      const text = part.text || part.argsText || part.contentText || part.name || ''
      const checkText = decodeCompact ? rmDecodeCompactCodepoints(text) : text
      return checkText.toLowerCase().includes(needle)
    })
  })

  const exportViaHost = async format => {
    const res = await ui.callHost(`${RM_PLUGIN_ID}/export-record`, { id: record.id, format })
    return res?.content || ''
  }

  const wireDisplayText = (() => {
    const raw = record.rawBodyText || ''
    if (!raw) return '（未保存 Wire 载荷或请求体为空）'
    if (!prettyWire) return raw
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  })()

  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  const filteredTools = tools.filter(t => {
    if (!toolSearch.trim()) return true
    const q = toolSearch.trim().toLowerCase()
    return `${t.name} ${t.description}`.toLowerCase().includes(q)
  })

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    zoomSrc
      ? h('div', { className: 'rm-lightbox', onClick: () => setZoomSrc('') },
          h('img', { src: zoomSrc, alt: '预览大图' }),
        )
      : null,

    // 顶部摘要卡片
    h('div', { className: 'rm-card' },
      h('div', { className: 'rm-row' },
        h('div', { className: 'rm-row-left' },
          h('span', { className: `rm-badge ${badge.cls}` },
            h('span', { className: badge.pending ? 'rm-dot pending' : 'rm-dot' }),
            badge.label,
          ),
          h('span', { className: 'rm-title' }, `#${record.seq} · ${parsed.model || '(未指定模型)'}`),
          h('span', { className: 'rm-badge info' }, RM_PROTOCOL_LABELS[parsed.protocol] || parsed.protocol),
          ctx?.scope ? h('span', { className: 'rm-badge purple' }, RM_SCOPE_LABELS[ctx.scope] || ctx.scope) : null,
          ctx?.turn ? h('span', { className: 'rm-badge' }, `第 ${ctx.turn} 轮`) : null,
          record.attempt > 1 ? h('span', { className: 'rm-badge warn' }, `重试 #${record.attempt}`) : null,
        ),
        h('div', { className: 'rm-row-left' },
          h(rmCopyButton, { label: '复制 Markdown', getText: () => exportViaHost('markdown') }),
          h(rmCopyButton, { label: '复制解码 JSON', getText: () => exportViaHost('json-pretty') }),
          h(rmCopyButton, { label: '复制 cURL', getText: () => exportViaHost('curl') }),
        ),
      ),
      h('div', { className: 'rm-muted rm-mono', style: { wordBreak: 'break-all' } },
        `${record.method} ${record.url} · ${rmFormatTime(record.createdAt)} · ${record.transport}`,
      ),
      h('div', { className: 'rm-row-left' },
        h('span', { className: 'rm-badge' }, `${stats.messageCount || 0} 条消息`),
        h('span', { className: 'rm-badge' }, `${stats.totalChars || 0} 字符 · ~${stats.estimatedTokens || 0} tok`),
        h('span', { className: 'rm-badge' }, `Wire ${rmFormatBytes(record.wireBytes)}`),
        h('span', { className: 'rm-badge' }, `首包 ${rmFormatMs(record.ttfbMs)} · 总计 ${rmFormatMs(record.durationMs)}`),
        stats.wireUnicodeCount > 0 ? h('span', { className: 'rm-badge ok' }, `Wire \\uXXXX ×${stats.wireUnicodeCount}`) : null,
        stats.compactCodepointBlocks > 0 ? h('span', { className: 'rm-badge warn' }, `⟦U:...⟧ ×${stats.compactCodepointBlocks}`) : null,
        stats.imageCount > 0 ? h('span', { className: 'rm-badge info' }, `图片 ×${stats.imageCount}`) : null,
        stats.toolCount > 0 ? h('span', { className: 'rm-badge purple' }, `工具定义 ×${stats.toolCount}`) : null,
        stats.sessionFingerprint ? h('span', { className: 'rm-badge' }, `SID: ${stats.sessionFingerprint}`) : null,
      ),
      (record.error || record.errorResponseText)
        ? h('div', { className: 'rm-block-box', style: { borderColor: 'rgba(239, 68, 68, 0.5)' } },
            h('span', { className: 'rm-badge err' }, '错误详情'),
            record.error ? h('div', { className: 'rm-prose' }, record.error) : null,
            record.errorResponseText ? h('pre', { className: 'rm-pre' }, record.errorResponseText) : null,
          )
        : null,
    ),

    // 标签栏
    h('div', { className: 'rm-tabs' },
      h('button', { type: 'button', className: tab === 'messages' ? 'rm-tab active' : 'rm-tab', onClick: () => setTab('messages') },
        `对话阅读 (${messages.length})`),
      h('button', { type: 'button', className: tab === 'params' ? 'rm-tab active' : 'rm-tab', onClick: () => setTab('params') },
        `参数与工具 (${tools.length})`),
      h('button', { type: 'button', className: tab === 'http' ? 'rm-tab active' : 'rm-tab', onClick: () => setTab('http') },
        `HTTP 与请求头 (${(record.headers || []).length})`),
      h('button', { type: 'button', className: tab === 'wire' ? 'rm-tab active' : 'rm-tab', onClick: () => setTab('wire') },
        `原始 Wire (${rmFormatBytes(record.wireBytes)})`),
    ),

    // 标签页内容
    tab === 'messages'
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { className: 'rm-row' },
            h('div', { style: { flex: '1 1 180px' } },
              h('input', {
                className: 'rm-input',
                type: 'search',
                value: searchQuery,
                placeholder: '搜索请求正文关键词（世界书、预设、防路由标签等）…',
                onChange: e => setSearchQuery(e.target.value),
              }),
            ),
            h('div', { className: 'rm-row-left' },
              ['all', 'system', 'user', 'assistant', 'tool'].map(role =>
                h('button', {
                  key: role,
                  type: 'button',
                  className: roleFilter === role ? 'rm-btn active' : 'rm-btn',
                  onClick: () => setRoleFilter(role),
                }, role === 'all' ? '全部' : role.toUpperCase()),
              ),
              h('button', {
                type: 'button',
                className: expandAll ? 'rm-btn active' : 'rm-btn',
                onClick: () => setExpandAll(!expandAll),
              }, expandAll ? '全部收起' : '全部展开'),
              stats.compactCodepointBlocks > 0
                ? h('button', {
                    type: 'button',
                    className: decodeCompact ? 'rm-btn active' : 'rm-btn',
                    onClick: () => setDecodeCompact(!decodeCompact),
                  }, decodeCompact ? '已还原 ⟦U:...⟧' : '显示原始 ⟦U:...⟧')
                : null,
              stats.wireUnicodeCount > 0
                ? h('button', {
                    type: 'button',
                    className: showWireEscaped ? 'rm-btn active' : 'rm-btn',
                    onClick: () => setShowWireEscaped(!showWireEscaped),
                  }, showWireEscaped ? '显示 Wire \\uXXXX' : '已还原中文')
                : null,
            ),
          ),
          filteredMessages.length === 0
            ? h('div', { className: 'rm-card' }, h('span', { className: 'rm-muted' }, '没有符合当前筛选条件的消息'))
            : filteredMessages.map(msg =>
                h(rmMessageCard, {
                  key: `${record.id}-${msg.index}`,
                  msg,
                  searchQuery,
                  decodeCompact,
                  showWireEscaped,
                  forceExpand: expandAll || (!compact && filteredMessages.length <= 4),
                  onZoomImage: src => setZoomSrc(src),
                }),
              ),
        )
      : null,

    tab === 'params'
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { className: 'rm-kv-grid' },
            Object.entries(parsed.params || {}).map(([k, v]) =>
              h('div', { key: k, className: 'rm-kv-cell' },
                h('span', { className: 'rm-muted rm-mono' }, k),
                h('span', { className: 'rm-mono', style: { fontSize: '12px', wordBreak: 'break-word' } },
                  typeof v === 'object' ? JSON.stringify(v) : String(v)),
              ),
            ),
          ),
          tools.length > 0
            ? h('div', { className: 'rm-card' },
                h('div', { className: 'rm-row' },
                  h('span', { className: 'rm-title' }, `声明的工具定义 (${tools.length})`),
                  h('input', {
                    className: 'rm-input',
                    style: { width: '200px' },
                    type: 'search',
                    value: toolSearch,
                    placeholder: '筛选工具名或描述…',
                    onChange: e => setToolSearch(e.target.value),
                  }),
                ),
                filteredTools.map((tool, i) =>
                  h('details', { key: `${tool.name}-${i}`, className: 'rm-block-box' },
                    h('summary', { style: { cursor: 'pointer', fontWeight: 600 } },
                      `${tool.name || '(unnamed)'}${tool.description ? ` — ${tool.description.slice(0, 90)}` : ''}`),
                    tool.description ? h('div', { className: 'rm-prose', style: { marginTop: '6px' } }, tool.description) : null,
                    tool.parameters ? h('pre', { className: 'rm-pre', style: { marginTop: '6px' } }, JSON.stringify(tool.parameters, null, 2)) : null,
                  ),
                ),
              )
            : h('div', { className: 'rm-card' }, h('span', { className: 'rm-muted' }, '本次请求未携带工具定义（tools）')),
        )
      : null,

    tab === 'http'
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { className: 'rm-card' },
            h('div', { className: 'rm-title' }, '请求头（敏感凭证已脱敏）'),
            h('table', { className: 'rm-table' },
              h('thead', null, h('tr', null, h('th', null, 'Header'), h('th', null, 'Value'))),
              h('tbody', null,
                (record.headers || []).map((hdr, idx) =>
                  h('tr', { key: `${hdr.name}-${idx}` },
                    h('td', { className: 'rm-mono' },
                      hdr.name, ' ',
                      hdr.redacted ? h('span', { className: 'rm-badge warn' }, '已脱敏') : null,
                    ),
                    h('td', { className: 'rm-mono' }, hdr.value),
                  ),
                ),
              ),
            ),
          ),
          (record.responseHeaders || []).length > 0
            ? h('div', { className: 'rm-card' },
                h('div', { className: 'rm-title' }, '响应头'),
                h('table', { className: 'rm-table' },
                  h('thead', null, h('tr', null, h('th', null, 'Header'), h('th', null, 'Value'))),
                  h('tbody', null,
                    record.responseHeaders.map((hdr, idx) =>
                      h('tr', { key: `${hdr.name}-${idx}` },
                        h('td', { className: 'rm-mono' }, hdr.name),
                        h('td', { className: 'rm-mono' }, hdr.value),
                      ),
                    ),
                  ),
                ),
              )
            : null,
        )
      : null,

    tab === 'wire'
      ? h('div', { className: 'rm-card' },
          h('div', { className: 'rm-row' },
            h('div', { className: 'rm-row-left' },
              h('button', {
                type: 'button',
                className: !prettyWire ? 'rm-btn active' : 'rm-btn',
                onClick: () => setPrettyWire(false),
              }, '真实 Wire 原文（含 \\uXXXX）'),
              h('button', {
                type: 'button',
                className: prettyWire ? 'rm-btn active' : 'rm-btn',
                onClick: () => setPrettyWire(true),
              }, '格式化解码 JSON'),
              record.rawTruncated ? h('span', { className: 'rm-badge warn' }, '超大载荷已截断') : null,
            ),
            h(rmCopyButton, { label: '复制当前文本', getText: () => wireDisplayText }),
          ),
          h('pre', { className: 'rm-pre', style: { maxHeight: compact ? '380px' : '560px', overflowY: 'auto' } },
            wireDisplayText.slice(0, rawCharLimit),
          ),
          wireDisplayText.length > rawCharLimit
            ? h('div', { className: 'rm-row' },
                h('span', { className: 'rm-muted' }, `当前显示前 ${rawCharLimit} / ${wireDisplayText.length} 字符`),
                h('button', {
                  type: 'button',
                  className: 'rm-btn primary',
                  onClick: () => setRawCharLimit(prev => prev + 120000),
                }, '加载更多 (+120K 字符)'),
              )
            : null,
        )
      : null,
  )
}
