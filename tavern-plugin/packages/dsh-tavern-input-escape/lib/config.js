export const INPUT_MODES = Object.freeze(['json_escape', 'compact', 'hybrid_image', 'full_armor'])
export const WIRE_SCOPES = Object.freeze(['full', 'input_only'])
export const SCOPE_MODES = Object.freeze(['story_only', 'story_and_background'])
export const THINKING_MODES = Object.freeze(['passthrough', 'auto_low', 'low', 'medium', 'high', 'xhigh'])
export const GAME_OVERRIDE_MODES = Object.freeze(['inherit', 'enabled', 'disabled'])

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  enabled: true,
  scopeMode: 'story_only',
  inputEscapeEnabled: true,
  inputMode: 'json_escape',
  wireEscapeScope: 'full',
  antiRouteEnabled: true,
  dynamicSessionId: true,
  classifierSanitize: true,
  demoteSystem: true,
  normalizePreHistory: true,
  thinkingMode: 'passthrough',
  dilutionPaddingEnabled: false,
})

function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 归一化全局默认配置。 */
export function normalizeGlobalConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    version: 1,
    enabled: pickBool(src.enabled, DEFAULT_CONFIG.enabled),
    scopeMode: pickEnum(src.scopeMode, SCOPE_MODES, DEFAULT_CONFIG.scopeMode),
    inputEscapeEnabled: pickBool(src.inputEscapeEnabled, DEFAULT_CONFIG.inputEscapeEnabled),
    inputMode: pickEnum(src.inputMode, INPUT_MODES, DEFAULT_CONFIG.inputMode),
    wireEscapeScope: pickEnum(src.wireEscapeScope, WIRE_SCOPES, DEFAULT_CONFIG.wireEscapeScope),
    antiRouteEnabled: pickBool(src.antiRouteEnabled, DEFAULT_CONFIG.antiRouteEnabled),
    dynamicSessionId: pickBool(src.dynamicSessionId, DEFAULT_CONFIG.dynamicSessionId),
    classifierSanitize: pickBool(src.classifierSanitize, DEFAULT_CONFIG.classifierSanitize),
    demoteSystem: pickBool(src.demoteSystem, DEFAULT_CONFIG.demoteSystem),
    normalizePreHistory: pickBool(src.normalizePreHistory, DEFAULT_CONFIG.normalizePreHistory),
    thinkingMode: pickEnum(src.thinkingMode, THINKING_MODES, DEFAULT_CONFIG.thinkingMode),
    dilutionPaddingEnabled: pickBool(src.dilutionPaddingEnabled, DEFAULT_CONFIG.dilutionPaddingEnabled),
  }
}

/** 归一化单局覆盖配置（仅覆盖玩家显式选择的字段）。 */
export function normalizeGameOverride(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const override = pickEnum(src.override, GAME_OVERRIDE_MODES, 'inherit')
  const result = { override }
  if (typeof src.inputMode === 'string' && INPUT_MODES.includes(src.inputMode)) {
    result.inputMode = src.inputMode
  }
  if (typeof src.inputEscapeEnabled === 'boolean') {
    result.inputEscapeEnabled = src.inputEscapeEnabled
  }
  if (typeof src.antiRouteEnabled === 'boolean') {
    result.antiRouteEnabled = src.antiRouteEnabled
  }
  return result
}

/** 合并全局配置与本局覆盖，得出当前回合实际生效的配置。 */
export function resolveEffectiveConfig(globalRaw, gameRaw) {
  const globalCfg = normalizeGlobalConfig(globalRaw)
  const gameCfg = normalizeGameOverride(gameRaw)
  const effectiveEnabled = gameCfg.override === 'enabled'
    ? true
    : gameCfg.override === 'disabled'
      ? false
      : globalCfg.enabled
  return {
    ...globalCfg,
    enabled: effectiveEnabled,
    inputMode: gameCfg.inputMode ?? globalCfg.inputMode,
    inputEscapeEnabled: gameCfg.inputEscapeEnabled ?? globalCfg.inputEscapeEnabled,
    antiRouteEnabled: gameCfg.antiRouteEnabled ?? globalCfg.antiRouteEnabled,
    gameOverride: gameCfg.override,
  }
}

/** 声明给 Tavern「本局设置」的字段定义。 */
export const GAME_SETTINGS_SCHEMA = Object.freeze({
  title: '输入转义与防路由',
  fields: [
    {
      key: 'override',
      type: 'select',
      label: '本局启用状态',
      description: '跟随全局开关，或在当前对话单独强制开启/关闭输入转义与防路由。',
      default: 'inherit',
      options: [
        { value: 'inherit', label: '跟随全局设置' },
        { value: 'enabled', label: '本局强制开启' },
        { value: 'disabled', label: '本局暂停使用' },
      ],
    },
    {
      key: 'inputMode',
      type: 'select',
      label: '本局输入转义模式',
      description: '仅在当前对话覆盖输入转义模式；选 inherit 跟随插件面板全局配置。',
      default: 'inherit',
      options: [
        { value: 'inherit', label: '跟随全局模式' },
        { value: 'json_escape', label: '一 · JSON \\uXXXX 整包转义' },
        { value: 'compact', label: '二 · 紧凑码点转义 ⟦U:...⟧' },
        { value: 'hybrid_image', label: '三 · 输入转图片（PNG）' },
        { value: 'full_armor', label: '四 · 全上下文高危词破盾' },
      ],
    },
  ],
})
