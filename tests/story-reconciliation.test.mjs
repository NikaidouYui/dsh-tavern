import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
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
