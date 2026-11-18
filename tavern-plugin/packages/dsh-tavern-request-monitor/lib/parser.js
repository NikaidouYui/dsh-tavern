const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key|api-key|x-auth-token|x-secret|.*(?:api[-_]?key|secret|token|password|credential).*)$/i
const SENSITIVE_QUERY_RE = /^(key|api_key|apikey|token|access_token|refresh_token|secret|auth|signature|sig|x-goog-api-key)$/i

export function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** 遮罩敏感凭证，仅保留前后极短特征与长度提示。 */
export function maskSecret(raw) {
  const text = str(raw).trim()
  if (!text) return ''
  const prefixMatch = text.match(/^(Bearer|Basic|Token)\s+(.+)$/i)
  if (prefixMatch) {
    return `${prefixMatch[1]} ${maskPlainToken(prefixMatch[2])}`
  }
  return maskPlainToken(text)
}

function maskPlainToken(token) {
  const s = str(token)
  if (s.length <= 10) return `***[REDACTED len:${s.length}]`
  return `${s.slice(0, 4)}...${s.slice(-4)} (len:${s.length})`
}

/** 脱敏 URL query 中的敏感 Key（如 Gemini `?key=AIza...`）。 */
export function redactUrl(rawUrl) {
  const input = str(rawUrl).trim()
  if (!input) return ''
  try {
    const parsed = new URL(input)
    let changed = false
    for (const [k, v] of parsed.searchParams.entries()) {
      if (SENSITIVE_QUERY_RE.test(k)) {
        parsed.searchParams.set(k, maskPlainToken(v))
        changed = true
      }
    }
    return changed ? parsed.toString() : input
  } catch {
    return input.replace(/([?&](?:key|api_key|apikey|token|access_token|secret)=)([^&#]+)/gi, (_m, p1, p2) => p1 + maskPlainToken(p2))
  }
}

/** 将多种形式的 HTTP Headers 归一化为数组并对敏感头脱敏。 */
export function normalizeAndRedactHeaders(rawHeaders) {
  const pairs = []
  if (!rawHeaders) return pairs

  if (Array.isArray(rawHeaders)) {
    if (rawHeaders.length > 0 && Array.isArray(rawHeaders[0])) {
      for (const item of rawHeaders) {
        if (Array.isArray(item) && item.length >= 2) pairs.push([str(item[0]), str(item[1])])
      }
    } else {
      // undici headers 是一维交替数组 [k1, v1, k2, v2, ...]
      for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
        pairs.push([str(rawHeaders[i]), str(rawHeaders[i + 1])])
      }
    }
  } else if (typeof rawHeaders.entries === 'function') {
    for (const [k, v] of rawHeaders.entries()) pairs.push([str(k), str(v)])
  } else if (typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (Array.isArray(v)) {
        for (const item of v) pairs.push([str(k), str(item)])
      } else {
        pairs.push([str(k), str(v)])
      }
    }
  }

  return pairs
    .filter(([name]) => name.trim() !== '')
    .map(([name, value]) => {
      const redacted = SENSITIVE_HEADER_RE.test(name.trim())
      return {
        name: name.trim(),
        value: redacted ? maskSecret(value) : value,
        redacted,
      }
    })
}

export function getHeaderIgnoreCase(headersList, target) {
  const lower = str(target).toLowerCase()
  const found = (Array.isArray(headersList) ? headersList : []).find(item => str(item?.name).toLowerCase() === lower)
  return found ? str(found.value) : ''
}

/** 估算文本 Token（区分 ASCII 与 CJK/非 ASCII）。 */
export function estimateTokens(text) {
  const s = str(text)
  if (!s) return 0
  let nonAscii = 0
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 127) nonAscii += 1
  }
  const ascii = s.length - nonAscii
  return Math.ceil(ascii / 4 + nonAscii * 1.35)
}

/** 从文本中提取显著结构标签提示，方便折叠阅读。 */
export function extractSectionHints(text) {
  const s = str(text)
  if (!s) return []
  const hints = []
  const seen = new Set()
  const push = label => {
    const clean = label.trim()
    if (!clean || seen.has(clean) || hints.length >= 6) return
    seen.add(clean)
    hints.push(clean)
  }

  const bracketMatches = s.match(/【[^【】\n]{1,18}】/g) || []
  for (const m of bracketMatches) push(m)

  if (/\[Session-ID:\s*[^\]]+\]/i.test(s)) push('[Session-ID]')
  if (/<UpdateVariable>/i.test(s)) push('<UpdateVariable>')
  if (/<thinking>/i.test(s)) push('<thinking>')

  const xmlMatches = s.match(/<([a-zA-Z][a-zA-Z0-9_-]{1,24})(?:\s[^>]*)?>/g) || []
  for (const tag of xmlMatches) {
    const nameMatch = tag.match(/^<([a-zA-Z][a-zA-Z0-9_-]{1,24})/)
    if (nameMatch) push(`<${nameMatch[1]}>`)
  }
  return hints
}

