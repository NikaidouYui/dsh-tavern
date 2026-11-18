import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { createTavernPluginApi } from '../tavern-plugin/lib/plugin-api.js'
import { registerModelStreamHooks } from '../tavern-plugin/lib/hooks/model-stream.js'
import { createModelRequestLog } from '../tavern-plugin/lib/domain/model-request-log.js'
import { installToolProtocolFetchPatch } from '../tavern-plugin/lib/domain/tool-protocol-enforcement.js'
import { parseGithubSource } from '../tavern-plugin/lib/domain/user-plugin-install.js'
import { stageTavernPlugin, TAVERN_PLUGIN_TARGETS } from '../.github/scripts/stage-tavern-plugin.mjs'
import { buildRequestMonitorClient } from '../tavern-plugin/packages/dsh-tavern-request-monitor/build.mjs'
import {
  apply as applyInputEscape,
} from '../tavern-plugin/packages/dsh-tavern-input-escape/lib/index.js'
import {
  apply as applyMonitor,
  createRequestMonitorEngine,
  decodeCompactCodepoints,
  formatRecordAsCurl,
  formatRecordAsMarkdown,
  maskSecret,
  normalizeAndRedactHeaders,
  parseLlmPayload,
  parseResponsePayload,
  redactUrl,
} from '../tavern-plugin/packages/dsh-tavern-request-monitor/lib/index.js'

function createInMemoryRequestLog() {
  const files = new Map()
  let seq = 0
  return createModelRequestLog({
    readJson: async p => (files.has(p) ? structuredClone(files.get(p)) : undefined),
    writeJson: async (p, v) => { files.set(p, structuredClone(v)) },
    updateJson: async (p, fn) => { files.set(p, structuredClone(await fn(structuredClone(files.get(p))))) },
    writeText: async (p, t) => { files.set(p, JSON.parse(t)) },
    now: () => ++seq,
    id: () => 'req-' + seq,
  })
}

