import { appendSessionEvent, closeOpeningTurn } from '../tavern-plugin/lib/domain/session-events.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installTavernTokenMeter } from '../tavern-plugin/lib/domain/tavern-token-meter.js'
import { sessionSeedTrajectoryMessages } from '../tavern-plugin/lib/domain/session-seed-trajectory.js'

const native = { skip: !process.env.DSH_BOOT_MODULE }
async function harness(t) {
  const url = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(url)
  const { Session } = await import(new URL('../../dsh-session/lib/index.js', url))
  const root = await mkdtemp(join(tmpdir(), 'tavern-meter-'))
  const config = join(root, 'host.yml')
  await writeFile(config, ['dsh-session', 'dsh-session-projection', 'dsh-token-meter'].map(n => '- name: ' + new URL('../../' + n + '/lib/index.js', url).href).join('\n'))
  const ctx = await boot('tavern-meter-test', config)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { ctx, Session }
}
const source = { kind: 'model', provider: 'fixture', model: 'text' }
function completed(session, usage) {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const e = appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, ...(usage ? {usage} : {}), message: { id: 'body', role: 'assistant', content: [{ type: 'text', text: 'Story '.repeat(1000) }], source } }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return e
}

test('原生 Token Meter 可统计既有无 step 的 Tavern 种子消息，且不改写历史', native, async t => {
  const { ctx, Session } = await harness(t)
  const session = Session.create('seed', [], { ...Session.create('seed').header, agentPreset: 'tavern' })
  // Pre-0.2 archives hold the reserved head and Tavern seeds without any
  // opening turn. The meter patch must still measure them without rewriting.
  appendSessionEvent(session, 'system/message', { turn: 1, step: 1, message: {
    id: 'tavern-system-head:' + session.id, role: 'system', content: [], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  for (const stage of sessionSeedTrajectoryMessages(session.id)) appendSessionEvent(session, stage.type, stage.data, stage.intent)
  const before = JSON.stringify(session.snapshotEvents())
  assert.throws(() => ctx.tokenMeter.measure(session), /assistant\/message.*no matching step\/start/)
  const eventAt = session.eventAt
  const hadOwnEventAt = Object.hasOwn(session, 'eventAt')
  const dispose = installTavernTokenMeter(ctx.tokenMeter)
  t.after(dispose)
  const measured = ctx.tokenMeter.measure(session)
  assert.ok(measured.totalTokens > 0)
  assert.equal(measured.nodes.length, session.header.version >= 3 ? 4 : 3)
  // A failed unpatched measurement can leave both a host projection and a
  // partial pricing cache. Repeated reads must recover without exposing the
  // temporary accounting eventAt wrapper to other Session consumers.
  assert.deepEqual(ctx.tokenMeter.measure(session), measured)
  assert.equal(session.eventAt, eventAt)
  assert.equal(Object.hasOwn(session, 'eventAt'), hadOwnEventAt)
  assert.equal(JSON.stringify(session.snapshotEvents()), before)
})

test('原生 Token Meter 在闭合回合后统计后台回退和正文替换', native, async t => {
  const { ctx, Session } = await harness(t)
  const session = Session.create('background', [], { ...Session.create('background').header, agentPreset: 'tavern-background' })
  completed(session)
  const before = ctx.tokenMeter.measure(session).totalTokens
  const seq = session.surface.nodes[0]
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'replacement', role: 'assistant', content: [], source } }, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
  assert.throws(() => ctx.tokenMeter.measure(session), /assistant\/message.*no matching step\/start/)
  t.after(installTavernTokenMeter(ctx.tokenMeter))
  assert.ok(ctx.tokenMeter.measure(session).totalTokens < before)
})

test('前后台固定系统背景连续压缩三次仍不变，原事件和恢复后的背景完整', native, async t => {
  const { ctx, Session } = await harness(t)
  const { ensureSessionStablePrefix, sessionStablePrefixSections } = await import('../tavern-plugin/lib/domain/session-stable-prefix.js')
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const fixed = '人物卡：固定人物形象。常驻世界书：固定世界规则。'
  let calls = 0
  class FixtureCompaction extends BasicCompactionEngine {
    async summarize(input) {
      calls++
      const systemText = input.system ?? input.messages.filter(m => m.role === 'system').map(m => m.content.map(b => b.text || '').join('')).join('\n')
      assert.equal(systemText, fixed)
      assert.ok(input.messages.filter(m => m.role !== 'system').every(message => !JSON.stringify(message.content).includes('固定人物形象')))
      return { summary: [{ type: 'text', text: '剧情摘要。' }], provider: 'fixture', model: 'summary', maxTokens: 128 }
    }
  }
  const engine = new FixtureCompaction(ctx, { auto: false })
  for (const preset of ['tavern', 'tavern-background']) {
    const session = ctx.sessions.create('fixed-' + preset, { meta: { agentPreset: preset } })
    await ensureSessionStablePrefix(session, fixed)
    const system = sessionStablePrefixSections(session).map(s => s.text).join('\n')
    session.append('request/header', { header: { config: { provider: 'fixture', model: 'summary' }, ...(session.header.version < 3 ? { system } : {}) }, reason: 'initial' })
    if (session.header.version >= 3) {
      const head = session.surface.nodes[0]
      session.append('system/message', { message: { id: 'assembled', role: 'system', content: [{ type: 'text', text: system }], source: { kind: 'system-prompt' } } }, { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] })
    }
    closeOpeningTurn(session)
    for (let n = 0; n < 3; n++) {
      session.append('turn/start', { turn: n + 2 })
      session.append('step/start', { turn: n + 2, step: 1 })
      session.append('user/message', { id: 'history-' + n, role: 'user', content: [{ type: 'text', text: '剧情进展。'.repeat(500) }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      session.append('user/message', { id: 'tail-' + n, role: 'user', content: [{ type: 'text', text: '最新剧情' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      session.append('step/end', { turn: n + 2, step: 1 })
      session.append('turn/end', { turn: n + 2, reason: { kind: 'completed' } })
      const original = session.snapshotEvents()
      const signal = new AbortController().signal
      assert.ok(await engine.compactNow({ session, options: {}, runMaintenance: fn => fn(signal) }, signal))
      if (session.header.version < 3) assert.equal(session.requestHeader().system, fixed)
      else assert.equal(session.deriveEventMessage(session.eventAt(session.surface.nodes[0])).content[0].text, fixed)
      assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
      const restored = Session.create(session.id, session.snapshotEvents(), session.header)
      assert.equal(sessionStablePrefixSections(restored).map(s => s.text).join('\n'), fixed)
      await ensureSessionStablePrefix(restored, '修改后的卡片不影响旧局')
      assert.equal(sessionStablePrefixSections(restored).map(s => s.text).join('\n'), fixed)
    }
  }
  assert.equal(calls, 6)
})

test('撤销回退恢复带 usage 的模型正文后仍可统计，历史和用量不重写', native, async t => {
  const {restoreSurface} = await import('../tavern-plugin/lib/domain/surface-restoration.js')
  const {ctx, Session} = await harness(t)
  const session = Session.create('undo-meter', [], {...Session.create('undo-meter').header, agentPreset: 'tavern'})
  const original = completed(session, {inputTokens: 100, outputTokens: 50, totalTokens: 150})
  const target = [...session.surface.nodes]
  appendSessionEvent(session, 'assistant/message', {turn: 1, step: 1, message: {id: 'rollback', role: 'assistant', content: [], source}}, {surfaceOp: {op: 'replace', start: original.seq, end: original.seq}, sourceEventSeqs: [original.seq]})
  restoreSurface(session, target)
  const before = JSON.stringify(session.snapshotEvents())
  t.after(installTavernTokenMeter(ctx.tokenMeter))
  assert.ok(ctx.tokenMeter.measure(session).totalTokens > 0)
  assert.equal(JSON.stringify(session.snapshotEvents()), before)
})

test('分叉按轮播种后原生 Token Meter 准确计量且 BasicCompactionEngine 可正常压缩', native, async t => {
  const { ctx } = await harness(t)
  const { repairNativeSurface } = await import('../tavern-plugin/lib/domain/native-surface-repair.js')
  const { ensureSessionStablePrefix } = await import('../tavern-plugin/lib/domain/session-stable-prefix.js')
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))

  const fixed = '固定角色设定与常驻世界书规则。'
  let summarizeCalls = 0
  let summarizedText = ''
  class FixtureCompaction extends BasicCompactionEngine {
    async summarize(input) {
      summarizeCalls++
      summarizedText = input.messages.map(m => (m.content || []).map(b => b.text || '').join('')).join('\n')
      return { summary: [{ type: 'text', text: '分叉历史压缩摘要。' }], provider: 'fixture', model: 'summary', maxTokens: 128 }
    }
  }
  const engine = new FixtureCompaction(ctx, { auto: false })
  t.after(installTavernTokenMeter(ctx.tokenMeter))

  const session = ctx.sessions.create('seeded-fork-meter', { meta: { agentPreset: 'tavern' } })
  await ensureSessionStablePrefix(session, fixed)
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'summary' }, ...(session.header.version < 3 ? { system: fixed } : {}) }, reason: 'initial' })
  if (session.header.version >= 3) {
    const head = session.surface.nodes[0]
    session.append('system/message', { message: { id: 'assembled', role: 'system', content: [{ type: 'text', text: fixed }], source: { kind: 'system-prompt' } } }, { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] })
  }
  closeOpeningTurn(session)

  const chat = {
    id: 'chat-fork-meter', mode: 'story',
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场剧情。' },
      { role: 'user', text: '前往酒馆调查线索' },
      { role: 'assistant', turn: 2, text: '酒馆第一轮长正文。'.repeat(120) },
      { role: 'user', text: '继续追问酒保细节' },
      { role: 'assistant', turn: 3, text: '酒馆第二轮长正文。'.repeat(120) }
    ]
  }
  const seeded = repairNativeSurface(session, chat, { repairId: 'seed-fork-meter', perRound: true, seeded: true })
  assert.equal(seeded.applied, true)

  const measuredBefore = ctx.tokenMeter.measure(session)
  assert.ok(measuredBefore.totalTokens > 0)
  assert.equal(measuredBefore.nodes.some(node => node.tokens > 0), true)

  // 追加一轮后续正常游玩，然后触发压缩验证所有按轮播种消息被计入且不损坏历史。
  const nextTurn = 5
  session.append('turn/start', { turn: nextTurn })
  session.append('step/start', { turn: nextTurn, step: 1 })
  session.append('user/message', { id: 'tail-user', role: 'user', content: [{ type: 'text', text: '离开酒馆前往港口' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('step/end', { turn: nextTurn, step: 1 })
  session.append('turn/end', { turn: nextTurn, reason: { kind: 'completed' } })

  const beforeEvents = session.snapshotEvents()
  const signal = new AbortController().signal
  const compacted = await engine.compactNow({ session, options: {}, runMaintenance: fn => fn(signal) }, signal)
  assert.ok(compacted)
  assert.equal(summarizeCalls, 1)
  assert.ok(summarizedText.includes('酒馆第一轮长正文'))
  assert.ok(summarizedText.includes('酒馆第二轮长正文'))
  assert.deepEqual(session.snapshotEvents().slice(0, beforeEvents.length), beforeEvents)
  assert.ok(ctx.tokenMeter.measure(session).totalTokens > 0)
})

test('createStoryReconciliation.seedNativeStory 从全空 V4 会话建固定前缀+按轮播种，继以新对话、重摇替换及连续两轮压缩仍保护系统前缀与正常计量', native, async t => {
  const { ctx, Session } = await harness(t)
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const { createStoryReconciliation } = await import('../tavern-plugin/lib/domain/story-reconciliation.js')
  const { createSessionSurfaceMutator } = await import('../tavern-plugin/lib/domain/session-surface-mutations.js')
  const { sessionEvents } = await import('../tavern-plugin/lib/domain/session-events.js')
  const { producerSource } = await import('../tavern-plugin/lib/domain/message-source.js')

  const compactedInputs = []
  class FixtureCompaction extends BasicCompactionEngine {
    async summarize(input) {
      compactedInputs.push(structuredClone(input))
      return { summary: [{ type: 'text', text: `剧情压缩摘要#${compactedInputs.length}` }], provider: 'fixture', model: 'summary', maxTokens: 128 }
    }
  }
  const engine = new FixtureCompaction(ctx, { auto: false })
  t.after(installTavernTokenMeter(ctx.tokenMeter))

  const session = ctx.sessions.create('seed-rec-compaction', { meta: { agentPreset: 'tavern' } })
  const agent = { session, phase: { kind: 'idle' } }
  const longA = '第一轮超长设定与铺垫。'.repeat(60)
  const longB = '第二轮复杂动作与长回复。'.repeat(60)
  let saved = {
    id: 'chat-seed-rec-compact',
    mode: 'story',
    forkedFrom: { chatId: 'src-chat', round: 2 },
    nativeOpeningAppended: false,
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场白' },
      { role: 'user', text: '进入酒馆' },
      { role: 'assistant', turn: 2, text: longA },
      { role: 'user', text: '与掌柜交谈' },
      { role: 'assistant', turn: 3, text: longB },
    ]
  }
  const fixedPrefix = '固定系统角色卡设定与持久规则前缀。'
  const rec = createStoryReconciliation({
    agentRegistry: { get: id => (id === session.id ? agent : undefined) },
    sessionStore: { get: id => (id === session.id ? session : undefined), flush: async () => session },
    chatForSession: async () => structuredClone(saved),
    chatSliceForSession: async () => ({ chat: structuredClone(saved), total: saved.messages.length, omitted: 0 }),
    updateChat: async (_id, mutate) => { const next = mutate(structuredClone(saved)); if (next) saved = next; return saved },
    turns: { finalize: async () => {} },
    ensurePrefix: async (target) => {
      const m = createSessionSurfaceMutator(target, sessionEvents(target))
      m.editStep((turn, step) => {
        m.append('system/message', {
          turn,
          step,
          message: { id: 'fixed-sys-prefix', role: 'system', content: [{ type: 'text', text: fixedPrefix }], source: producerSource('@deepseek-ai/dsh-system-prompt', undefined, 'system') }
        }, { surfaceOp: 'append' })
      })
    }
  })

  const seeded = await rec.seedNativeStory(session.id, session, 'e2e-meter-compact')
  assert.equal(seeded.applied, true)
  assert.equal(seeded.prefixed, true)
  const afterSeedTokens = ctx.tokenMeter.measure(session).totalTokens
  assert.ok(afterSeedTokens > 0)
  const headSeqBefore = session.surface.nodes[0]

  // 继续正常玩一轮（turn 5）：完整 turn/start -> user/message -> step/start -> assistant/message -> step/end -> turn/end
  const nextTurn = Number(agent.phase.lastTurn) + 1
  assert.equal(nextTurn, 5, 'seedNativeStory 后 agent.phase.lastTurn 必须同步推进至 4，确保下一轮为 5 不撞号')
  const longC = '第三轮新对话扩展长文正文内容。'.repeat(60)
  appendSessionEvent(session, 'turn/start', { turn: nextTurn })
  appendSessionEvent(session, 'user/message', { id: `u-${nextTurn}`, role: 'user', content: [{ type: 'text', text: '进一步追问线索' }], source: { kind: 'user', rpcId: 'rpc-next' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/start', { turn: nextTurn, step: 1 })
  const rNew = appendSessionEvent(session, 'assistant/message', {
    turn: nextTurn, step: 1,
    message: { id: `a-${nextTurn}`, role: 'assistant', content: [{ type: 'text', text: longC }], source: { ...source, tavernStoryTurn: 4 } }
  }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: nextTurn, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: nextTurn, reason: { kind: 'completed' } })
  const afterNewTokens = ctx.tokenMeter.measure(session).totalTokens
  assert.ok(afterNewTokens > afterSeedTokens)

  // 对该新轮执行重摇 replace（attempt + replace）后计量依然正常无错
  const regenTurn = nextTurn + 1
  const editTurn = nextTurn + 2
  appendSessionEvent(session, 'turn/start', { turn: regenTurn })
  appendSessionEvent(session, 'user/message', { id: 'regen-t', role: 'user', content: [], source: { kind: 'plugin:dsh-tavern-regen', regenerationId: 'rg-m1' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/start', { turn: regenTurn, step: 1 })
  const longD = '重摇后的超长新版本回复正文内容。'.repeat(65)
  const aRegen = appendSessionEvent(session, 'assistant/message', {
    turn: regenTurn, step: 1,
    message: { id: `a-${regenTurn}`, role: 'assistant', content: [{ type: 'text', text: longD }], source }
  }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: regenTurn, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: regenTurn, reason: { kind: 'completed' } })
  const shadowed = sessionEvents(session).slice(sessionEvents(session).findIndex(e => e.seq === rNew.seq), sessionEvents(session).findIndex(e => e.seq === aRegen.seq) + 1)
    .filter(e => e.type === 'user/message' || e.type === 'assistant/message').map(e => e.seq)
  appendSessionEvent(session, 'turn/start', { turn: editTurn })
  appendSessionEvent(session, 'step/start', { turn: editTurn, step: 1 })
  appendSessionEvent(session, 'assistant/message', {
    turn: editTurn, step: 1,
    message: { id: `a-${editTurn}`, role: 'assistant', content: [{ type: 'text', text: longD }], source: { ...source, tavernStoryTurn: 4 } }
  }, { surfaceOp: { op: 'replace', start: rNew.seq, end: aRegen.seq }, sourceEventSeqs: shadowed })
  appendSessionEvent(session, 'step/end', { turn: editTurn, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: editTurn, reason: { kind: 'completed' } })
  assert.ok(ctx.tokenMeter.measure(session).totalTokens > 0)

  // 第一次压缩：保护 node[0] 系统头
  const signal = new AbortController().signal
  const c1 = await engine.compactNow({ session, options: {}, runMaintenance: fn => fn(signal) }, signal)
  assert.ok(c1)
  assert.equal(session.surface.nodes[0], headSeqBefore, '第1次压缩后 node[0] 固定系统前缀必须纹丝不动')
  const headEvent1 = session.snapshotEvents().find(e => e.seq === session.surface.nodes[0])
  assert.equal(headEvent1.type, 'system/message')
  assert.equal(headEvent1.data.message.content[0].text, fixedPrefix)

  // 再追加更多轮并触发第二次连续压缩：固定系统前缀持续受到保护且 V4 会话可恢复
  const longE = '第四轮大段新增剧情推进长正文。'.repeat(70)
  const extraTurn = editTurn + 1
  appendSessionEvent(session, 'turn/start', { turn: extraTurn })
  appendSessionEvent(session, 'user/message', { id: `u-${extraTurn}`, role: 'user', content: [{ type: 'text', text: '接着呢' }], source: { kind: 'user', rpcId: 'rpc-e' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/start', { turn: extraTurn, step: 1 })
  appendSessionEvent(session, 'assistant/message', {
    turn: extraTurn, step: 1,
    message: { id: `a-${extraTurn}`, role: 'assistant', content: [{ type: 'text', text: longE }], source: { ...source, tavernStoryTurn: 5 } }
  }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: extraTurn, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: extraTurn, reason: { kind: 'completed' } })

  const c2 = await engine.compactNow({ session, options: {}, runMaintenance: fn => fn(signal) }, signal)
  assert.ok(c2)
  assert.equal(session.surface.nodes[0], headSeqBefore, '连续第2次压缩后 node[0] 系统前缀依然受保护')
  assert.doesNotThrow(() => Session.fromRestore(session.id, session.snapshotEvents(), session.header, 0, 'detached'))
  assert.ok(ctx.tokenMeter.measure(session).totalTokens > 0)
})