function makeTextPart(text) {
  const value = str(text)
  const lineCount = value === '' ? 0 : value.split('\n').length
  const compactMatches = value.match(/⟦U:[0-9A-Fa-f\s]+⟧/g)
  return {
    type: 'text',
    text: value,
    charCount: value.length,
    lineCount,
    compactCodepointBlocks: compactMatches ? compactMatches.length : 0,
    hints: extractSectionHints(value),
  }
}

function makeImagePart({ mediaType = 'image/png', url = '', base64 = '' }) {
  const mime = /^image\/[a-zA-Z0-9.+-]+$/i.test(mediaType) ? mediaType : 'image/png'
  let src = ''
  let byteSize = 0
  let isBase64 = false
  if (base64) {
    const cleanB64 = str(base64).replace(/\s+/g, '')
    src = `data:${mime};base64,${cleanB64}`
    byteSize = Math.floor((cleanB64.length * 3) / 4)
    isBase64 = true
  } else if (url) {
    const u = str(url).trim()
    if (u.startsWith('data:image/')) {
      src = u
      const comma = u.indexOf(',')
      if (comma >= 0) byteSize = Math.floor(((u.length - comma - 1) * 3) / 4)
      isBase64 = true
    } else if (/^https?:\/\//i.test(u)) {
      src = u
    }
  }
  return {
    type: 'image',
    mediaType: mime,
    src,
    byteSize,
    isBase64,
  }
}

function stringifyCompact(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return str(value)
  }
}

function finalizeMessage(index, role, parts) {
  const cleanParts = parts.filter(Boolean)
  let charCount = 0
  let estimatedTokens = 0
  let hasImage = false
  let hasTool = false
  let hasThinking = false
  const hintSet = new Set()

  for (const part of cleanParts) {
    if (part.type === 'text') {
      charCount += part.charCount
      estimatedTokens += estimateTokens(part.text)
      for (const h of part.hints || []) {
        if (hintSet.size < 6) hintSet.add(h)
      }
    } else if (part.type === 'thinking') {
      hasThinking = true
      charCount += str(part.text).length
      estimatedTokens += estimateTokens(part.text)
    } else if (part.type === 'image') {
      hasImage = true
      estimatedTokens += 256
    } else if (part.type === 'tool_call') {
      hasTool = true
      const raw = `${part.name}(${part.argsText})`
      charCount += raw.length
      estimatedTokens += estimateTokens(raw)
    } else if (part.type === 'tool_result') {
      hasTool = true
      charCount += str(part.contentText).length
      estimatedTokens += estimateTokens(part.contentText)
    }
  }

  return {
    index,
    role: str(role || 'user').toLowerCase(),
    parts: cleanParts,
    charCount,
    estimatedTokens,
    hints: Array.from(hintSet),
    hasImage,
    hasTool,
    hasThinking,
  }
}

function parseGenericContentBlocks(content) {
  if (typeof content === 'string') return content ? [makeTextPart(content)] : []
  if (!Array.isArray(content)) return content == null ? [] : [makeTextPart(stringifyCompact(content))]
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push(makeTextPart(block))
      continue
    }
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') {
      parts.push(makeTextPart(block.text ?? block.value ?? ''))
    } else if (block.type === 'image_url') {
      const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url
      parts.push(makeImagePart({ url }))
    } else if (block.type === 'input_image') {
      parts.push(makeImagePart({ url: block.image_url || block.url }))
    } else if (block.type === 'image') {
      if (block.source?.type === 'base64') {
        parts.push(makeImagePart({ mediaType: block.source.media_type, base64: block.source.data }))
      } else if (block.data) {
        parts.push(makeImagePart({ mediaType: block.mediaType || block.mimeType, base64: block.data }))
      } else {
        parts.push(makeImagePart({ url: block.source?.url || block.url }))
      }
    } else if (block.type === 'thinking') {
      parts.push({
        type: 'thinking',
        text: str(block.thinking ?? block.text),
        signature: str(block.signature),
        redacted: false,
      })
    } else if (block.type === 'redacted_thinking') {
      parts.push({
        type: 'thinking',
        text: `[Redacted Thinking · ${str(block.data).length} chars]`,
        signature: '',
        redacted: true,
      })
    } else if (block.type === 'tool_use') {
      parts.push({
        type: 'tool_call',
        id: str(block.id),
        name: str(block.name),
        argsText: stringifyCompact(block.input ?? {}),
      })
    } else if (block.type === 'tool_result') {
      const inner = Array.isArray(block.content)
        ? block.content.map(c => (typeof c === 'string' ? c : c?.text ?? stringifyCompact(c))).join('\n')
        : stringifyCompact(block.content ?? '')
      parts.push({
        type: 'tool_result',
        callId: str(block.tool_use_id),
        name: str(block.name),
        contentText: inner,
        isError: block.is_error === true,
      })
    } else {
      parts.push(makeTextPart(stringifyCompact(block)))
    }
  }
  return parts
}

