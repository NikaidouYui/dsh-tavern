import { AsyncLocalStorage } from 'node:async_hooks'

export const WIRE_ESCAPE_OPEN = '\uE01E'
export const WIRE_ESCAPE_CLOSE = '\uE01F'

const WIRE_ESCAPE_MODE = Symbol.for('dsh-tavern.wire-escape')
const wireEscapeStorage = new AsyncLocalStorage()

const MARKED_SPAN_RE = /(?:\uE01E|\\u[eE]01[eE])([\s\S]*?)(?:\uE01F|\\u[eE]01[fF])/g
const STRAY_MARKER_RE = /(?:\uE01E|\uE01F|\\u[eE]01[eEfF])/g

function escapeNonAsciiUnits(text) {
  return String(text).replace(/[^\x00-\x7F]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** 用内部不可见标记包裹需要做 JSON Wire `\uXXXX` 转义的片段。 */
export function markTextForWireEscape(value) {
  const source = String(value ?? '')
  if (!source || !/[^\x00-\x7F]/.test(source)) return source
  if (source.includes(WIRE_ESCAPE_OPEN)) return source
  return WIRE_ESCAPE_OPEN + source + WIRE_ESCAPE_CLOSE
}

/** 归一化 wireEscape 模式：false | 'marked' | 'full'。 */
export function normalizeWireEscapeMode(mode) {
  if (mode === true || mode === 'full') return 'full'
  if (mode === 'marked') return 'marked'
  return false
}

/** 合并多个插件请求的 wireEscape 强度（full > marked > false）。 */
export function mergeWireEscapeMode(left, right) {
  const a = normalizeWireEscapeMode(left)
  const b = normalizeWireEscapeMode(right)
  if (a === 'full' || b === 'full') return 'full'
  if (a === 'marked' || b === 'marked') return 'marked'
  return false
}

/**
 * 在已序列化的 JSON 字符串发送前执行标准单斜杠 `\uXXXX` 转义。
 * JSON 结构键与 ASCII 符号不受影响，上游 `JSON.parse()` 会 100% 无损还原。
 */
export function encodeJsonWireUnicode(rawJson, mode = 'full') {
  const normalized = normalizeWireEscapeMode(mode)
  const source = typeof rawJson === 'string' ? rawJson : ''
  if (!source || !normalized) return source
  let out = source.replace(MARKED_SPAN_RE, (_, inner) => escapeNonAsciiUnits(inner))
  out = out.replace(STRAY_MARKER_RE, '')
  if (normalized === 'full') {
    out = escapeNonAsciiUnits(out)
  }
  return out
}

/** 将 wireEscape 模式绑定到请求对象副本（不可枚举 Symbol，不进入 JSON）。 */
export function attachWireEscape(request, mode) {
  const normalized = normalizeWireEscapeMode(mode)
  if (!request || typeof request !== 'object' || !normalized) return request
  return { ...request, [WIRE_ESCAPE_MODE]: normalized }
}

/** 读取请求对象上附带的 wireEscape 模式。 */
export function wireEscapeModeOf(request) {
  return request && typeof request === 'object' ? normalizeWireEscapeMode(request[WIRE_ESCAPE_MODE]) : false
}

/** 在当前异步调用链中激活 wireEscape，使底层的 fetch 拦截器仅作用于本次模型请求。 */
export function runWithWireEscape(mode, fn) {
  const normalized = normalizeWireEscapeMode(mode)
  if (!normalized) return fn()
  return wireEscapeStorage.run(normalized, fn)
}

/** 获取当前 AsyncLocalStorage 作用域内的 wireEscape 模式。 */
export function currentWireEscape() {
  return normalizeWireEscapeMode(wireEscapeStorage.getStore())
}
