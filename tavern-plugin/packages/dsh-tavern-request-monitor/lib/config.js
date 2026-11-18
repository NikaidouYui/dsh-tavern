export const PLUGIN_ID = 'dsh-tavern-request-monitor'

export const FILTER_MODES = ['llm_only', 'all_json_post']
export const MAX_RECORD_CHOICES = [20, 40, 80, 120]

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  filterMode: 'llm_only',
  maxRecords: 40,
  maxTotalBytes: 64 * 1024 * 1024,
  maxSingleBodyBytes: 8 * 1024 * 1024,
  captureWireBody: true,
  decodeCodepointsPreview: true,
})

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** 归一化插件全局配置。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: src.enabled !== false,
    filterMode: pickEnum(src.filterMode, FILTER_MODES, DEFAULT_CONFIG.filterMode),
    maxRecords: clampInt(src.maxRecords, 5, 200, DEFAULT_CONFIG.maxRecords),
    maxTotalBytes: clampInt(src.maxTotalBytes, 4 * 1024 * 1024, 256 * 1024 * 1024, DEFAULT_CONFIG.maxTotalBytes),
    maxSingleBodyBytes: clampInt(src.maxSingleBodyBytes, 256 * 1024, 32 * 1024 * 1024, DEFAULT_CONFIG.maxSingleBodyBytes),
    captureWireBody: src.captureWireBody !== false,
    decodeCodepointsPreview: src.decodeCodepointsPreview !== false,
  }
}
