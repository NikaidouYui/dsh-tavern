// 将宿主 LLM 适配器的默认流式空闲超时从 5 分钟（300000ms）放宽到 10 分钟（600000ms），
// 避免长思考或慢响应模型在尚未输出正文分片时提前触发 idle timeout。
export const LEGACY_STREAM_IDLE_TIMEOUT_MS = 300_000
export const RELAXED_STREAM_IDLE_TIMEOUT_MS = 600_000

const DEFAULT_TIMEOUT_PATTERN = /(const\s+DEFAULT_STREAM_IDLE_TIMEOUT_MS\s*=\s*)(3e5|300000|300_000|6e5|600000|600_000)(\s*;?)/g
const FALLBACK_TARGETS = new Set(['source', 'config'])
const RELAXED_LITERAL = '6e5'

function isRelaxedLiteral(literal) {
  return literal === '6e5' || literal === '600000' || literal === '600_000'
}

function replaceSingleAnchor(text, pattern) {
  const matches = [...text.matchAll(pattern)]
  if (matches.length !== 1) return { status: 'unmatched', text }
  const [match] = matches
  if (isRelaxedLiteral(match[2])) return { status: 'patched', text }
  const updated = text.slice(0, match.index) + match[1] + RELAXED_LITERAL + match[3] + text.slice(match.index + match[0].length)
  return { status: 'applied', text: updated }
}

/** 改写指定宿主适配器的默认流式空闲超时常量与回退值。 */
export function patchStreamIdleTimeoutSource(source, fallbackTarget) {
  if (!FALLBACK_TARGETS.has(fallbackTarget)) {
    throw new TypeError(`未知的流式超时回退对象：${String(fallbackTarget)}`)
  }
  const text = String(source)
  const fallbackPattern = new RegExp(
    `(const\\s+streamIdleTimeoutMs\\s*=\\s*${fallbackTarget}\\.streamIdleTimeoutMs\\s*\\?\\?\\s*)(3e5|300000|300_000|6e5|600000|600_000)(\\s*;?)`,
    'g'
  )
  const first = replaceSingleAnchor(text, DEFAULT_TIMEOUT_PATTERN)
  if (first.status === 'unmatched') return { status: 'unmatched', text }
  const second = replaceSingleAnchor(first.text, fallbackPattern)
  if (second.status === 'unmatched') return { status: 'unmatched', text }
  const changed = first.status === 'applied' || second.status === 'applied'
  return { status: changed ? 'applied' : 'patched', text: second.text }
}

export function patchPiAiStreamTimeoutSource(source) {
  return patchStreamIdleTimeoutSource(source, 'source')
}

export function patchDeepSeekStreamTimeoutSource(source) {
  return patchStreamIdleTimeoutSource(source, 'config')
}