/** 探测请求体遵循的 LLM 线缆协议。 */
export function detectProtocol(body, url = '', headersList = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'generic-json'
  const urlText = str(url)
  if (Array.isArray(body.contents) || /:(?:stream)?generateContent(?:\?|$)/i.test(urlText)) {
    return 'gemini-native'
  }
  if (Array.isArray(body.input) && (/\/responses(?:\?|$)/i.test(urlText) || !Array.isArray(body.messages))) {
    return 'openai-responses'
  }
  if (Array.isArray(body.messages)) {
    const hasAnthropicHeader = getHeaderIgnoreCase(headersList, 'anthropic-version') !== ''
    const hasAnthropicTool = Array.isArray(body.tools) && body.tools.some(t => t && typeof t === 'object' && 'input_schema' in t && !('function' in t))
    if (hasAnthropicHeader || /\/v\d+\/messages(?:\?|$)/i.test(urlText) || hasAnthropicTool || body.system !== undefined) {
      return 'anthropic-messages'
    }
    return 'openai-completions'
  }
  return 'generic-json'
}

function parseGeminiMessages(body) {
  const messages = []
  let idx = 1
  if (body.systemInstruction) {
    const parts = parseGeminiParts(body.systemInstruction.parts || body.systemInstruction)
    if (parts.length) messages.push(finalizeMessage(idx++, 'system', parts))
  }
  for (const item of Array.isArray(body.contents) ? body.contents : []) {
    if (!item || typeof item !== 'object') continue
    const role = item.role === 'model' ? 'assistant' : (item.role || 'user')
    const parts = parseGeminiParts(item.parts)
    messages.push(finalizeMessage(idx++, role, parts))
  }
  return messages
}

function parseGeminiParts(rawParts) {
  const list = Array.isArray(rawParts) ? rawParts : (typeof rawParts === 'string' ? [{ text: rawParts }] : [])
  const parts = []
  for (const part of list) {
    if (!part || typeof part !== 'object') continue
    if (part.thought === true && typeof part.text === 'string') {
      parts.push({
        type: 'thinking',
        text: part.text,
        signature: str(part.thoughtSignature),
        redacted: false,
      })
    } else if (typeof part.text === 'string') {
      parts.push(makeTextPart(part.text))
    } else if (part.inlineData || part.inline_data) {
      const inline = part.inlineData || part.inline_data
      parts.push(makeImagePart({
        mediaType: inline.mimeType || inline.mime_type || 'image/png',
        base64: inline.data || '',
      }))
    } else if (part.functionCall) {
      parts.push({
        type: 'tool_call',
        id: str(part.functionCall.id),
        name: str(part.functionCall.name),
        argsText: stringifyCompact(part.functionCall.args ?? {}),
        thoughtSignature: str(part.thoughtSignature),
      })
    } else if (part.functionResponse) {
      parts.push({
        type: 'tool_result',
        callId: str(part.functionResponse.id),
        name: str(part.functionResponse.name),
        contentText: stringifyCompact(part.functionResponse.response ?? {}),
        isError: false,
      })
    } else {
      parts.push(makeTextPart(stringifyCompact(part)))
    }
  }
  return parts
}

function parseOpenAiResponses(body) {
  const messages = []
  let idx = 1
  if (typeof body.instructions === 'string' && body.instructions.trim() !== '') {
    messages.push(finalizeMessage(idx++, 'system', [makeTextPart(body.instructions)]))
  }
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (typeof item === 'string') {
      messages.push(finalizeMessage(idx++, 'user', [makeTextPart(item)]))
      continue
    }
    if (!item || typeof item !== 'object') continue
    if (item.type === 'function_call') {
      messages.push(finalizeMessage(idx++, 'assistant', [{
        type: 'tool_call',
        id: str(item.call_id || item.id),
        name: str(item.name),
        argsText: typeof item.arguments === 'string' ? tryPrettifyJson(item.arguments) : stringifyCompact(item.arguments ?? {}),
      }]))
    } else if (item.type === 'function_call_output') {
      messages.push(finalizeMessage(idx++, 'tool', [{
        type: 'tool_result',
        callId: str(item.call_id),
        name: '',
        contentText: str(item.output),
        isError: false,
      }]))
    } else if (item.type === 'reasoning') {
      const summaryText = Array.isArray(item.summary) ? item.summary.map(s => s?.text || '').filter(Boolean).join('\n') : str(item.text)
      messages.push(finalizeMessage(idx++, 'assistant', [{
        type: 'thinking',
        text: summaryText || '[Reasoning Block]',
        signature: '',
        redacted: !summaryText,
      }]))
    } else {
      const parts = parseGenericContentBlocks(item.content ?? item.text ?? '')
      messages.push(finalizeMessage(idx++, item.role || 'user', parts))
    }
  }
  return messages
}

