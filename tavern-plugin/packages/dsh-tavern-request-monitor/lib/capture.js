import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import dc from 'node:diagnostics_channel'
import {
  getHeaderIgnoreCase,
  normalizeAndRedactHeaders,
  parseLlmPayload,
  redactUrl,
  str,
} from './parser.js'

const NON_LLM_PATH_RE = /^\/(?:api\/(?:tavern|remote|plugins|settings|auth|sessions)|rpc|assets|__)/i
const LLM_ENDPOINT_RE = /(?:\/chat\/completions|\/v\d+\/messages|\/responses|:(?:stream)?generateContent|\/api\/(?:chat|generate))(?:\?|$)/i
const MAX_ERROR_TEXT_CHARS = 16 * 1024
const CONTEXT_TTL_MS = 30 * 1000
const MAX_PENDING_CONTEXTS = 40

function isLikelyLlmJson(body, url, hasTavernCtx) {
  if (hasTavernCtx) return true
  if (LLM_ENDPOINT_RE.test(str(url))) return true
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  if (Array.isArray(body.messages)) return true
  if (Array.isArray(body.contents)) return true
  if (Array.isArray(body.input)) return true
  if (typeof body.prompt === 'string' && typeof body.model === 'string') return true
  return false
}

function isExcludedInternalPath(url) {
  try {
    const parsed = new URL(url)
    return NON_LLM_PATH_RE.test(parsed.pathname) && !LLM_ENDPOINT_RE.test(parsed.pathname)
  } catch {
    return false
  }
}

function modelNamesMatch(ctxModel, reqModel) {
  const a = str(ctxModel).trim().toLowerCase()
  const b = str(reqModel).trim().toLowerCase()
  if (!a || !b) return false
  if (a === b) return true
  const aShort = a.includes('/') ? a.split('/').pop() : a
  const bShort = b.includes('/') ? b.split('/').pop() : b
  return aShort === bShort || a.endsWith('/' + bShort) || b.endsWith('/' + aShort)
}

function extractUrlFromFetchArgs(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url
  return ''
}

function extractMethodFromFetchArgs(input, init) {
  const m = init?.method || (input && typeof input === 'object' ? input.method : '') || 'GET'
  return str(m).toUpperCase()
}

function toSummary(record) {
  const parsed = record.parsed || {}
  const stats = parsed.stats || {}
  const ctx = record.tavernContext || null
  return {
    id: record.id,
    seq: record.seq,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    state: record.state,
    transport: record.transport,
    attempt: record.attempt,
    method: record.method,
    url: record.url,
    statusCode: record.statusCode,
    ttfbMs: record.ttfbMs,
    durationMs: record.durationMs,
    wireBytes: record.wireBytes,
    rawTruncated: record.rawTruncated === true,
    error: record.error || '',
    protocol: parsed.protocol || 'generic-json',
    model: parsed.model || ctx?.model || '',
    stream: parsed.stream === true,
    stats: {
      messageCount: stats.messageCount || 0,
      toolCount: stats.toolCount || 0,
      toolCallCount: stats.toolCallCount || 0,
      imageCount: stats.imageCount || 0,
      totalChars: stats.totalChars || 0,
      estimatedTokens: stats.estimatedTokens || 0,
      wireUnicodeCount: stats.wireUnicodeCount || 0,
      compactCodepointBlocks: stats.compactCodepointBlocks || 0,
      sessionFingerprint: stats.sessionFingerprint || '',
    },
    tavernContext: ctx
      ? {
          gameId: ctx.gameId,
          chatId: ctx.chatId,
          mode: ctx.mode,
          scope: ctx.scope,
          turn: ctx.turn,
          purpose: ctx.purpose || '',
        }
      : null,
  }
}

/**
 * 创建真实外发请求捕获器：
 * 1) 订阅 Node undici diagnostics_channel，捕获经过所有上层改写（含 toolProtocolEnforcement 与 wireEscape）后的真实 HTTP Wire 请求；
 * 2) 协作轻量 fetch 包装读取 4xx/5xx 响应体与非 undici 测试 mock；
 * 3) 通过只读队列关联 Tavern requestRewriter 上下文（gameId / turn / scope）。
 */
