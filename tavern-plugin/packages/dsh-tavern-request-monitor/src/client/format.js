const RM_PLUGIN_ID = 'dsh-tavern-request-monitor'
const RM_PANEL_ID = 'request-monitor'

const RM_SCOPE_LABELS = {
  story: '前台正文',
  background: '后台结算',
  compaction: '上下文压缩',
  card: '卡片工作台',
  subagent: '插件子代理',
}

const RM_PROTOCOL_LABELS = {
  'openai-completions': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic',
  'gemini-native': 'Gemini Native',
  'generic-json': 'JSON',
}

function rmFormatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function rmFormatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '-'
  const n = Number(ms)
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

function rmFormatTime(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

function rmDecodeCompactCodepoints(text) {
  return String(text || '').replace(/⟦U:([0-9A-Fa-f\s]+)⟧/g, (full, hexList) => {
    try {
      const codes = hexList.trim().split(/\s+/).filter(Boolean).map(item => parseInt(item, 16))
      if (!codes.length || codes.some(cp => !Number.isInteger(cp) || cp < 0 || cp > 0x10ffff)) return full
      return String.fromCodePoint(...codes)
    } catch {
      return full
    }
  })
}

function rmEncodeWireUnicode(text) {
  let out = ''
  const s = String(text || '')
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code > 127) {
      out += '\\u' + code.toString(16).padStart(4, '0')
    } else {
      out += s[i]
    }
  }
  return out
}

function rmHighlightText(text, query) {
  const source = String(text || '')
  const needle = String(query || '').trim()
  if (!needle) return source
  const lowerSrc = source.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const nodes = []
  let cursor = 0
  let guard = 0
  while (cursor < source.length && guard < 120) {
    const at = lowerSrc.indexOf(lowerNeedle, cursor)
    if (at < 0) break
    if (at > cursor) nodes.push(source.slice(cursor, at))
    nodes.push(h('mark', { key: `m-${guard}-${at}`, className: 'rm-mark' }, source.slice(at, at + needle.length)))
    cursor = at + needle.length
    guard += 1
  }
  if (cursor < source.length) nodes.push(source.slice(cursor))
  return nodes.length ? nodes : source
}

async function rmCopyText(text) {
  const value = String(text || '')
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return true
  }
  if (typeof document !== 'undefined') {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
  return false
}

function rmStatusBadge(item) {
  if (!item) return { cls: '', label: '-' }
  if (item.state === 'pending') return { cls: 'warn', label: '发送中', pending: true }
  if (item.state === 'error' || (item.statusCode && item.statusCode >= 400)) {
    return { cls: 'err', label: item.statusCode ? `HTTP ${item.statusCode}` : '失败' }
  }
  return { cls: 'ok', label: item.statusCode ? `HTTP ${item.statusCode}` : '完成' }
}

function rmTruncatePreview(text, maxLines = 12, maxChars = 900) {
  const s = String(text || '')
  const lines = s.split('\n')
  const lineCut = lines.length > maxLines
  const clippedLines = lineCut ? lines.slice(0, maxLines).join('\n') : s
  if (clippedLines.length > maxChars) {
    return { text: clippedLines.slice(0, maxChars), truncated: true }
  }
  return { text: clippedLines, truncated: lineCut }
}