function parseChatMessages(body) {
  const messages = []
  let idx = 1
  if (body.system !== undefined && body.system !== null && body.system !== '') {
    const sysParts = parseGenericContentBlocks(body.system)
    if (sysParts.length) messages.push(finalizeMessage(idx++, 'system', sysParts))
  }
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue
    const parts = []
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content !== '') {
      parts.push({ type: 'thinking', text: msg.reasoning_content, signature: '', redacted: false })
    }
    if (msg.role === 'tool') {
      const contentText = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(c => c?.text ?? stringifyCompact(c)).join('\n')
          : stringifyCompact(msg.content ?? '')
      parts.push({
        type: 'tool_result',
        callId: str(msg.tool_call_id),
        name: str(msg.name),
        contentText,
        isError: false,
      })
    } else {
      parts.push(...parseGenericContentBlocks(msg.content))
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || typeof tc !== 'object') continue
        const fn = tc.function || tc
        parts.push({
          type: 'tool_call',
          id: str(tc.id),
          name: str(fn.name),
          argsText: typeof fn.arguments === 'string' ? tryPrettifyJson(fn.arguments) : stringifyCompact(fn.arguments ?? {}),
          thoughtSignature: str(tc.extra_content?.google?.thought_signature),
        })
      }
    }
    messages.push(finalizeMessage(idx++, msg.role || 'user', parts))
  }
  return messages
}

function tryPrettifyJson(text) {
  const s = str(text)
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

function extractTools(body, protocol) {
  if (!Array.isArray(body?.tools)) return []
  const list = []
  if (protocol === 'gemini-native') {
    for (const group of body.tools) {
      for (const decl of Array.isArray(group?.functionDeclarations) ? group.functionDeclarations : []) {
        if (!decl || typeof decl !== 'object') continue
        list.push({
          name: str(decl.name),
          description: str(decl.description),
          parameters: decl.parametersJsonSchema || decl.parameters || null,
        })
      }
    }
    return list
  }
  for (const tool of body.tools) {
    if (!tool || typeof tool !== 'object') continue
    if (tool.function && typeof tool.function === 'object') {
      list.push({
        name: str(tool.function.name),
        description: str(tool.function.description),
        parameters: tool.function.parameters || null,
      })
    } else {
      list.push({
        name: str(tool.name),
        description: str(tool.description),
        parameters: tool.input_schema || tool.parameters || null,
      })
    }
  }
  return list
}

const SKIP_PARAM_KEYS = new Set([
  'messages', 'contents', 'input', 'system', 'instructions', 'systemInstruction', 'tools', 'signal',
])

function extractParams(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const out = {}
  for (const [k, v] of Object.entries(body)) {
    if (SKIP_PARAM_KEYS.has(k) || v === undefined) continue
    out[k] = v
  }
  return out
}

/** 完整解析一次模型请求体，输出人类可读的标准化结构与统计摘要。 */
export function parseLlmPayload(body, { url = '', headersList = [], rawText = '' } = {}) {
  const protocol = detectProtocol(body, url, headersList)
  let messages = []
  if (protocol === 'gemini-native') {
    messages = parseGeminiMessages(body)
  } else if (protocol === 'openai-responses') {
    messages = parseOpenAiResponses(body)
  } else if (protocol === 'openai-completions' || protocol === 'anthropic-messages') {
    messages = parseChatMessages(body)
  } else if (body && typeof body === 'object') {
    messages = [finalizeMessage(1, 'payload', [makeTextPart(stringifyCompact(body))])]
  }

  const tools = extractTools(body, protocol)
  const params = extractParams(body)

  const wireUnicodeMatches = str(rawText).match(/\\u[0-9a-fA-F]{4}/g)
  const wireUnicodeCount = wireUnicodeMatches ? wireUnicodeMatches.length : 0

  let totalChars = 0
  let totalTokens = 0
  let imageCount = 0
  let toolCallCount = 0
  let compactCodepointBlocks = 0
  let sessionFingerprint = ''

  for (const msg of messages) {
    totalChars += msg.charCount
    totalTokens += msg.estimatedTokens
    for (const part of msg.parts) {
      if (part.type === 'image') imageCount += 1
      else if (part.type === 'tool_call') toolCallCount += 1
      else if (part.type === 'text') {
        compactCodepointBlocks += part.compactCodepointBlocks || 0
        if (!sessionFingerprint) {
          const sid = part.text.match(/\[Session-ID:\s*([^\]]+)\]/i)
          if (sid) sessionFingerprint = sid[1].trim()
        }
      }
    }
  }

  const model = str(body?.model) || (url.match(/\/models\/([^/:?]+)/)?.[1] || '')
  return {
    protocol,
    model,
    stream: body?.stream === true || /:streamGenerateContent/i.test(str(url)),
    messages,
    tools,
    params,
    stats: {
      messageCount: messages.length,
      toolCount: tools.length,
      toolCallCount,
      imageCount,
      totalChars,
      estimatedTokens: totalTokens,
      wireUnicodeCount,
      compactCodepointBlocks,
      sessionFingerprint,
    },
  }
}

