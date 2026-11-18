import {
  DEFAULT_CONFIG,
  PLUGIN_ID,
  normalizeConfig,
} from './config.js'
import { createRequestMonitorEngine } from './capture.js'
import {
  formatRecordAsCurl,
  formatRecordAsMarkdown,
  str,
} from './parser.js'

export const name = PLUGIN_ID
export const inject = ['tavern']
export const PLUGIN_VERSION = '1.0.0'

export function apply(ctx, options = {}) {
  const tavern = ctx?.tavern
  if (!tavern || typeof tavern !== 'object') return () => {}

  const disposers = []
  const keep = fn => {
    if (typeof fn === 'function') disposers.push(fn)
    return fn
  }

  let config = { ...DEFAULT_CONFIG }
  let configLoaded = false
  let feedVersion = 0
  const activeGameIds = new Set()
  const publishTimers = new Map()

  async function ensureConfigLoaded() {
    if (configLoaded) return config
    configLoaded = true
    try {
      if (typeof tavern.readPluginData === 'function') {
        const raw = await tavern.readPluginData()
        const payload = raw && typeof raw === 'object' && raw.data !== undefined ? raw.data : raw
        config = normalizeConfig(payload)
      }
    } catch {}
    return config
  }

  async function saveConfig(patch = {}) {
    await ensureConfigLoaded()
    config = normalizeConfig({ ...config, ...patch })
    try {
      if (typeof tavern.savePluginData === 'function') {
        await tavern.savePluginData({ data: config })
      }
    } catch {}
    schedulePublishAll()
    return config
  }

  function schedulePublish(gameId) {
    const id = str(gameId).trim()
    if (!id || typeof tavern.publishState !== 'function') return
    if (publishTimers.has(id)) return
    const timer = setTimeout(() => {
      publishTimers.delete(id)
      try {
        void tavern.publishState({
          gameId: id,
          name: 'monitor-feed',
          data: {
            version: feedVersion,
            stats: engine.stats(),
          },
        }).catch(() => {})
      } catch {}
    }, 120)
    publishTimers.set(id, timer)
  }

  function schedulePublishAll(preferredGameId = '') {
    if (preferredGameId) activeGameIds.add(preferredGameId)
    for (const id of activeGameIds) {
      schedulePublish(id)
    }
  }

  const engine = createRequestMonitorEngine({
    getConfig: () => config,
    fetchTarget: options.fetchTarget ?? globalThis,
    enableUndici: options.enableUndici !== false,
    enableFetchHook: options.enableFetchHook !== false,
    onChange(event) {
      feedVersion += 1
      const gameId = str(event?.record?.tavernContext?.gameId || event?.gameId)
      schedulePublishAll(gameId)
    },
  })

  // 启动时异步预加载配置
  void ensureConfigLoaded()

  // 只读注册 requestRewriter（永远返回 null，绝不改动请求体，仅用于关联酒馆上下文）
  if (typeof tavern.requestRewriter === 'function') {
    keep(tavern.requestRewriter({
      async rewrite(request, context) {
        try {
          if (context?.gameId) activeGameIds.add(str(context.gameId))
          engine.recordRewriterContext(request, context)
        } catch {}
        return null
      },
    }))
  }

  if (typeof tavern.handle === 'function') {
    keep(tavern.handle(`${PLUGIN_ID}/get-state`, async (args = {}) => {
      await ensureConfigLoaded()
      const currentGameId = str(args.currentGameId || args.gameId)
      if (currentGameId) activeGameIds.add(currentGameId)
      const viewMode = args.viewMode === 'game' ? 'game' : 'all'
      const requests = engine.listSummaries({
        gameId: viewMode === 'game' ? currentGameId : '',
        scope: str(args.scope),
        onlyErrors: args.onlyErrors === true,
        query: str(args.query),
      })
      return {
        version: feedVersion,
        config,
        stats: engine.stats(),
        requests,
      }
    }))

    keep(tavern.handle(`${PLUGIN_ID}/get-detail`, async (args = {}) => {
      await ensureConfigLoaded()
      const detail = engine.getDetail(args.id)
      if (!detail) return { found: false, record: null }
      if (args.includeRawWire === false) {
        detail.rawBodyText = ''
      }
      return {
        found: true,
        config,
        record: detail,
      }
    }))

    keep(tavern.handle(`${PLUGIN_ID}/export-record`, async (args = {}) => {
      const detail = engine.getDetail(args.id)
      if (!detail) throw new Error('未找到对应的请求记录（可能已被环形缓冲区淘汰）')
      const format = str(args.format || 'markdown')
      if (format === 'curl') {
        return { format, filename: `request-${detail.seq}.sh`, content: formatRecordAsCurl(detail) }
      }
      if (format === 'raw-wire') {
        return { format, filename: `request-${detail.seq}.wire.json`, content: detail.rawBodyText || '' }
      }
      if (format === 'json-pretty') {
        let content = detail.rawBodyText || ''
        try {
          content = JSON.stringify(JSON.parse(content), null, 2)
        } catch {}
        return { format, filename: `request-${detail.seq}.json`, content }
      }
      return { format: 'markdown', filename: `request-${detail.seq}.md`, content: formatRecordAsMarkdown(detail) }
    }))

    keep(tavern.handle(`${PLUGIN_ID}/save-config`, async (args = {}) => {
      const saved = await saveConfig(args.patch || {})
      return { config: saved, stats: engine.stats() }
    }))

    keep(tavern.handle(`${PLUGIN_ID}/clear`, async (args = {}) => {
      const res = engine.clear({ gameId: str(args.targetGameId) })
      feedVersion += 1
      schedulePublishAll()
      return { ...res, version: feedVersion, stats: engine.stats() }
    }))
  }

  if (typeof tavern.onGameRemoved === 'function') {
    keep(tavern.onGameRemoved(({ gameId }) => {
      const id = str(gameId)
      activeGameIds.delete(id)
      const timer = publishTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        publishTimers.delete(id)
      }
    }))
  }

  return () => {
    for (const timer of publishTimers.values()) clearTimeout(timer)
    publishTimers.clear()
    activeGameIds.clear()
    engine.dispose()
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      try { disposers[i]() } catch {}
    }
  }
}

export { DEFAULT_CONFIG, normalizeConfig, PLUGIN_ID }
export { createRequestMonitorEngine } from './capture.js'
export * from './parser.js'
