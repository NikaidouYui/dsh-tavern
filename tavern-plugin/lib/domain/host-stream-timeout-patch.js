import { pathToFileURL } from 'node:url'
import { hostRequireCandidates } from './host-package-resolution.js'
import { defaultHostRequire } from './host-session-patch.js'
import { LEGACY_STREAM_IDLE_TIMEOUT_MS, RELAXED_STREAM_IDLE_TIMEOUT_MS } from './llm-stream-timeout.js'

const installedByPrototype = new WeakMap()

async function resolvePackageRequire(packageName, { hostRequire, persistence, env, argv }) {
  if (hostRequire) {
    try {
      hostRequire.resolve(packageName)
      return hostRequire
    } catch {
      return null
    }
  }
  if (persistence) {
    try {
      const matched = await defaultHostRequire(persistence, { env, argv })
      matched.resolve(packageName)
      return matched
    } catch { /* 回退到仅按目标包解析的候选根 */ }
  }
  const { resolvable } = hostRequireCandidates({ names: [packageName], env, argv })
  return resolvable[0]?.require || null
}

function installPrototypePatch(prototype, methodName, createReplacement) {
  if (!prototype || typeof prototype[methodName] !== 'function') return null
  let records = installedByPrototype.get(prototype)
  if (!records) {
    records = new Map()
    installedByPrototype.set(prototype, records)
  }
  let record = records.get(methodName)
  if (!record) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName)
    if (!descriptor || typeof descriptor.value !== 'function') return null
    const patched = createReplacement(descriptor.value)
    record = { descriptor, patched, users: 0 }
    Object.defineProperty(prototype, methodName, { ...descriptor, value: patched })
    records.set(methodName, record)
  }
  record.users++
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (--record.users > 0) return
    if (prototype[methodName] === record.patched) {
      Object.defineProperty(prototype, methodName, record.descriptor)
    }
    records.delete(methodName)
    if (records.size === 0) installedByPrototype.delete(prototype)
  }
}

/**
 * 在内存中将宿主 LLM 适配器的旧默认流式空闲超时（300000ms）放宽到 10 分钟（600000ms）。
 * 既覆盖只读 app.asar 桌面宿主，也覆盖未打磁盘补丁直接启动的原生 DSH 宿主；
 * 若用户显式配置了其它数值则保持原样。
 */
export async function installHostStreamTimeoutPatch({
  hostRequire,
  persistence,
  env = process.env,
  argv = process.argv,
  timeoutMs = RELAXED_STREAM_IDLE_TIMEOUT_MS,
} = {}) {
  const restores = []
  const targets = [
    {
      packageName: '@deepseek-ai/dsh-llm-pi-ai',
      exportName: 'PiAiAdapter',
      methodName: 'profileOf',
      wrap: original => function profileOf(snapshot, provider) {
        const profile = original.call(this, snapshot, provider)
        if (profile && profile.streamIdleTimeoutMs === LEGACY_STREAM_IDLE_TIMEOUT_MS) {
          return { ...profile, streamIdleTimeoutMs: timeoutMs }
        }
        return profile
      },
    },
    {
      packageName: '@deepseek-ai/dsh-llm-deepseek',
      exportName: 'DeepSeekAdapter',
      methodNames: ['generate', 'streamWithConnection'],
      wrap: original => async function *patchedStream(options, connection) {
        const nextConnection = connection && connection.streamIdleTimeoutMs === LEGACY_STREAM_IDLE_TIMEOUT_MS
          ? { ...connection, streamIdleTimeoutMs: timeoutMs }
          : connection
        return yield* original.call(this, options, nextConnection)
      },
    },
  ]

  for (const target of targets) {
    const req = await resolvePackageRequire(target.packageName, { hostRequire, persistence, env, argv })
    if (!req) continue
    let mod
    try {
      mod = await import(pathToFileURL(req.resolve(target.packageName)).href)
    } catch {
      continue
    }
    const AdapterClass = mod?.[target.exportName]
    const methodNames = target.methodNames || [target.methodName]
    const methodName = methodNames.find(name => typeof AdapterClass?.prototype?.[name] === 'function')
    const restore = methodName ? installPrototypePatch(AdapterClass?.prototype, methodName, target.wrap) : null
    if (restore) restores.push(restore)
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const restore of restores.reverse()) restore()
  }
}