/** 还原 ⟦U:HEX ...⟧ 紧凑码点，仅供阅读预览。 */
export function decodeCompactCodepoints(text) {
  return str(text).replace(/⟦U:([0-9A-Fa-f\s]+)⟧/g, (full, hexList) => {
    try {
      const codes = hexList.trim().split(/\s+/).filter(Boolean).map(h => parseInt(h, 16))
      if (!codes.length || codes.some(cp => !Number.isInteger(cp) || cp < 0 || cp > 0x10ffff)) return full
      return String.fromCodePoint(...codes)
    } catch {
      return full
    }
  })
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const inputTokens = raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokenCount ?? raw.inputTokens
  const outputTokens = raw.completion_tokens ?? raw.output_tokens ?? raw.candidatesTokenCount ?? raw.outputTokens
  const thinkingTokens = raw.thoughtsTokenCount ?? raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens
  const cacheReadTokens = raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? raw.cachedContentTokenCount ?? raw.cacheReadTokens
  const cacheWriteTokens = raw.cache_creation_input_tokens ?? raw.cacheWriteTokens
  const totalTokens = raw.total_tokens ?? raw.totalTokenCount
  const out = {}
  if (Number.isFinite(inputTokens)) out.inputTokens = Number(inputTokens)
  if (Number.isFinite(outputTokens)) out.outputTokens = Number(outputTokens)
  if (Number.isFinite(thinkingTokens)) out.thinkingTokens = Number(thinkingTokens)
  if (Number.isFinite(cacheReadTokens)) out.cacheReadTokens = Number(cacheReadTokens)
  if (Number.isFinite(cacheWriteTokens)) out.cacheWriteTokens = Number(cacheWriteTokens)
  if (Number.isFinite(totalTokens)) out.totalTokens = Number(totalTokens)
  return Object.keys(out).length ? out : null
}

function mergeUsage(target, next) {
  if (!next) return target
  return { ...(target || {}), ...next }
}

function appendGeminiParts(parts, acc) {
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue
    if (part.thought === true && typeof part.text === 'string') {
      acc.thinking += part.text
    } else if (typeof part.text === 'string') {
      acc.text += part.text
    } else if (part.functionCall) {
      acc.toolCalls.push({
        id: str(part.functionCall.id),
        name: str(part.functionCall.name),
        argsText: stringifyCompact(part.functionCall.args ?? {}),
      })
    }
  }
}

