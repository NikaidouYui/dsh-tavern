import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBackgroundProgress } from '../tavern-plugin/lib/domain/background-progress.js'
import { installHostStreamTimeoutPatch } from '../tavern-plugin/lib/domain/host-stream-timeout-patch.js'
import {
  patchDeepSeekStreamTimeoutSource,
  patchPiAiStreamTimeoutSource,
  RELAXED_STREAM_IDLE_TIMEOUT_MS,
} from '../tavern-plugin/lib/domain/llm-stream-timeout.js'
import { patchDeepSeekStreamTimeout, patchPiAiStreamTimeout } from '../bin/llm-stream-timeout-patch.mjs'

const piAiFixture = `const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
function resolveProfiles(providers) {
\tfor (const [provider, source] of entries) {
\t\tconst streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? 3e5;
\t}
}
`

const deepSeekFixture = `const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
function resolveAdapterOptions(config) {
\tconst streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
}
`

test('流式超时源码补丁将默认 5 分钟放宽为 10 分钟，重复应用幂等且漂移时不改写', () => {
  const piAiApplied = patchPiAiStreamTimeoutSource(piAiFixture)
  assert.equal(piAiApplied.status, 'applied')
  assert.match(piAiApplied.text, /const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 6e5;/)
  assert.match(piAiApplied.text, /source\.streamIdleTimeoutMs \?\? 6e5;/)
  assert.equal(patchPiAiStreamTimeoutSource(piAiApplied.text).status, 'patched')

  const deepSeekApplied = patchDeepSeekStreamTimeoutSource(deepSeekFixture)
  assert.equal(deepSeekApplied.status, 'applied')
  assert.match(deepSeekApplied.text, /const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 6e5;/)
  assert.match(deepSeekApplied.text, /config\.streamIdleTimeoutMs \?\? 6e5;/)
  assert.equal(patchDeepSeekStreamTimeoutSource(deepSeekApplied.text).status, 'patched')

  const numericLiteral = piAiFixture.replaceAll('3e5', '300000')
  assert.equal(patchPiAiStreamTimeoutSource(numericLiteral).status, 'applied')

  const alreadyRelaxed = deepSeekFixture.replaceAll('3e5', '600000')
  assert.equal(patchDeepSeekStreamTimeoutSource(alreadyRelaxed).status, 'patched')

  const drifted = piAiFixture.replace('source.streamIdleTimeoutMs ?? 3e5', 'source.streamIdleTimeoutMs ?? customDefault')
  assert.deepEqual(patchPiAiStreamTimeoutSource(drifted), { status: 'unmatched', text: drifted })
})

test('流式超时文件补丁校验包名并支持幂等写入', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'llm-stream-timeout-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const piAiDir = path.join(root, 'dsh-llm-pi-ai')
  const deepSeekDir = path.join(root, 'dsh-llm-deepseek')
  await mkdir(path.join(piAiDir, 'lib'), { recursive: true })
  await mkdir(path.join(deepSeekDir, 'lib'), { recursive: true })
  await writeFile(path.join(piAiDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai' }))
  await writeFile(path.join(deepSeekDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-deepseek' }))
  await writeFile(path.join(piAiDir, 'lib', 'index.js'), piAiFixture)
  await writeFile(path.join(deepSeekDir, 'lib', 'index.js'), deepSeekFixture)

  assert.equal(patchPiAiStreamTimeout(piAiDir), true)
  assert.equal(patchPiAiStreamTimeout(piAiDir), false)
  assert.equal(patchDeepSeekStreamTimeout(deepSeekDir), true)
  assert.equal(patchDeepSeekStreamTimeout(deepSeekDir), false)

  // 包名不匹配时不写入
  await writeFile(path.join(piAiDir, 'package.json'), JSON.stringify({ name: 'other-pkg' }))
  assert.equal(patchPiAiStreamTimeout(piAiDir), null)
})

test('运行时内存补丁仅放宽旧默认 300000ms，保留显式配置并可完整恢复', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'llm-stream-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const nm = path.join(root, 'node_modules', '@deepseek-ai')
  await mkdir(path.join(nm, 'dsh-llm-pi-ai'), { recursive: true })
  await mkdir(path.join(nm, 'dsh-llm-deepseek'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'host-fixture', type: 'module' }))

  await writeFile(path.join(nm, 'dsh-llm-pi-ai', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm-pi-ai',
    type: 'module',
    main: 'index.js',
  }))
  await writeFile(path.join(nm, 'dsh-llm-pi-ai', 'index.js'), `
    export class PiAiAdapter {
      profileOf(snapshot, provider) {
        return snapshot.get(provider)
      }
    }
  `)

  await writeFile(path.join(nm, 'dsh-llm-deepseek', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm-deepseek',
    type: 'module',
    main: 'index.js',
  }))
  await writeFile(path.join(nm, 'dsh-llm-deepseek', 'index.js'), `
    export class DeepSeekAdapter {
      async *streamWithConnection(options, connection) {
        yield { provider: options.provider, timeout: connection.streamIdleTimeoutMs }
      }
    }
  `)

  const hostRequire = createRequire(path.join(root, 'package.json'))
  const { PiAiAdapter } = await import(new URL(`file:///${path.join(nm, 'dsh-llm-pi-ai', 'index.js').replace(/\\/g, '/')}`).href)
  const { DeepSeekAdapter } = await import(new URL(`file:///${path.join(nm, 'dsh-llm-deepseek', 'index.js').replace(/\\/g, '/')}`).href)
  const origProfileOf = PiAiAdapter.prototype.profileOf
  const origStream = DeepSeekAdapter.prototype.streamWithConnection

  const restore1 = await installHostStreamTimeoutPatch({ hostRequire })
  const restore2 = await installHostStreamTimeoutPatch({ hostRequire })
  assert.notEqual(PiAiAdapter.prototype.profileOf, origProfileOf)
  assert.notEqual(DeepSeekAdapter.prototype.streamWithConnection, origStream)

  const piAi = new PiAiAdapter()
  const snapshot = new Map([
    ['defaulted', { streamIdleTimeoutMs: 300_000, api: 'openai-completions' }],
    ['custom-short', { streamIdleTimeoutMs: 120_000, api: 'openai-completions' }],
    ['custom-long', { streamIdleTimeoutMs: 900_000, api: 'openai-completions' }],
  ])
  assert.equal(piAi.profileOf(snapshot, 'defaulted').streamIdleTimeoutMs, 600_000)
  assert.equal(piAi.profileOf(snapshot, 'custom-short').streamIdleTimeoutMs, 120_000)
  assert.equal(piAi.profileOf(snapshot, 'custom-long').streamIdleTimeoutMs, 900_000)

  const ds = new DeepSeekAdapter()
  const outDefault = []
  for await (const chunk of ds.streamWithConnection({ provider: 'deepseek' }, { streamIdleTimeoutMs: 300_000 })) {
    outDefault.push(chunk)
  }
  assert.deepEqual(outDefault, [{ provider: 'deepseek', timeout: 600_000 }])

  const outCustom = []
  for await (const chunk of ds.streamWithConnection({ provider: 'deepseek' }, { streamIdleTimeoutMs: 450_000 })) {
    outCustom.push(chunk)
  }
  assert.deepEqual(outCustom, [{ provider: 'deepseek', timeout: 450_000 }])

  // 首个恢复调用不应卸掉仍在使用的补丁，第二次才完整恢复
  restore1()
  assert.notEqual(PiAiAdapter.prototype.profileOf, origProfileOf)
  restore2()
  assert.equal(PiAiAdapter.prototype.profileOf, origProfileOf)
  assert.equal(DeepSeekAdapter.prototype.streamWithConnection, origStream)
  assert.equal(piAi.profileOf(snapshot, 'defaulted').streamIdleTimeoutMs, 300_000)
})