function createFakeHost({ onStreamFetch } = {}) {
  const services = new Map()
  const hooks = new Map()
  let pluginData = null
  const log = createInMemoryRequestLog()

  const ctx = {
    fiber: { name: 'dsh-tavern' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, fn) {
      const list = hooks.get(name) || []
      list.push(fn)
      hooks.set(name, list)
      return () => {
        const idx = list.indexOf(fn)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    effect(fn) {
      const stop = fn()
      return typeof stop === 'function' ? stop : () => {}
    },
    llm: {
      stream(request) {
        const list = hooks.get('llm/stream') || []
        const run = index => (index < list.length
          ? list[index](request, () => run(index + 1))
          : (async function * () {
              if (onStreamFetch) await onStreamFetch(request)
              yield { type: 'text-delta', text: '正文输出' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })())
        return run(0)
      },
      resolveModelInfo: async () => ({}),
    },
    get(name) { return services.get(name) },
    provide(name, value) { services.set(name, value) },
  }

  const identities = new Map()
  const gameDataStore = new Map()
  const gameSettingsStore = new Map()
  const api = createTavernPluginApi({
    ctx,
    logger: console,
    resolveGame: async id => (id === 'game-1' ? { sessionId: 'game-1', chatId: 'chat-1', mode: 'story' } : null),
    cardPathOf: async () => '/cards/a.json',
    cardScope: async () => new Map(),
    runningUserPlugins: identities,
    readPendingTurn: async () => null,
    readLatestSettledTurn: async () => null,
    publish: () => {},
    publishState: () => {},
    data: {
      readPluginData: async () => pluginData,
      writePluginData: async (_owner, val) => { pluginData = structuredClone(val) },
      readGameData: async (chatId, owner) => gameDataStore.get(chatId + ':' + owner) || null,
      writeGameData: async (chatId, owner, val) => { gameDataStore.set(chatId + ':' + owner, structuredClone(val)) },
      readSettings: async chatId => ({ values: gameSettingsStore.get(chatId) || {} }),
      updateSettings: async (chatId, updater) => {
        const doc = { values: gameSettingsStore.get(chatId) || {} }
        await updater(doc)
        gameSettingsStore.set(chatId, doc.values)
      },
      turns: async () => [],
    },
    media: { turns: async () => [] },
    storyEvents: { on: () => () => {}, emit: () => {} },
    workflow: { register: () => () => {}, list: () => [] },
  })

  registerModelStreamHooks({
    agentRegistry: new Map(),
    pluginBodyGeneration: null,
    backgroundAgentRunner: { owns: () => false, requestContext: () => null },
    chatForSession: async () => ({ id: 'chat-1', mode: 'story' }),
    chatHeaderForSession: async id => (id === 'game-1' ? { id: 'chat-1', mode: 'story', requestMode: 'sillytavern' } : undefined),
    ctx,
    foregroundStrategies: { projectRequest: () => null, completeRequest: () => {} },
    fullTemplateRuntime: { forSession: () => ({ projectRequestProjection: async x => x }) },
    modelRequestLog: log,
    modelSelection: () => null,
    pluginCompactionNotes: null,
    pluginSettlementProgress: null,
    replyStarted: () => {},
    replyStreamRewriters: null,
    requestRewriters: api.requestRewriters,
    requestCoordinates: new Map([['game-1', { turn: 3 }]]),
    storyRetention: async () => ({ rounds: 6, volumeBudget: 1000, estimate: () => 10 }),
    runtimePrompt: () => '',
    sessionStateForSession: async () => null,
    recentStateForSession: async () => null,
    sessionStore: new Map(),
    str: v => (typeof v === 'string' ? v : v == null ? '' : String(v)),
    updateChat: async () => {},
    worldbookRecallLog: { requested: async () => {} },
    openReplyObservers: null,
  })

  const scopedTavern = owner => {
    if (!identities.has(owner)) {
      identities.set(owner, { runtimeName: owner, origin: 'global' })
    }
    return Object.assign(Object.create(api.service), {
      ctx: { fiber: { name: owner } },
    })
  }

  return { ctx, api, scopedTavern }
}

test('客户端构建脚本检查与契约验证通过', async () => {
  const res = await buildRequestMonitorClient({ check: true })
  assert.equal(res.changed, false)
})

test('URL 与请求头敏感凭证严格脱敏', () => {
  const safeUrl = redactUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=AIzaSySecretKey1234567890&alt=sse')
  assert.ok(!safeUrl.includes('AIzaSySecretKey1234567890'))
  assert.match(safeUrl, /AIza\.\.\.7890/)
  assert.match(safeUrl, /alt=sse/)

  const headers = normalizeAndRedactHeaders([
    'content-type', 'application/json',
    'authorization', 'Bearer sk-proj-supersecret9988',
    'x-api-key', 'ant-key-abcdef123456',
    'user-agent', 'node',
  ])
  const auth = headers.find(h => h.name === 'authorization')
  const xKey = headers.find(h => h.name === 'x-api-key')
  const ua = headers.find(h => h.name === 'user-agent')
  assert.equal(auth.redacted, true)
  assert.ok(!auth.value.includes('supersecret'))
  assert.ok(auth.value.startsWith('Bearer sk-p'))
  assert.equal(xKey.redacted, true)
  assert.ok(!xKey.value.includes('abcdef'))
  assert.equal(ua.redacted, false)
  assert.equal(ua.value, 'node')
  assert.ok(!maskSecret('short').includes('short'))
})

test('多协议解析器正确归一化 OpenAI / Anthropic / Gemini / Responses 并支持 Markdown 与 cURL 导出', () => {
  // 1) OpenAI Completions + 图片 + 工具 + 紧凑码点 + Session-ID
  const openaiRaw = JSON.stringify({
    model: 'deepseek-chat',
    stream: true,
    temperature: 0.7,
    messages: [
      { role: 'system', content: '[Session-ID: SID_999]\n【酒馆状态】正常' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '测试 ⟦U:4F60 597D⟧' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
      {
        role: 'assistant',
        reasoning_content: '先调用状态工具',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_story', arguments: '{"text":"你好"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'submit_story', content: '{"ok":true}' },
    ],
    tools: [{ type: 'function', function: { name: 'submit_story', description: '提交正文', parameters: { type: 'object' } } }],
  })
  const parsedOpenAi = parseLlmPayload(JSON.parse(openaiRaw), { url: 'https://api.example.com/v1/chat/completions', rawText: '{"a":"\\u4f60\\u597d"}' })
  assert.equal(parsedOpenAi.protocol, 'openai-completions')
  assert.equal(parsedOpenAi.messages.length, 4)
  assert.equal(parsedOpenAi.stats.imageCount, 1)
  assert.equal(parsedOpenAi.stats.toolCount, 1)
  assert.equal(parsedOpenAi.stats.toolCallCount, 1)
  assert.equal(parsedOpenAi.stats.sessionFingerprint, 'SID_999')
  assert.equal(parsedOpenAi.stats.wireUnicodeCount, 2)
  assert.equal(parsedOpenAi.stats.compactCodepointBlocks, 1)
  assert.equal(decodeCompactCodepoints('测试 ⟦U:4F60 597D⟧'), '测试 你好')

  // 2) Anthropic Messages
  const parsedAnthropic = parseLlmPayload({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    system: [{ type: 'text', text: '系统规则' }],
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '思考中', signature: 'sig-1' }, { type: 'tool_use', id: 'tu_1', name: 'dice', input: { sides: 20 } }] },
    ],
    tools: [{ name: 'dice', description: '骰子', input_schema: { type: 'object' } }],
  }, { url: 'https://api.anthropic.com/v1/messages' })
  assert.equal(parsedAnthropic.protocol, 'anthropic-messages')
  assert.equal(parsedAnthropic.messages[0].role, 'system')
  assert.equal(parsedAnthropic.messages[1].hasImage, true)
  assert.equal(parsedAnthropic.messages[2].hasThinking, true)
  assert.equal(parsedAnthropic.messages[2].hasTool, true)

  // 3) Gemini Native
  const parsedGemini = parseLlmPayload({
    systemInstruction: { parts: [{ text: 'Gemini 系统' }] },
    contents: [
      { role: 'user', parts: [{ text: '看图' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
      { role: 'model', parts: [{ thought: true, text: '推理过程' }, { functionCall: { name: 'move', args: { x: 1 } }, thoughtSignature: 'sig' }] },
    ],
    tools: [{ functionDeclarations: [{ name: 'move', description: '移动' }] }],
  }, { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent' })
  assert.equal(parsedGemini.protocol, 'gemini-native')
  assert.equal(parsedGemini.model, 'gemini-2.5-pro')
  assert.equal(parsedGemini.messages.length, 3)
  assert.equal(parsedGemini.messages[2].role, 'assistant')
  assert.equal(parsedGemini.tools[0].name, 'move')

  // 4) OpenAI Responses
  const parsedResp = parseLlmPayload({
    model: 'gpt-5',
    instructions: '指令',
    input: [
      { role: 'user', content: '你好' },
      { type: 'function_call', call_id: 'c1', name: 'ping', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'pong' },
    ],
  }, { url: 'https://api.openai.com/v1/responses' })
  assert.equal(parsedResp.protocol, 'openai-responses')
  assert.equal(parsedResp.messages.length, 4)

  const md = formatRecordAsMarkdown({
    seq: 1,
    createdAt: Date.now(),
    method: 'POST',
    url: 'https://api.example.com/v1/chat/completions',
    statusCode: 200,
    durationMs: 120,
    wireBytes: 256,
    parsed: parsedOpenAi,
    tavernContext: { gameId: 'g1', scope: 'story', turn: 2 },
  })
  assert.ok(md.includes('deepseek-chat'))
  assert.ok(md.includes('[SYSTEM]'))

  const curl = formatRecordAsCurl({
    method: 'POST',
    url: 'https://api.example.com/v1/chat/completions',
    headers: normalizeAndRedactHeaders({ authorization: 'Bearer sk-secret123456', 'content-type': 'application/json' }),
    rawBodyText: '{"hello":"world"}',
  })
  assert.ok(curl.includes('$AUTHORIZATION'))
  assert.ok(!curl.includes('sk-secret123456'))
})

test('真实 HTTP 服务器 + installToolProtocolFetchPatch 400降级重试 + Wire \\uXXXX 底层捕获', async () => {
  const seenBodies = []
  let chatHitCount = 0
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/api/tavern/ping') {
        res.statusCode = 200
        res.end(JSON.stringify({ pong: true }))
        return
      }
      if (req.url === '/v1/rate-limit') {
        res.statusCode = 429
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
        return
      }
      chatHitCount += 1
      seenBodies.push(text)
      if (chatHitCount === 1) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: { message: 'tool_choice required is not supported' } }))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.end('data: {"ok":true}\n\n')
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const originalGlobalFetch = globalThis.fetch

  // 故意先安装 toolProtocolEnforcement 的 fetch 补丁，再安装监控引擎，验证 undici 底层捕获顺序无关性
  const restoreProtocol = installToolProtocolFetchPatch(globalThis)
  const engine = createRequestMonitorEngine({
    getConfig: () => ({
      enabled: true,
      filterMode: 'llm_only',
      maxRecords: 20,
      maxTotalBytes: 8 * 1024 * 1024,
      maxSingleBodyBytes: 4 * 1024 * 1024,
      captureWireBody: true,
    }),
  })

  try {
    // 1) 内部路径应被忽略
    await fetch(`http://127.0.0.1:${port}/api/tavern/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ping: 1 }),
    })
    assert.equal(engine.listSummaries().length, 0)

    // 2) 通过 toolProtocolEnforcement + wireEscape 发送请求，第一次 400 自动降级重试第二次 200
    const { runWithToolProtocolDirective } = await import('../tavern-plugin/lib/domain/tool-protocol-enforcement.js')
    const { runWithWireEscape } = await import('../tavern-plugin/lib/domain/wire-unicode-escape.js')

    const res = await runWithWireEscape('full', () =>
      runWithToolProtocolDirective({
        provider: 'test',
        model: 'claude-sonnet-4-5',
        forceToolChoice: true,
        allowedToolNames: ['submit_story'],
      }, () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-test-secret-99999',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '你好，测试监控！' }],
          tools: [{ type: 'function', function: { name: 'submit_story', parameters: { type: 'object', properties: {} } } }],
        }),
      })),
    )
    assert.equal(res.status, 200)
    await res.text()
    // 等待 diagnostics_channel trailers/error 状态同步
    await new Promise(r => setTimeout(r, 40))

    const summaries = engine.listSummaries()
    assert.equal(summaries.length, 2, '两次真实 HTTP 重试请求都应被捕获')
    const newest = summaries[0]
    const firstAttempt = summaries[1]

    assert.equal(firstAttempt.attempt, 1)
    assert.equal(firstAttempt.statusCode, 400)
    assert.equal(firstAttempt.state, 'error')

    assert.equal(newest.attempt, 2)
    assert.equal(newest.statusCode, 200)
    assert.equal(newest.state, 'completed')
    assert.ok(newest.stats.wireUnicodeCount > 0, '应检测到真实 Wire 层 \\uXXXX 转义')

    const secondDetail = engine.getDetail(newest.id)
    assert.equal(secondDetail.rawBodyText, seenBodies[1], '监控记录的 Wire 原文应与服务器收到的字节流一字不差')
    assert.ok(!JSON.stringify(secondDetail.headers).includes('sk-test-secret-99999'))

    // 3) 直接返回 429 错误响应时，应捕获 errorResponseText
    const errRes = await fetch(`http://127.0.0.1:${port}/v1/rate-limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'err' }] }),
    })
    assert.equal(errRes.status, 429)
    await errRes.text()
    await new Promise(r => setTimeout(r, 40))
    const latest = engine.listSummaries()[0]
    assert.equal(latest.statusCode, 429)
    assert.equal(latest.state, 'error')
    assert.ok(engine.getDetail(latest.id).errorResponseText.includes('rate limit exceeded'))
    assert.equal(engine.getDetail(latest.id).parsedResponse.errorMessage, 'rate limit exceeded')
  } finally {
    engine.dispose()
    restoreProtocol()
    assert.equal(globalThis.fetch, originalGlobalFetch)
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})

test('有界环形缓冲区按条数和总字节严格淘汰旧记录', async () => {
  const mockFetch = async () => new Response('{"ok":true}', { status: 200 })
  const target = { fetch: mockFetch }
  const engine = createRequestMonitorEngine({
    fetchTarget: target,
    enableUndici: false,
    enableFetchHook: true,
    getConfig: () => ({
      enabled: true,
      filterMode: 'llm_only',
      maxRecords: 3,
      maxTotalBytes: 10 * 1024 * 1024,
      maxSingleBodyBytes: 1024 * 1024,
      captureWireBody: true,
    }),
  })

  try {
    for (let i = 1; i <= 5; i += 1) {
      await target.fetch('https://api.example.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: `m-${i}`, messages: [{ role: 'user', content: `msg-${i}` }] }),
      })
    }
    const list = engine.listSummaries()
    assert.equal(list.length, 3)
    assert.deepEqual(list.map(x => x.model), ['m-5', 'm-4', 'm-3'])
    assert.equal(engine.clear({ gameId: '' }).removed, 3)
    assert.equal(engine.listSummaries().length, 0)
  } finally {
    engine.dispose()
    assert.equal(target.fetch, mockFetch)
  }
})

test('与 dsh-tavern 插件 API 及 dsh-tavern-input-escape 全链路协作：关联轮次且零改写干扰', async () => {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const { ctx, api, scopedTavern } = createFakeHost({
    onStreamFetch: async request => {
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'secret-key-xyz' },
        body: JSON.stringify({
          model: request.model,
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: request.messages,
        }),
      })
    },
  })

  const escapeScope = scopedTavern('dsh-tavern-input-escape')
  const disposeEscape = applyInputEscape({ tavern: escapeScope, get: () => null })
  const monitorScope = scopedTavern('dsh-tavern-request-monitor')
  const disposeMonitor = applyMonitor({ tavern: monitorScope })

  try {
    const stream = ctx.llm.stream({
      sessionId: 'game-1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: [{ type: 'text', text: '系统设定' }] },
        { role: 'user', content: [{ type: 'text', text: '玩家输入测试' }] },
      ],
    })
    for await (const _ of stream) {}
    await new Promise(r => setTimeout(r, 40))

    const stateRes = await api.callHandler('dsh-tavern-request-monitor/get-state', {
      currentGameId: 'game-1',
      viewMode: 'game',
    })
    assert.equal(stateRes.requests.length, 1)
    const item = stateRes.requests[0]
    assert.equal(item.tavernContext.gameId, 'game-1')
    assert.equal(item.tavernContext.turn, 3)
    assert.equal(item.tavernContext.scope, 'story')
    assert.equal(item.model, 'deepseek-chat')

    const detailRes = await api.callHandler('dsh-tavern-request-monitor/get-detail', { id: item.id })
    assert.equal(detailRes.found, true)
    assert.ok(detailRes.record.parsed.stats.sessionFingerprint.startsWith('SID_'))

    const partialRes = await api.callHandler('dsh-tavern-request-monitor/get-detail', { id: item.id, includeRequestBody: false })
    assert.equal(partialRes.found, true)
    assert.equal(partialRes.partialResponseOnly, true)
    assert.equal(partialRes.record.rawBodyText, undefined)
    assert.equal(partialRes.record.parsed, undefined)

    const mdRes = await api.callHandler('dsh-tavern-request-monitor/export-record', { id: item.id, format: 'markdown' })
    assert.ok(mdRes.content.includes('deepseek-chat'))
  } finally {
    disposeMonitor()
    disposeEscape()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})