function parseSseResponse(rawText) {
  const lines = str(rawText).split(/\r?\n/)
  const acc = {
    format: 'sse',
    model: '',
    responseId: '',
    finishReason: '',
    doneMarker: false,
    eventCount: 0,
    text: '',
    thinking: '',
    toolCalls: [],
    usage: null,
    errorMessage: '',
  }
  const openAiToolMap = new Map()
  const anthropicBlocks = new Map()
  const responsesToolMap = new Map()
  let currentEvent = ''
  let dataLines = []

  const flushEvent = () => {
    if (!dataLines.length) {
      currentEvent = ''
      return
    }
    const payload = dataLines.join('\n').trim()
    dataLines = []
    const evtName = currentEvent
    currentEvent = ''
    if (!payload) return
    if (payload === '[DONE]') {
      acc.doneMarker = true
      return
    }
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      return
    }
    if (!chunk || typeof chunk !== 'object') return
    acc.eventCount += 1
    if (chunk.id && !acc.responseId) acc.responseId = str(chunk.id)
    if (chunk.model && !acc.model) acc.model = str(chunk.model)
    if (chunk.error) {
      acc.errorMessage = str(chunk.error?.message || stringifyCompact(chunk.error))
    }

    // 1) OpenAI Chat Completions SSE
    if (Array.isArray(chunk.choices)) {
      for (const choice of chunk.choices) {
        const delta = choice?.delta
        if (delta && typeof delta === 'object') {
          if (typeof delta.reasoning_content === 'string') acc.thinking += delta.reasoning_content
          if (typeof delta.reasoning === 'string') acc.thinking += delta.reasoning
          if (typeof delta.content === 'string') acc.text += delta.content
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = Number.isInteger(tc?.index) ? tc.index : 0
              let slot = openAiToolMap.get(idx)
              if (!slot) {
                slot = { id: '', name: '', argsRaw: '' }
                openAiToolMap.set(idx, slot)
              }
              if (tc.id) slot.id = str(tc.id)
              if (tc.function?.name) slot.name += str(tc.function.name)
              if (typeof tc.function?.arguments === 'string') slot.argsRaw += tc.function.arguments
            }
          }
        }
        if (choice?.message) {
          if (typeof choice.message.reasoning_content === 'string') acc.thinking += choice.message.reasoning_content
          if (typeof choice.message.content === 'string') acc.text += choice.message.content
        }
        if (choice?.finish_reason) acc.finishReason = str(choice.finish_reason)
      }
      if (chunk.usage) acc.usage = mergeUsage(acc.usage, normalizeUsage(chunk.usage))
      return
    }

    // 2) Anthropic Messages SSE
    const type = str(chunk.type || evtName)
    if (type === 'message_start' && chunk.message) {
      if (chunk.message.id) acc.responseId = str(chunk.message.id)
      if (chunk.message.model) acc.model = str(chunk.message.model)
      if (chunk.message.usage) acc.usage = mergeUsage(acc.usage, normalizeUsage(chunk.message.usage))
      return
    }
    if (type === 'content_block_start' && chunk.content_block) {
      const idx = Number.isInteger(chunk.index) ? chunk.index : anthropicBlocks.size
      if (chunk.content_block.type === 'tool_use') {
        anthropicBlocks.set(idx, {
          kind: 'tool',
          id: str(chunk.content_block.id),
          name: str(chunk.content_block.name),
          argsRaw: '',
        })
      }
      return
    }
    if (type === 'content_block_delta' && chunk.delta) {
      const idx = Number.isInteger(chunk.index) ? chunk.index : 0
      if (chunk.delta.type === 'text_delta') acc.text += str(chunk.delta.text)
      else if (chunk.delta.type === 'thinking_delta') acc.thinking += str(chunk.delta.thinking)
      else if (chunk.delta.type === 'input_json_delta') {
        const slot = anthropicBlocks.get(idx)
        if (slot) slot.argsRaw += str(chunk.delta.partial_json)
      }
      return
    }
    if (type === 'message_delta') {
      if (chunk.delta?.stop_reason) acc.finishReason = str(chunk.delta.stop_reason)
      if (chunk.usage) acc.usage = mergeUsage(acc.usage, normalizeUsage(chunk.usage))
      return
    }
    if (type === 'message_stop') {
      acc.doneMarker = true
      return
    }

    // 3) OpenAI Responses SSE
    if (type === 'response.output_text.delta') {
      acc.text += str(chunk.delta)
      return
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      acc.thinking += str(chunk.delta)
      return
    }
    if (type === 'response.output_item.added' && chunk.item?.type === 'function_call') {
      responsesToolMap.set(str(chunk.item.id || chunk.output_index), {
        id: str(chunk.item.call_id || chunk.item.id),
        name: str(chunk.item.name),
        argsRaw: str(chunk.item.arguments),
      })
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const slot = responsesToolMap.get(str(chunk.item_id || chunk.output_index))
      if (slot) slot.argsRaw += str(chunk.delta)
      return
    }
    if (type === 'response.completed' && chunk.response) {
      acc.doneMarker = true
      if (chunk.response.id) acc.responseId = str(chunk.response.id)
      if (chunk.response.model) acc.model = str(chunk.response.model)
      if (chunk.response.status) acc.finishReason = str(chunk.response.status)
      if (chunk.response.usage) acc.usage = mergeUsage(acc.usage, normalizeUsage(chunk.response.usage))
      return
    }

    // 4) Gemini Native SSE
    if (Array.isArray(chunk.candidates)) {
      for (const cand of chunk.candidates) {
        appendGeminiParts(cand?.content?.parts, acc)
        if (cand?.finishReason) acc.finishReason = str(cand.finishReason)
      }
      if (chunk.modelVersion && !acc.model) acc.model = str(chunk.modelVersion)
      if (chunk.usageMetadata) acc.usage = mergeUsage(acc.usage, normalizeUsage(chunk.usageMetadata))
    }
  }

  for (const line of lines) {
    if (line === '') {
      flushEvent()
    } else if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  flushEvent()

  for (const slot of Array.from(openAiToolMap.entries()).sort((a, b) => a[0] - b[0]).map(e => e[1])) {
    acc.toolCalls.push({ id: slot.id, name: slot.name, argsText: tryPrettifyJson(slot.argsRaw) })
  }
  for (const slot of anthropicBlocks.values()) {
    if (slot.kind === 'tool') {
      acc.toolCalls.push({ id: slot.id, name: slot.name, argsText: tryPrettifyJson(slot.argsRaw) })
    }
  }
  for (const slot of responsesToolMap.values()) {
    acc.toolCalls.push({ id: slot.id, name: slot.name, argsText: tryPrettifyJson(slot.argsRaw) })
  }

  return acc
}

