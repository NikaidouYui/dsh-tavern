import { createHash, randomUUID } from 'node:crypto'
import {
  DEFAULT_CONFIG,
  GAME_SETTINGS_SCHEMA,
  normalizeGameOverride,
  normalizeGlobalConfig,
  resolveEffectiveConfig,
} from './config.js'
import { applyAntiRouteToRequest } from './anti-route.js'
import { applyInputEscapeToRequest } from './input-escape.js'

export const name = 'dsh-tavern-input-escape'
export const inject = ['tavern']
export const PLUGIN_VERSION = '1.0.0'

const MAX_IMAGE_CACHE = 32
const IMAGE_RENDER_TIMEOUT_MS = 4000
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg'])

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function hashText(text) {
  return createHash('sha256').update(String(text || '')).digest('hex')
}

export function apply(ctx, options = {}) {
  const tavern = ctx?.tavern
  if (!tavern || typeof tavern !== 'object') return

  const disposers = []
  const keep = fn => {
    if (typeof fn === 'function') disposers.push(fn)
    return fn
  }

  let globalConfigCache = null
  const gameOverrideCache = new Map()
  const telemetryByGame = new Map()
  const imageCache = new Map()
  const pendingRenders = new Map()

  function getAttachmentsService() {
    if (options.attachments) return options.attachments
    try { return ctx.get?.('attachments') || null } catch { return null }
  }

  function rememberCachedImages(cacheKey, attachments) {
    if (imageCache.has(cacheKey)) imageCache.delete(cacheKey)
    imageCache.set(cacheKey, { attachments, createdAt: Date.now() })
    while (imageCache.size > MAX_IMAGE_CACHE) {
      const oldest = imageCache.keys().next().value
      if (oldest === undefined) break
      imageCache.delete(oldest)
    }
  }

  async function readGlobalConfig() {
    if (globalConfigCache) return globalConfigCache
    let raw = null
    try {
      if (typeof tavern.readPluginData === 'function') raw = await tavern.readPluginData()
    } catch { raw = null }
    const payload = raw && typeof raw === 'object' && raw.data !== undefined ? raw.data : raw
    globalConfigCache = normalizeGlobalConfig(payload)
    return globalConfigCache
  }

  async function saveGlobalConfig(patch = {}) {
    const prev = await readGlobalConfig()
    const next = normalizeGlobalConfig({ ...prev, ...patch })
    globalConfigCache = next
    try {
      if (typeof tavern.savePluginData === 'function') {
        await tavern.savePluginData({ data: next })
      }
    } catch {}
    return next
  }

  async function readGameOverride(gameId) {
    const id = str(gameId)
    if (!id) return normalizeGameOverride(null)
    let saved = gameOverrideCache.get(id)
    if (!saved) {
      let raw = null
      try {
        if (typeof tavern.readGameData === 'function') raw = await tavern.readGameData({ gameId: id })
      } catch { raw = null }
      const payload = raw && typeof raw === 'object' && raw.data !== undefined ? raw.data : raw
      saved = normalizeGameOverride(payload)
      gameOverrideCache.set(id, saved)
    }
    // 本局设置面板的值若非 inherit，优先生效并与插件覆盖合并
    let nativeSettings = null
    try {
      if (typeof tavern.getGameSettings === 'function') nativeSettings = await tavern.getGameSettings({ gameId: id })
    } catch { nativeSettings = null }
    const merged = { ...saved }
    if (nativeSettings && typeof nativeSettings === 'object') {
      if (nativeSettings.override && nativeSettings.override !== 'inherit') {
        merged.override = nativeSettings.override
      }
      if (nativeSettings.inputMode && nativeSettings.inputMode !== 'inherit') {
        merged.inputMode = nativeSettings.inputMode
      }
    }
    return normalizeGameOverride(merged)
  }

  async function saveGameOverride(gameId, patch = {}) {
    const id = str(gameId)
    if (!id) throw new Error('缺少 gameId')
    const prev = gameOverrideCache.get(id) || normalizeGameOverride(null)
    const next = normalizeGameOverride({ ...prev, ...patch })
    gameOverrideCache.set(id, next)
    try {
      if (typeof tavern.saveGameData === 'function') {
        await tavern.saveGameData({ gameId: id, data: next })
      }
    } catch {}
    await publishUiSnapshot(id).catch(() => {})
    return next
  }

  async function buildStateSnapshot(gameId) {
    const globalCfg = await readGlobalConfig()
    const id = str(gameId)
    const gameOverride = id ? await readGameOverride(id) : normalizeGameOverride(null)
    const effective = resolveEffectiveConfig(globalCfg, gameOverride)
    return {
      version: PLUGIN_VERSION,
      supported: Boolean(tavern.capabilities?.requestRewriter >= 1),
      globalConfig: globalCfg,
      gameOverride,
      effective,
      telemetry: id ? (telemetryByGame.get(id) || null) : null,
    }
  }

  async function publishUiSnapshot(gameId) {
    const id = str(gameId)
    if (!id || typeof tavern.publishState !== 'function') return
    const snapshot = await buildStateSnapshot(id)
    await tavern.publishState({ gameId: id, name: 'status', data: snapshot })
  }

  /** 请求浏览器端 Canvas 渲染文本为分页图片并保存为 DSH 附件。 */
  async function renderInputToImages({ gameId, text, signal }) {
    const cacheKey = hashText(text)
    const cached = imageCache.get(cacheKey)
    if (cached?.attachments?.length) {
      return { attachments: cached.attachments, cached: true }
    }
    const attachmentsSvc = getAttachmentsService()
    if (!attachmentsSvc || typeof attachmentsSvc.saveImage !== 'function') {
      return { attachments: [], reason: 'attachments-service-unavailable' }
    }
    if (!gameId || typeof tavern.publishState !== 'function') {
      return { attachments: [], reason: 'publish-state-unavailable' }
    }
    if (signal?.aborted) {
      return { attachments: [], reason: 'aborted' }
    }

    const requestId = randomUUID()
    const renderPromise = new Promise(resolve => {
      const entry = {
        gameId,
        cacheKey,
        totalPages: 0,
        pages: new Map(),
        settled: false,
        timer: null,
        finish(result) {
          if (entry.settled) return
          entry.settled = true
          clearTimeout(entry.timer)
          signal?.removeEventListener('abort', onAbort)
          pendingRenders.delete(requestId)
          void tavern.publishState({ gameId, name: 'render-request', data: null }).catch(() => {})
          resolve(result)
        },
      }
      const onAbort = () => entry.finish({ attachments: [], reason: 'aborted' })
      signal?.addEventListener('abort', onAbort, { once: true })
      entry.timer = setTimeout(() => entry.finish({ attachments: [], reason: 'client-render-timeout' }), IMAGE_RENDER_TIMEOUT_MS)
      entry.timer.unref?.()
      pendingRenders.set(requestId, entry)
      void tavern.publishState({
        gameId,
        name: 'render-request',
        data: { requestId, text: String(text).slice(0, 64000) },
      }).catch(err => {
        entry.finish({ attachments: [], reason: String(err?.message || err).slice(0, 100) })
      })
    })
    return renderPromise
  }

  // 注册本局设置项
  if (typeof tavern.gameSettings === 'function') {
    keep(tavern.gameSettings(GAME_SETTINGS_SCHEMA))
  }
  if (typeof tavern.onGameSettingsChanged === 'function') {
    keep(tavern.onGameSettingsChanged(({ gameId }) => {
      void publishUiSnapshot(gameId).catch(() => {})
    }))
  }

  // 注册请求改写器（需宿主 capabilities.requestRewriter >= 1）
  if (typeof tavern.requestRewriter === 'function') {
    keep(tavern.requestRewriter({
      async rewrite(request, context) {
        const gameId = str(context?.gameId)
        const globalCfg = await readGlobalConfig()
        const gameOverride = gameId ? await readGameOverride(gameId) : normalizeGameOverride(null)
        const effective = resolveEffectiveConfig(globalCfg, gameOverride)

        if (!effective.enabled) return null

        const scope = str(context?.scope || 'story')
        const isStory = scope === 'story'
        if (!isStory && effective.scopeMode !== 'story_and_background') {
          return null
        }

        // 非游玩正文请求（后台结算/压缩/工作台）仅做安全轻量防路由，不破坏结构化 JSON 与工具调用
        const activeSettings = isStory
          ? effective
          : {
              ...effective,
              inputEscapeEnabled: false,
              demoteSystem: false,
              normalizePreHistory: false,
              dilutionPaddingEnabled: false,
            }

        const antiRouteResult = applyAntiRouteToRequest(request, {
          scope,
          settings: activeSettings,
        })

        const inputResult = isStory
          ? await applyInputEscapeToRequest(antiRouteResult.request, {
              userText: str(context?.userText),
              settings: activeSettings,
              renderInputToImages: text => renderInputToImages({
                gameId,
                text,
                signal: context?.signal,
              }),
            })
          : { request: antiRouteResult.request, wireEscape: false, stats: { mode: 'off', occurrences: 0, imagePages: 0, fullArmorHits: 0, fallbackReason: '' } }

        const telemetry = {
          at: Date.now(),
          turn: Number(context?.turn) || 0,
          scope,
          model: str(context?.model || request?.model),
          inputMode: inputResult.stats.mode,
          wireEscape: inputResult.wireEscape || false,
          inputMethod: inputResult.stats.method,
          inputMatches: inputResult.stats.occurrences,
          imagePages: inputResult.stats.imagePages,
          fullArmorHits: inputResult.stats.fullArmorHits,
          fallbackReason: inputResult.stats.fallbackReason,
          antiRoute: antiRouteResult.stats,
        }
        if (gameId) {
          telemetryByGame.set(gameId, telemetry)
          void publishUiSnapshot(gameId).catch(() => {})
        }

        return {
          request: inputResult.request,
          wireEscape: inputResult.wireEscape,
        }
      },
    }))
  }

  // 注册浏览器端通信接口
  if (typeof tavern.handle === 'function') {
    keep(tavern.handle(`${name}/get-state`, async ({ gameId } = {}) => {
      return await buildStateSnapshot(gameId)
    }))

    keep(tavern.handle(`${name}/save-global-config`, async ({ gameId, patch } = {}) => {
      const saved = await saveGlobalConfig(patch)
      if (gameId) await publishUiSnapshot(gameId).catch(() => {})
      return { globalConfig: saved, ...(gameId ? await buildStateSnapshot(gameId) : {}) }
    }))

    keep(tavern.handle(`${name}/save-game-override`, async ({ gameId, patch } = {}) => {
      const id = str(gameId)
      if (!id) throw new Error('保存本局设置需要 gameId')
      await saveGameOverride(id, patch)
      return await buildStateSnapshot(id)
    }))

    keep(tavern.handle(`${name}/upload-image-page`, async ({ requestId, pageIndex, totalPages, mediaType, base64 } = {}) => {
      const entry = pendingRenders.get(str(requestId))
      if (!entry || entry.settled) return { accepted: false }
      const total = Number(totalPages)
      const idx = Number(pageIndex)
      if (!Number.isSafeInteger(total) || total < 1 || total > 60 || !Number.isSafeInteger(idx) || idx < 0 || idx >= total) {
        return { accepted: false, error: '无效分页索引' }
      }
      const mime = ALLOWED_IMAGE_TYPES.has(mediaType) ? mediaType : 'image/png'
      const rawBytes = Buffer.from(str(base64), 'base64')
      if (!rawBytes.length) return { accepted: false, error: '空图片数据' }
      const attachmentsSvc = getAttachmentsService()
      if (!attachmentsSvc || typeof attachmentsSvc.saveImage !== 'function') {
        entry.finish({ attachments: [], reason: 'attachments-service-unavailable' })
        return { accepted: false }
      }
      const ext = mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : 'png'
      const ref = await attachmentsSvc.saveImage({
        data: new Uint8Array(rawBytes),
        mediaType: mime,
        name: `escaped-input-${idx + 1}.${ext}`,
      })
      entry.totalPages = total
      entry.pages.set(idx, ref)
      if (entry.pages.size >= total) {
        const ordered = []
        for (let i = 0; i < total; i += 1) {
          if (entry.pages.has(i)) ordered.push(entry.pages.get(i))
        }
        if (ordered.length === total) {
          rememberCachedImages(entry.cacheKey, ordered)
          entry.finish({ attachments: ordered, cached: false })
        }
      }
      return { accepted: true, received: entry.pages.size, total }
    }))
  }

  if (typeof tavern.onGameRemoved === 'function') {
    keep(tavern.onGameRemoved(({ gameId }) => {
      const id = str(gameId)
      gameOverrideCache.delete(id)
      telemetryByGame.delete(id)
    }))
  }

  return () => {
    for (const entry of Array.from(pendingRenders.values())) {
      entry.finish({ attachments: [], reason: 'disposed' })
    }
    pendingRenders.clear()
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      try { disposers[i]() } catch {}
    }
  }
}

export { DEFAULT_CONFIG, normalizeGlobalConfig, normalizeGameOverride, resolveEffectiveConfig }
export { applyInputEscapeToRequest, compactEncode } from './input-escape.js'
export { applyAntiRouteToRequest, sanitizeForArgonClassifiers, restoreBopomofoAndZeroWidth } from './anti-route.js'