export function createRequestMonitorEngine({
  getConfig = () => ({ enabled: true, filterMode: 'llm_only', maxRecords: 40, maxTotalBytes: 64 * 1024 * 1024, maxSingleBodyBytes: 8 * 1024 * 1024, captureWireBody: true }),
  fetchTarget = globalThis,
  enableUndici = true,
  enableFetchHook = true,
  onChange = () => {},
} = {}) {
  const records = new Map()
  const undiciMap = new WeakMap()
  const pendingContexts = []
  const traceAls = new AsyncLocalStorage()
  let seqCounter = 0
  let totalApproxBytes = 0
  let disposed = false

  function notify(event) {
    try {
      onChange(event)
    } catch {}
  }

  function pruneExpiredContexts(now) {
    while (pendingContexts.length > 0 && (now - pendingContexts[0].at > CONTEXT_TTL_MS || pendingContexts.length > MAX_PENDING_CONTEXTS)) {
      pendingContexts.shift()
    }
  }

  function recordRewriterContext(request, context = {}) {
    if (disposed) return
    const cfg = getConfig()
    if (!cfg.enabled) return
    const now = Date.now()
    pruneExpiredContexts(now)
    pendingContexts.push({
      id: randomUUID(),
      at: now,
      gameId: str(context.gameId),
      chatId: str(context.chatId),
      mode: str(context.mode),
      scope: str(context.scope),
      turn: Number(context.turn) || 0,
      purpose: str(context.purpose),
      userText: str(context.userText).slice(0, 400),
      provider: str(context.provider),
      model: str(context.model || request?.model),
      messageCount: Array.isArray(request?.messages) ? request.messages.length : 0,
      claimedByTraceId: '',
    })
  }

  function matchTavernContext(parsed, traceId) {
    const now = Date.now()
    pruneExpiredContexts(now)
    if (traceId) {
      const sameTrace = pendingContexts.find(c => c.claimedByTraceId === traceId)
      if (sameTrace) return sameTrace
    }
    const reqModel = str(parsed?.model)
    for (let i = pendingContexts.length - 1; i >= 0; i -= 1) {
      const candidate = pendingContexts[i]
      if (candidate.claimedByTraceId) continue
      if (reqModel && candidate.model && modelNamesMatch(candidate.model, reqModel)) {
        if (traceId) candidate.claimedByTraceId = traceId
        return candidate
      }
    }
    for (let i = pendingContexts.length - 1; i >= 0; i -= 1) {
      const candidate = pendingContexts[i]
      if (candidate.claimedByTraceId) continue
      if (now - candidate.at <= 5000) {
        if (traceId) candidate.claimedByTraceId = traceId
        return candidate
      }
    }
    return null
  }

  function enforceBudget() {
    const cfg = getConfig()
    const maxRecords = Math.max(1, Number(cfg.maxRecords) || 40)
    const maxTotalBytes = Math.max(1024 * 1024, Number(cfg.maxTotalBytes) || 64 * 1024 * 1024)
    while (records.size > maxRecords || (records.size > 1 && totalApproxBytes > maxTotalBytes)) {
      const oldestKey = records.keys().next().value
      if (!oldestKey) break
      const removed = records.get(oldestKey)
      records.delete(oldestKey)
      totalApproxBytes = Math.max(0, totalApproxBytes - (removed?.approxBytes || 0))
    }
  }

  function finalizeBodyRecord({
    id,
    createdAt,
    transport,
    method,
    rawUrl,
    rawHeaders,
    rawBodyText,
    traceStore,
    attempt,
  }) {
    const cfg = getConfig()
    if (disposed || !cfg.enabled) return null

    const safeUrl = redactUrl(rawUrl)
    if (isExcludedInternalPath(safeUrl)) return null

    const headers = normalizeAndRedactHeaders(rawHeaders)
    const contentType = getHeaderIgnoreCase(headers, 'content-type')
    const wireBytes = Buffer.byteLength(str(rawBodyText), 'utf8')

    let parsedBody = null
    if (rawBodyText && (contentType.includes('json') || rawBodyText.trimStart().startsWith('{'))) {
      try {
        parsedBody = JSON.parse(rawBodyText)
      } catch {
        parsedBody = null
      }
    }

    const tavernCtx = matchTavernContext(parsedBody, traceStore?.traceId || '')
    const hasTavernCtx = Boolean(tavernCtx)
    const isLlm = isLikelyLlmJson(parsedBody, safeUrl, hasTavernCtx)

    if (cfg.filterMode === 'llm_only' && !isLlm) {
      return null
    }
    if (cfg.filterMode === 'all_json_post' && !parsedBody) {
      return null
    }

    const parsed = parsedBody
      ? parseLlmPayload(parsedBody, { url: safeUrl, headersList: headers, rawText: rawBodyText })
      : {
          protocol: 'generic-json',
          model: '',
          stream: false,
          messages: [],
          tools: [],
          params: {},
          stats: {
            messageCount: 0,
            toolCount: 0,
            toolCallCount: 0,
            imageCount: 0,
            totalChars: str(rawBodyText).length,
            estimatedTokens: 0,
            wireUnicodeCount: 0,
            compactCodepointBlocks: 0,
            sessionFingerprint: '',
          },
        }

    const maxSingle = Math.max(64 * 1024, Number(cfg.maxSingleBodyBytes) || 8 * 1024 * 1024)
    let storedRaw = ''
    let rawTruncated = false
    if (cfg.captureWireBody) {
      if (wireBytes > maxSingle) {
        storedRaw = Buffer.from(str(rawBodyText), 'utf8').subarray(0, maxSingle).toString('utf8')
        rawTruncated = true
      } else {
        storedRaw = str(rawBodyText)
      }
    }

    const approxBytes = Buffer.byteLength(storedRaw, 'utf8') + Math.min(wireBytes, 2 * 1024 * 1024)
    const record = {
      id: id || randomUUID(),
      seq: ++seqCounter,
      createdAt: createdAt || Date.now(),
      updatedAt: Date.now(),
      state: 'pending',
      transport,
      attempt: attempt || 1,
      method: str(method || 'POST').toUpperCase(),
      url: safeUrl,
      headers,
      responseHeaders: [],
      statusCode: null,
      ttfbMs: null,
      durationMs: null,
      error: '',
      errorResponseText: '',
      wireBytes,
      rawTruncated,
      rawBodyText: storedRaw,
      parsed,
      tavernContext: tavernCtx
        ? {
            gameId: tavernCtx.gameId,
            chatId: tavernCtx.chatId,
            mode: tavernCtx.mode,
            scope: tavernCtx.scope,
            turn: tavernCtx.turn,
            purpose: tavernCtx.purpose,
            model: tavernCtx.model,
          }
        : null,
      approxBytes,
    }

    records.set(record.id, record)
    totalApproxBytes += approxBytes
    enforceBudget()
    if (traceStore) traceStore.lastRecordId = record.id
    notify({ type: 'created', record: toSummary(record) })
    return record
  }

  function updateRecord(id, patch) {
    const record = records.get(id)
    if (!record) return null
    Object.assign(record, patch, { updatedAt: Date.now() })
    notify({ type: 'updated', record: toSummary(record) })
    return record
  }

  // ===== 通道一：Node undici diagnostics_channel（真实发送的 Wire 字节流） =====
  const onUndiciCreate = ({ request }) => {
    try {
      if (disposed || !request) return
      const cfg = getConfig()
      if (!cfg.enabled) return
      const method = str(request.method).toUpperCase()
      if (method !== 'POST' && method !== 'PUT') return

      const origin = str(request.origin)
      const path = str(request.path)
      const fullUrl = path.startsWith('http://') || path.startsWith('https://') ? path : origin + path
      const traceStore = traceAls.getStore() || null
      if (traceStore) {
        traceStore.sawUndici = true
        traceStore.attempt = (traceStore.attempt || 0) + 1
      }
      const attempt = traceStore?.attempt || 1
      const createdAt = Date.now()
      const state = {
        id: randomUUID(),
        createdAt,
        method,
        fullUrl,
        headers: request.headers,
        traceStore,
        attempt,
        recordId: null,
        statusCode: null,
        responseHeaders: null,
        ttfbMs: null,
        durationMs: null,
        terminalState: null,
        terminalError: '',
      }
      undiciMap.set(request, state)

      const finishBody = text => {
        const created = finalizeBodyRecord({
          id: state.id,
          createdAt: state.createdAt,
          transport: 'http-wire',
          method: state.method,
          rawUrl: state.fullUrl,
          rawHeaders: state.headers,
          rawBodyText: text,
          traceStore: state.traceStore,
          attempt: state.attempt,
        })
        if (created) {
          state.recordId = created.id
          if (state.statusCode !== null || state.terminalState !== null) {
            updateRecord(created.id, {
              ...(state.statusCode !== null ? { statusCode: state.statusCode, responseHeaders: state.responseHeaders || [], ttfbMs: state.ttfbMs } : {}),
              ...(state.terminalState !== null ? { state: state.terminalState, durationMs: state.durationMs, error: state.terminalError } : {}),
            })
          }
        }
      }

      const body = request.body
      if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
        finishBody(Buffer.from(body).toString('utf8'))
        return
      }
      if (body && typeof body[Symbol.asyncIterator] === 'function') {
        const chunks = []
        let collectedBytes = 0
        const maxCapture = Math.max(64 * 1024, Number(cfg.maxSingleBodyBytes) || 8 * 1024 * 1024) + 256 * 1024
        let finalized = false
        const origIter = body[Symbol.asyncIterator].bind(body)
        body[Symbol.asyncIterator] = function wrappedWireBodyIterator() {
          const it = origIter()
          const origNext = it.next.bind(it)
          it.next = async function wrappedNext() {
            const res = await origNext()
            try {
              if (res && !res.done && res.value !== undefined && collectedBytes < maxCapture) {
                const buf = Buffer.isBuffer(res.value) ? Buffer.from(res.value) : Buffer.from(res.value)
                chunks.push(buf)
                collectedBytes += buf.length
              }
              if (res && res.done && !finalized) {
                finalized = true
                finishBody(Buffer.concat(chunks).toString('utf8'))
              }
            } catch {}
            return res
          }
          return it
        }
      }
    } catch {}
  }

  const onUndiciHeaders = ({ request, response }) => {
    try {
      const state = undiciMap.get(request)
      if (!state) return
      const now = Date.now()
      state.statusCode = Number(response?.statusCode) || null
      state.responseHeaders = normalizeAndRedactHeaders(response?.headers)
      state.ttfbMs = Math.max(0, now - state.createdAt)
      if (state.recordId) {
        updateRecord(state.recordId, {
          statusCode: state.statusCode,
          responseHeaders: state.responseHeaders,
          ttfbMs: state.ttfbMs,
        })
      }
    } catch {}
  }

  const onUndiciTrailers = ({ request }) => {
    try {
      const state = undiciMap.get(request)
      if (!state) return
      const durationMs = Math.max(0, Date.now() - state.createdAt)
      const isErr = (state.statusCode || 0) >= 400
      state.durationMs = durationMs
      state.terminalState = isErr ? 'error' : 'completed'
      if (!state.recordId) return
      updateRecord(state.recordId, {
        state: state.terminalState,
        durationMs,
      })
    } catch {}
  }

  const onUndiciError = ({ request, error }) => {
    try {
      const state = undiciMap.get(request)
      if (!state) return
      const durationMs = Math.max(0, Date.now() - state.createdAt)
      state.durationMs = durationMs
      state.terminalState = 'error'
      state.terminalError = str(error?.message || error || 'HTTP 请求失败')
      if (state.recordId) {
        updateRecord(state.recordId, {
          state: 'error',
          durationMs,
          error: state.terminalError,
        })
      }
    } catch {}
  }

  if (enableUndici) {
    dc.subscribe('undici:request:create', onUndiciCreate)
    dc.subscribe('undici:request:headers', onUndiciHeaders)
    dc.subscribe('undici:request:trailers', onUndiciTrailers)
    dc.subscribe('undici:request:error', onUndiciError)
  }

  // ===== 通道二：轻量 fetch 协作钩子（读取 4xx/5xx 报错文本 & 纯 mock fetch 兜底） =====
  let restoreFetch = () => {}
  if (enableFetchHook && fetchTarget && typeof fetchTarget.fetch === 'function') {
    const originalFetch = fetchTarget.fetch
    const monitoredFetch = async function monitoredFetch(input, init) {
      const cfg = getConfig()
      if (disposed || !cfg.enabled) {
        return originalFetch.call(this, input, init)
      }
      const method = extractMethodFromFetchArgs(input, init)
      if (method !== 'POST' && method !== 'PUT') {
        return originalFetch.call(this, input, init)
      }

      const traceStore = {
        traceId: randomUUID(),
        sawUndici: false,
        attempt: 0,
        lastRecordId: null,
      }
      const startedAt = Date.now()
      let fallbackRecord = null

      return traceAls.run(traceStore, async () => {
        let response
        try {
          response = await originalFetch.call(this, input, init)
        } catch (error) {
          if (traceStore.lastRecordId) {
            updateRecord(traceStore.lastRecordId, {
              state: 'error',
              durationMs: Math.max(0, Date.now() - startedAt),
              error: str(error?.message || error),
            })
          }
          throw error
        }

        // 若未触发 undici（例如单测 mock fetch 或定制传输层），在 fetch 层兜底记录
        const rawBodyFallback = typeof init?.body === 'string'
          ? init.body
          : (Buffer.isBuffer(init?.body) || init?.body instanceof Uint8Array)
            ? Buffer.from(init.body).toString('utf8')
            : ''
        if (!traceStore.sawUndici && rawBodyFallback) {
          fallbackRecord = finalizeBodyRecord({
            createdAt: startedAt,
            transport: 'fetch-fallback',
            method,
            rawUrl: extractUrlFromFetchArgs(input),
            rawHeaders: init?.headers || (input && typeof input === 'object' ? input.headers : undefined),
            rawBodyText: rawBodyFallback,
            traceStore,
            attempt: 1,
          })
          if (fallbackRecord) {
            updateRecord(fallbackRecord.id, {
              statusCode: response?.status ?? null,
              responseHeaders: normalizeAndRedactHeaders(response?.headers),
              ttfbMs: Math.max(0, Date.now() - startedAt),
              durationMs: Math.max(0, Date.now() - startedAt),
              state: (response?.status || 0) >= 400 ? 'error' : 'completed',
            })
          }
        }

        // 仅在 HTTP 错误状态时安全 clone 读取错误正文，绝不触碰 200 SSE 流
        const targetId = traceStore.lastRecordId || fallbackRecord?.id
        if (targetId && response && response.status >= 400 && typeof response.clone === 'function') {
          try {
            const errText = await response.clone().text()
            if (errText) {
              updateRecord(targetId, {
                statusCode: response.status,
                state: 'error',
                errorResponseText: errText.slice(0, MAX_ERROR_TEXT_CHARS),
              })
            }
          } catch {}
        }
        return response
      })
    }

    fetchTarget.fetch = monitoredFetch
    restoreFetch = () => {
      if (fetchTarget.fetch === monitoredFetch) {
        fetchTarget.fetch = originalFetch
      }
    }
  }

  return Object.freeze({
    recordRewriterContext,
    listSummaries({ gameId = '', scope = '', onlyErrors = false, query = '' } = {}) {
      const g = str(gameId).trim()
      const s = str(scope).trim()
      const q = str(query).trim().toLowerCase()
      const out = []
      for (const rec of records.values()) {
        if (g && rec.tavernContext?.gameId !== g) continue
        if (s && rec.tavernContext?.scope !== s) continue
        if (onlyErrors && rec.state !== 'error' && (rec.statusCode || 0) < 400) continue
        if (q) {
          const haystack = `${rec.url} ${rec.parsed?.model || ''} ${rec.tavernContext?.scope || ''} ${rec.error || ''}`.toLowerCase()
          if (!haystack.includes(q)) continue
        }
        out.push(toSummary(rec))
      }
      return out.reverse()
    },
    getDetail(id) {
      const rec = records.get(str(id))
      if (!rec) return null
      return structuredClone(rec)
    },
    clear({ gameId = '' } = {}) {
      const g = str(gameId).trim()
      if (!g) {
        const count = records.size
        records.clear()
        totalApproxBytes = 0
        notify({ type: 'cleared', gameId: '' })
        return { removed: count }
      }
      let removed = 0
      for (const [id, rec] of Array.from(records.entries())) {
        if (rec.tavernContext?.gameId === g) {
          records.delete(id)
          totalApproxBytes = Math.max(0, totalApproxBytes - (rec.approxBytes || 0))
          removed += 1
        }
      }
      notify({ type: 'cleared', gameId: g })
      return { removed }
    },
    stats() {
      let errorCount = 0
      let pendingCount = 0
      for (const rec of records.values()) {
        if (rec.state === 'error' || (rec.statusCode || 0) >= 400) errorCount += 1
        else if (rec.state === 'pending') pendingCount += 1
      }
      return {
        totalRecords: records.size,
        totalApproxBytes,
        errorCount,
        pendingCount,
        latest: records.size ? toSummary(Array.from(records.values()).pop()) : null,
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (enableUndici) {
        try { dc.unsubscribe('undici:request:create', onUndiciCreate) } catch {}
        try { dc.unsubscribe('undici:request:headers', onUndiciHeaders) } catch {}
        try { dc.unsubscribe('undici:request:trailers', onUndiciTrailers) } catch {}
        try { dc.unsubscribe('undici:request:error', onUndiciError) } catch {}
      }
      restoreFetch()
      records.clear()
      pendingContexts.length = 0
      totalApproxBytes = 0
    },
  })
}
