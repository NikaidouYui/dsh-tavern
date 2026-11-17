import { mergeWireEscapeMode, normalizeWireEscapeMode } from './wire-unicode-escape.js'

const DEFAULT_TIMEOUT_MS = 30000

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function cloneRequestForPlugin(request) {
  if (!request || typeof request !== 'object') return request
  const { signal, ...rest } = request
  const cloned = structuredClone(rest)
  if (signal !== undefined) cloned.signal = signal
  return cloned
}

function runBounded(promise, label, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer
    const finish = (cb, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      cb(value)
    }
    const onAbort = () => finish(reject, signal.reason ?? Object.assign(new Error(label + '已取消'), { name: 'AbortError' }))
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(reject, new Error(label + '超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒）')), timeoutMs)
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error))
  })
}

/**
 * 插件请求改写管道：在请求已投影完成、尚未写入请求日志和发往底层模型前，
 * 允许插件无副作用地投影请求体（如输入转义、防路由清洗），而不修改存档原文。
 */
export function createRequestRewriters({
  allowed = async () => true,
  recordError = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const entries = new Map()
  let disposed = false

  function register(owner, { rewrite } = {}) {
    if (disposed) throw new Error('请求改写宿主已释放')
    if (!owner) throw new Error('请求改写需要插件名')
    if (typeof rewrite !== 'function') throw new TypeError('requestRewriter 需要 rewrite(request, context) 函数')
    if (entries.has(owner)) throw new Error('插件 ' + owner + ' 已经注册过请求改写器')
    const entry = { owner, rewrite }
    entries.set(owner, entry)
    return () => { if (entries.get(owner) === entry) entries.delete(owner) }
  }

  async function apply(request, context = {}) {
    if (disposed || !entries.size || !request || typeof request !== 'object') {
      return { changed: false, request, wireEscape: false }
    }
    const ordered = Array.from(entries.values()).sort((a, b) => a.owner.localeCompare(b.owner))
    let current = request
    let changed = false
    let wireEscape = false
    const gameId = str(context.gameId)

    for (const entry of ordered) {
      if (context.signal?.aborted) break
      if (entries.get(entry.owner) !== entry) continue
      let permitted = false
      try {
        permitted = gameId ? Boolean(await allowed(entry.owner, gameId)) : true
      } catch {
        permitted = false
      }
      if (!permitted || entries.get(entry.owner) !== entry) continue

      try {
        const snapshotRequest = cloneRequestForPlugin(current)
        const snapshotContext = Object.freeze({
          gameId,
          chatId: str(context.chatId),
          mode: str(context.mode),
          scope: str(context.scope),
          turn: Number(context.turn) || 0,
          purpose: context.purpose,
          userText: str(context.userText),
          provider: str(context.provider),
          model: str(context.model),
          signal: context.signal,
        })
        const result = await runBounded(
          Promise.resolve().then(() => entry.rewrite(snapshotRequest, snapshotContext)),
          '请求改写插件 ' + entry.owner,
          context.signal,
          timeoutMs,
        )
        if (entries.get(entry.owner) !== entry || result === null || result === undefined) continue
        if (typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('requestRewriter 必须返回对象、null 或 undefined')
        }
        const hasEnvelope = Object.hasOwn(result, 'request') || Object.hasOwn(result, 'wireEscape')
        const nextReq = hasEnvelope ? result.request : result
        const nextEscape = hasEnvelope ? normalizeWireEscapeMode(result.wireEscape) : false
        if (nextReq !== undefined && nextReq !== null) {
          if (typeof nextReq !== 'object' || Array.isArray(nextReq) || !Array.isArray(nextReq.messages)) {
            throw new Error('requestRewriter 返回的请求必须包含 messages 数组')
          }
          // 保留顶层 signal 与原始请求中未被显式覆盖的传输字段
          const merged = { ...current, ...nextReq }
          if (request.signal !== undefined && merged.signal === undefined) merged.signal = request.signal
          current = merged
          changed = true
        }
        if (nextEscape) {
          wireEscape = mergeWireEscapeMode(wireEscape, nextEscape)
          changed = true
        }
      } catch (error) {
        if (context.signal?.aborted || error?.name === 'AbortError') break
        try {
          recordError(gameId, entry.owner, 'requestRewriter', error)
        } catch {}
      }
    }

    return { changed, request: current, wireEscape }
  }

  return Object.freeze({
    register,
    get active() { return entries.size > 0 },
    apply,
    dispose() {
      disposed = true
      entries.clear()
    },
  })
}