function parseJsonResponseObject(parsed) {
  const acc = {
    format: 'json',
    model: '',
    responseId: '',
    finishReason: '',
    doneMarker: true,
    eventCount: 1,
    text: '',
    thinking: '',
    toolCalls: [],
    usage: null,
    errorMessage: '',
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  acc.eventCount = items.length
  for (const obj of items) {
    if (!obj || typeof obj !== 'object') continue
    if (obj.id && !acc.responseId) acc.responseId = str(obj.id)
    if ((obj.model || obj.modelVersion) && !acc.model) acc.model = str(obj.model || obj.modelVersion)
    if (obj.error) {
      acc.errorMessage = str(obj.error?.message || stringifyCompact(obj.error))
    }
    // OpenAI Chat
    if (Array.isArray(obj.choices)) {
      for (const c of obj.choices) {
        const msg = c?.message || c?.delta
        if (msg) {
          if (typeof msg.reasoning_content === 'string') acc.thinking += msg.reasoning_content
          if (typeof msg.content === 'string') acc.text += msg.content
          if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              acc.toolCalls.push({
                id: str(tc.id),
                name: str(tc.function?.name || tc.name),
                argsText: typeof tc.function?.arguments === 'string'
                  ? tryPrettifyJson(tc.function.arguments)
                  : stringifyCompact(tc.function?.arguments ?? {}),
              })
            }
          }
        }
        if (c?.finish_reason) acc.finishReason = str(c.finish_reason)
      }
      if (obj.usage) acc.usage = mergeUsage(acc.usage, normalizeUsage(obj.usage))
    }
    // Anthropic Messages
    if (obj.type === 'message' && Array.isArray(obj.content)) {
      for (const blk of obj.content) {
        if (!blk || typeof blk !== 'object') continue
        if (blk.type === 'thinking') acc.thinking += str(blk.thinking)
        else if (blk.type === 'text') acc.text += str(blk.text)
        else if (blk.type === 'tool_use') {
          acc.toolCalls.push({ id: str(blk.id), name: str(blk.name), argsText: stringifyCompact(blk.input ?? {}) })
        }
      }
      if (obj.stop_reason) acc.finishReason = str(obj.stop_reason)
      if (obj.usage) acc.usage = mergeUsage(acc.usage, normalizeUsage(obj.usage))
    }
    // OpenAI Responses
    if (Array.isArray(obj.output)) {
      for (const outItem of obj.output) {
        if (!outItem || typeof outItem !== 'object') continue
        if (outItem.type === 'reasoning' && Array.isArray(outItem.summary)) {
          acc.thinking += outItem.summary.map(s => s?.text || '').join('\n')
        } else if (outItem.type === 'message' && Array.isArray(outItem.content)) {
          for (const part of outItem.content) {
            if (part?.text) acc.text += str(part.text)
          }
        } else if (outItem.type === 'function_call') {
          acc.toolCalls.push({
            id: str(outItem.call_id || outItem.id),
            name: str(outItem.name),
            argsText: typeof outItem.arguments === 'string' ? tryPrettifyJson(outItem.arguments) : stringifyCompact(outItem.arguments ?? {}),
          })
        }
      }
      if (obj.status) acc.finishReason = str(obj.status)
      if (obj.usage) acc.usage = mergeUsage(acc.usage, normalizeUsage(obj.usage))
    }
    // Gemini Native
    if (Array.isArray(obj.candidates)) {
      for (const cand of obj.candidates) {
        appendGeminiParts(cand?.content?.parts, acc)
        if (cand?.finishReason) acc.finishReason = str(cand.finishReason)
      }
      if (obj.usageMetadata) acc.usage = mergeUsage(acc.usage, normalizeUsage(obj.usageMetadata))
    }
  }
  return acc
}

/** 解析真实 HTTP 响应体（支持 SSE 流式分片、非流式 JSON 与纯文本）。 */
export function parseResponsePayload(rawText, { contentType = '' } = {}) {
  const text = str(rawText)
  if (!text.trim()) {
    return {
      format: 'empty',
      model: '',
      responseId: '',
      finishReason: '',
      doneMarker: false,
      eventCount: 0,
      text: '',
      thinking: '',
      toolCalls: [],
      usage: null,
      errorMessage: '',
    }
  }
  const ct = str(contentType).toLowerCase()
  const looksLikeSse = ct.includes('text/event-stream') || /^(?:event:|data:)/m.test(text)
  if (looksLikeSse) {
    const sse = parseSseResponse(text)
    if (sse.eventCount > 0 || sse.doneMarker) return sse
  }
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return parseJsonResponseObject(parsed)
    } catch {}
  }
  return {
    format: 'text',
    model: '',
    responseId: '',
    finishReason: '',
    doneMarker: false,
    eventCount: 0,
    text,
    thinking: '',
    toolCalls: [],
    usage: null,
    errorMessage: '',
  }
}

