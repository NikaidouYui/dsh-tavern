import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, isEditLifecycleSuppressed, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { createSessionSurfaceMutator } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { createStoryReconciliation } from '../tavern-plugin/lib/domain/story-reconciliation.js'

const reply = (id, turn) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'test', model: 'test' } } })

function harness({ chat, session = Session.create('story'), agent = null } = {}) {
  const reads = [], writes = []
  let saved = structuredClone(chat)
  const service = createStoryReconciliation({
    agentRegistry: new Map(agent ? [['story', agent]] : []),
    sessionStore: new Map([['story', session]]),
    chatForSession: async id => { reads.push(id); return id === 'story' ? structuredClone(saved) : undefined },
    chatSliceForSession: async () => null,
    async updateChat(id, mutate, options) { const next = mutate(structuredClone(saved)); writes.push(options.source); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })
  return { service, session, reads, writes, saved: () => saved }
}

test('concurrent reconciles share one run, and once-only reconciles stop after a report', async () => {
  // A regeneration in progress reports without repairing, so the run needs no native rounds.
  const h = harness({ chat: { id: 'game', mode: 'story', regenInProgress: true, messages: [] } })
  appendSessionEvent(h.session, 'assistant/message', reply('tavern-opening:x', 1), { surfaceOp: 'append' })
  const [first, second] = await Promise.all([h.service.reconcileWhenIdle('story'), h.service.reconcileWhenIdle('story')])
  assert.equal(first.state, 'regenerating')
  assert.equal(second, first, 'the second caller awaits the same run')
  assert.equal(h.reads.length, 1)
  assert.equal(await h.service.reconcileWhenIdle('story', { once: true }), null)
  assert.equal(h.reads.length, 1, 'a session already reconciled is not read again')
  assert.deepEqual(h.writes, [])
})

test('seedNativeStory 为故事分叉按轮初始化独立原生回合，轨迹不再把多轮助手回复合并到第 1 轮', async () => {
  const base = Session.create('story')
  const session = Session.create('story', [], { ...base.header, id: 'story', version: 4 })
  const sessionStore = new Map([['story', session]])
  sessionStore.flush = async () => {}
  const h = harness({
    session,
    chat: {
      id: 'game-fork', mode: 'story',
      nativeSync: { status: 'stale', reason: 'test', at: 1 },
      messages: [
        { role: 'assistant', turn: 1, greeting: true, text: '开场白' },
        { role: 'user', text: '第一句' },
        { role: 'assistant', turn: 2, text: '第一段正文' },
        { role: 'user', text: '第二句' },
        { role: 'assistant', turn: 3, text: '第二段正文' }
      ]
    }
  })
  // harness 的 sessionStore 没有 flush，直接通过 createStoryReconciliation 注入带 flush 的 store。
  let saved = h.saved()
  const service = createStoryReconciliation({
    agentRegistry: new Map(),
    sessionStore,
    chatForSession: async id => id === 'story' ? structuredClone(saved) : undefined,
    chatSliceForSession: async () => null,
    async updateChat(id, mutate) { const next = mutate(structuredClone(saved)); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })

  const result = await service.seedNativeStory('story', session, '故事分叉测试')
  assert.equal(result.applied, true)
  const events = sessionEvents(session)
  assert.deepEqual(events.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2, 3])
  assert.deepEqual(
    events.filter(event => event.type === 'assistant/message').map(event => [event.data.turn, event.data.step, event.data.message.content[0].text]),
    [[1, 1, '开场白'], [2, 1, '第一段正文'], [3, 1, '第二段正文']]
  )
  assert.equal(saved.nativeSync, undefined)
  assert.equal(saved.messages[2].nativeAnchor.turn, 2)
  assert.equal(saved.messages[4].nativeAnchor.turn, 3)
  const alignment = await service.reconcileWhenIdle('story')
  assert.equal(alignment.aligned, true)
})

test('seedNativeStory 预校验副本写入失败时，活 Session 无部分残留污染并标记 stale', async () => {
  const base = Session.create('story')
  const session = Session.create('story', [], { ...base.header, id: 'story', version: 4 })
  let probeCalls = 0
  session.constructor = {
    fromRestore(...args) {
      probeCalls++
      const probe = Session.fromRestore(...args)
      const origAppend = probe.append.bind(probe)
      let turnStarts = 0
      probe.append = (type, ...rest) => {
        if (type === 'turn/start' && ++turnStarts === 2) throw new Error('模拟第 2 轮写入失败')
        return origAppend(type, ...rest)
      }
      return probe
    }
  }
  let liveAppendCalls = 0
  const origLiveAppend = session.append.bind(session)
  session.append = (...args) => { liveAppendCalls++; return origLiveAppend(...args) }

  const beforeEvents = JSON.stringify(sessionEvents(session))
  const beforeNodes = [...session.surface.nodes]
  const sessionStore = new Map([['story', session]])
  sessionStore.flush = async () => {}
  let saved = {
    id: 'game-fork-fail', mode: 'story',
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场白' },
      { role: 'user', text: '第一句' },
      { role: 'assistant', turn: 2, text: '第一段正文' }
    ]
  }
  const service = createStoryReconciliation({
    agentRegistry: new Map(),
    sessionStore,
    chatForSession: async id => id === 'story' ? structuredClone(saved) : undefined,
    chatSliceForSession: async () => null,
    async updateChat(_id, mutate) { const next = mutate(structuredClone(saved)); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })

  const result = await service.seedNativeStory('story', session, 'probe-fail')
  assert.equal(result, null)
  assert.equal(probeCalls, 1)
  assert.equal(liveAppendCalls, 0)
  assert.equal(JSON.stringify(sessionEvents(session)), beforeEvents)
  assert.deepEqual(session.surface.nodes, beforeNodes)
  assert.equal(saved.nativeSync?.status, 'stale')
  assert.equal(isEditLifecycleSuppressed(session), false)
})

test('seedNativeStory 批量按轮播种期间开启静默编辑抑制标记，完成后立即撤销', async () => {
  const base = Session.create('story')
  const session = Session.create('story', [], { ...base.header, id: 'story', version: 4 })
  const seenStates = []
  const rawAppend = session.append.bind(session)
  session.append = (type, data, ...rest) => {
    if (type === 'turn/start' || type === 'turn/end') {
      seenStates.push([type, data?.turn, isEditLifecycleSuppressed(session)])
    }
    return rawAppend(type, data, ...rest)
  }

  const sessionStore = new Map([['story', session]])
  sessionStore.flush = async () => {}
  let saved = {
    id: 'game-batch', mode: 'story',
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场白' },
      { role: 'user', text: '输入2' },
      { role: 'assistant', turn: 2, text: '正文2' },
      { role: 'user', text: '输入3' },
      { role: 'assistant', turn: 3, text: '正文3' },
      { role: 'user', text: '输入4' },
      { role: 'assistant', turn: 4, text: '正文4' }
    ]
  }
  const service = createStoryReconciliation({
    agentRegistry: new Map(),
    sessionStore,
    chatForSession: async id => id === 'story' ? structuredClone(saved) : undefined,
    chatSliceForSession: async () => null,
    async updateChat(_id, mutate) { const next = mutate(structuredClone(saved)); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })

  const seeded = await service.seedNativeStory('story', session, 'batch-suppress')
  assert.equal(seeded.applied, true)
  assert.equal(isEditLifecycleSuppressed(session), false)
  assert.equal(seenStates.length, 8)
  assert.ok(seenStates.every(([_type, _turn, suppressed]) => suppressed === true))

  // 普通单次 surface 编辑不置抑制标记，保留原有前景结算生命周期。
  const singleStates = []
  session.append = (type, data, ...rest) => {
    if (type === 'turn/start' || type === 'turn/end') singleStates.push(isEditLifecycleSuppressed(session))
    return rawAppend(type, data, ...rest)
  }
  const mutator = createSessionSurfaceMutator(session, sessionEvents(session))
  mutator.editStep((turn, step) => {
    mutator.append('assistant/message', { turn, step, message: {
      id: 'single-edit', role: 'assistant', content: [{ type: 'text', text: '单次编辑' }],
      source: { kind: 'model', provider: 'dsh-tavern', model: 'native-repair' }
    } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  })
  assert.deepEqual(singleStates, [false, false])
})