test('后台模型进度保持上游 90 秒空闲上限，避免阻塞下一回合', () => {
  assert.equal(RELAXED_STREAM_IDLE_TIMEOUT_MS, 600_000)
  const progress = createBackgroundProgress()
  assert.equal(progress.snapshot().idleTimeoutMs, 90_000)
  progress.dispose()
})

test('真实 DSH 宿主适配器的流式超时补丁与内存补丁均可命中、幂等并恢复', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const require = createRequire(process.env.DSH_BOOT_MODULE)
  const root = await mkdtemp(path.join(tmpdir(), 'llm-stream-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  for (const [pkg, patchFn] of [
    ['@deepseek-ai/dsh-llm-pi-ai', patchPiAiStreamTimeout],
    ['@deepseek-ai/dsh-llm-deepseek', patchDeepSeekStreamTimeout],
  ]) {
    const pkgFile = require.resolve(`${pkg}/package.json`)
    const entryFile = require.resolve(pkg)
    const dst = path.join(root, pkg.replace('/', '__'))
    await mkdir(path.join(dst, 'lib'), { recursive: true })
    await writeFile(path.join(dst, 'package.json'), await readFile(pkgFile, 'utf8'))
    await writeFile(path.join(dst, 'lib', 'index.js'), await readFile(entryFile, 'utf8'))
    const result = patchFn(dst)
    assert.ok(result === true || result === false, `${pkg} 补丁应命中或已幂等，实际返回 ${String(result)}`)
    assert.equal(patchFn(dst), false)
    const content = await readFile(path.join(dst, 'lib', 'index.js'), 'utf8')
    assert.match(content, /DEFAULT_STREAM_IDLE_TIMEOUT_MS\s*=\s*(?:6e5|600000)/)
  }

  const { PiAiAdapter } = await import(new URL(`file:///${require.resolve('@deepseek-ai/dsh-llm-pi-ai').replace(/\\/g, '/')}`).href)
  const { DeepSeekAdapter } = await import(new URL(`file:///${require.resolve('@deepseek-ai/dsh-llm-deepseek').replace(/\\/g, '/')}`).href)
  const deepSeekMethod = ['generate', 'streamWithConnection'].find(name => typeof DeepSeekAdapter.prototype[name] === 'function')
  assert.ok(deepSeekMethod, 'DeepSeekAdapter 应具备 generate 或 streamWithConnection 方法')
  const origProfileOf = PiAiAdapter.prototype.profileOf
  const origStream = DeepSeekAdapter.prototype[deepSeekMethod]

  const restore = await installHostStreamTimeoutPatch({ hostRequire: require })
  try {
    assert.notEqual(PiAiAdapter.prototype.profileOf, origProfileOf)
    assert.notEqual(DeepSeekAdapter.prototype[deepSeekMethod], origStream)
    const piAi = new PiAiAdapter({})
    const snapshot = { profiles: new Map([['demo', { streamIdleTimeoutMs: 300_000 }]]) }
    assert.equal(piAi.profileOf(snapshot, 'demo').streamIdleTimeoutMs, 600_000)
  } finally {
    restore()
  }
  assert.equal(PiAiAdapter.prototype.profileOf, origProfileOf)
  assert.equal(DeepSeekAdapter.prototype[deepSeekMethod], origStream)
})