/** 格式化单条记录为人类可读的 Markdown 文本。 */
export function formatRecordAsMarkdown(record) {
  const p = record.parsed || {}
  const ctx = record.tavernContext || {}
  const lines = []
  lines.push(`# 真实请求记录 · ${p.model || '(未指定模型)'}`)
  lines.push('')
  lines.push(`- **时间**：${new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}`)
  lines.push(`- **端点**：\`${record.method} ${record.url}\``)
  lines.push(`- **协议**：\`${p.protocol || 'unknown'}\` · **状态**：\`${record.statusCode ?? record.state}\` · **耗时**：\`${record.durationMs ?? '-'} ms\``)
  if (ctx.gameId || ctx.scope) {
    lines.push(`- **酒馆上下文**：\`${ctx.scope || '-'}\` · 轮次 \`${ctx.turn || '-'}\` · 对局 \`${ctx.gameId || '-'}\``)
  }
  lines.push(`- **统计**：${p.stats?.messageCount ?? 0} 条消息 · ${p.stats?.totalChars ?? 0} 字符 · 约 ${p.stats?.estimatedTokens ?? 0} tokens · Wire ${record.wireBytes ?? 0} B`)
  lines.push('')
  if (p.params && Object.keys(p.params).length) {
    lines.push('## 模型参数')
    lines.push('```json')
    lines.push(JSON.stringify(p.params, null, 2))
    lines.push('```')
    lines.push('')
  }
  lines.push('## 消息内容')
  for (const msg of p.messages || []) {
    lines.push('')
    lines.push(`### #${msg.index} [${msg.role.toUpperCase()}] (${msg.charCount} 字符 / ~${msg.estimatedTokens} tokens)`)
    for (const part of msg.parts) {
      if (part.type === 'text') {
        lines.push('')
        lines.push(part.text)
      } else if (part.type === 'thinking') {
        lines.push('')
        lines.push(`> **[Thinking]**\n>\n${part.text.split('\n').map(l => '> ' + l).join('\n')}`)
      } else if (part.type === 'image') {
        lines.push('')
        lines.push(`> **[Image]** \`${part.mediaType}\` (${part.byteSize ? `${Math.round(part.byteSize / 1024)} KB` : 'URL'})`)
      } else if (part.type === 'tool_call') {
        lines.push('')
        lines.push(`**[Tool Call]** \`${part.name}\` (${part.id || 'no-id'})`)
        lines.push('```json')
        lines.push(part.argsText)
        lines.push('```')
      } else if (part.type === 'tool_result') {
        lines.push('')
        lines.push(`**[Tool Result]** \`${part.name || part.callId}\`${part.isError ? ' (ERROR)' : ''}`)
        lines.push('```text')
        lines.push(part.contentText)
        lines.push('```')
      }
    }
  }
  const resp = record.parsedResponse
  if (resp && resp.format !== 'empty') {
    lines.push('')
    lines.push('## 模型响应')
    if (resp.finishReason || resp.usage) {
      lines.push('')
      lines.push(`- **格式**：\`${resp.format}\` · **结束原因**：\`${resp.finishReason || '-'}\``)
      if (resp.usage) lines.push(`- **Token 用量**：\`${JSON.stringify(resp.usage)}\``)
    }
    if (resp.thinking) {
      lines.push('')
      lines.push('### 思考过程')
      lines.push(resp.thinking)
    }
    if (resp.text) {
      lines.push('')
      lines.push('### 正文输出')
      lines.push(resp.text)
    }
    for (const tc of resp.toolCalls || []) {
      lines.push('')
      lines.push(`### 工具调用 \`${tc.name}\``)
      lines.push('```json')
      lines.push(tc.argsText)
      lines.push('```')
    }
  }
  return lines.join('\n')
}

/** 格式化单条记录为脱敏后的 cURL 命令。 */
export function formatRecordAsCurl(record) {
  const parts = [`curl -X ${record.method || 'POST'} '${str(record.url).replace(/'/g, "'\\''")}'`]
  for (const h of record.headers || []) {
    const val = h.redacted ? `$${h.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` : h.value
    parts.push(`  -H '${h.name}: ${str(val).replace(/'/g, "'\\''")}'`)
  }
  const body = str(record.rawBodyText || '')
  if (body) {
    parts.push(`  --data-raw '${body.replace(/'/g, "'\\''")}'`)
  }
  return parts.join(' \\\n')
}