test('浏览器侧 client.js 可正常被 __ModuleLoader__ 加载并注册面板与输入栏入口', async () => {
  const clientCode = await readFile(
    new URL('../tavern-plugin/packages/dsh-tavern-request-monitor/client.js', import.meta.url),
    'utf8',
  )
  let loadedModule = null
  const registered = { panel: null, composerTool: null }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: {
      __ModuleLoader__: {
        load(entry) {
          loadedModule = entry.factory(name => {
            assert.equal(name, 'react')
            return {
              Fragment: Symbol('Fragment'),
              createElement: (type, props, ...children) => ({ type, props, children }),
              useEffect: () => {},
              useRef: init => ({ current: init }),
              useState: init => [typeof init === 'function' ? init() : init, () => {}],
            }
          })
        },
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(clientCode, sandbox)

  assert.equal(loadedModule.name, 'dsh-tavern-request-monitor')
  assert.deepEqual([...loadedModule.inject], ['tavernUi'])
  loadedModule.apply({
    tavernUi: {
      registerPanel(def) { registered.panel = def; return () => {} },
      registerComposerTool(def) { registered.composerTool = def; return () => {} },
      openOverlay() { return { close() {} } },
      callHost: async () => ({ requests: [], stats: {} }),
      watchState: () => () => {},
    },
  })
  assert.equal(registered.panel.id, 'request-monitor')
  assert.equal(registered.composerTool.id, 'request-monitor')
  assert.ok(registered.panel.render({ gameId: 'g1' }))
  assert.ok(registered.composerTool.render({ sessionId: 'g1' }))
})

test('响应体解析器（SSE/JSON）与 HTTP 200 流式旁路捕获及 Abort 不误报红灯', async () => {
  // 1) OpenAI SSE 拼接思考、正文、工具调用与 Usage
  const sseText = [
    'data: {"id":"cmpl-1","model":"gemini-4-hydrogen","choices":[{"delta":{"reasoning_content":"先分析局势"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"你好，"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"冒险者！","tool_calls":[{"index":0,"id":"call_9","function":{"name":"set_state","arguments":"{\\"hp\\":"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"99}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":120,"completion_tokens":35,"total_tokens":155}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const parsedSse = parseResponsePayload(sseText, { contentType: 'text/event-stream' })
  assert.equal(parsedSse.format, 'sse')
  assert.equal(parsedSse.model, 'gemini-4-hydrogen')
  assert.equal(parsedSse.thinking, '先分析局势')
  assert.equal(parsedSse.text, '你好，冒险者！')
  assert.equal(parsedSse.toolCalls.length, 1)
  assert.equal(parsedSse.toolCalls[0].name, 'set_state')
  assert.ok(parsedSse.toolCalls[0].argsText.includes('"hp": 99'))
  assert.equal(parsedSse.finishReason, 'tool_calls')
  assert.equal(parsedSse.usage.outputTokens, 35)
  assert.equal(parsedSse.doneMarker, true)

  // 2) 真实 SSE 流旁路捕获 + 收到第一段后主动 abort 不误报红色 error
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (req.url === '/v1/stream-full') {
      res.write('data: {"model":"gpt-5","choices":[{"delta":{"content":"完整回复"}}]}\n\n')
      res.write('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.write('data: {"model":"gpt-5","choices":[{"delta":{"content":"部分输出"}}]}\n\n')
    setTimeout(() => {
      if (!res.writableEnded) res.end()
    }, 300)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const engine = createRequestMonitorEngine({
    getConfig: () => ({
      enabled: true,
      filterMode: 'llm_only',
      maxRecords: 20,
      maxTotalBytes: 8 * 1024 * 1024,
      maxSingleBodyBytes: 4 * 1024 * 1024,
      captureWireBody: true,
    }),
  })

  try {
    // 场景 A：正常流式请求
    const resA = await fetch(`http://127.0.0.1:${port}/v1/stream-full`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await resA.text()
    await new Promise(r => setTimeout(r, 40))
    const sumA = engine.listSummaries()[0]
    assert.equal(sumA.state, 'completed')
    assert.equal(sumA.responseStats.textChars, 4)
    assert.equal(sumA.responseStats.finishReason, 'stop')
    const detailA = engine.getDetail(sumA.id)
    assert.equal(detailA.parsedResponse.text, '完整回复')

    // 场景 B：读到一段后客户端 abort，不应误标为 error，且保留已收内容
    const ac = new AbortController()
    const resB = await fetch(`http://127.0.0.1:${port}/v1/stream-abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'abort me' }] }),
      signal: ac.signal,
    })
    const reader = resB.body.getReader()
    await reader.read()
    ac.abort()
    await reader.read().catch(() => {})
    await new Promise(r => setTimeout(r, 60))

    const sumB = engine.listSummaries()[0]
    assert.equal(sumB.statusCode, 200)
    assert.notEqual(sumB.state, 'error')
    assert.equal(sumB.error, '')
    const detailB = engine.getDetail(sumB.id)
    assert.equal(detailB.parsedResponse.text, '部分输出')
  } finally {
    engine.dispose()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})

test('Action 发布脚本可将自研插件打包为兼容 GitHub 分支安装的纯净目录', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'rm-stage-'))
  try {
    for (const target of TAVERN_PLUGIN_TARGETS) {
      const ghSource = parseGithubSource(`https://github.com/NikaidouYui/dsh-tavern/tree/${target.branch}`)
      assert.equal(ghSource.owner, 'NikaidouYui')
      assert.equal(ghSource.repo, 'dsh-tavern')
      assert.equal(ghSource.ref, target.branch)

      const dest = path.join(tmpRoot, target.name)
      const staged = await stageTavernPlugin(target, dest)
      assert.equal(staged.name, target.name)
      assert.ok(staged.files.includes('package.json'))
      assert.ok(staged.files.includes('lib/index.js'))
      assert.ok(staged.files.includes('client.js'))
      assert.ok(!staged.files.some(f => f.startsWith('src/') || f === 'build.mjs'))
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})


