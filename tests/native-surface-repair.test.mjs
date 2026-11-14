import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { roundAnchor } from '../tavern-plugin/lib/domain/round-anchor.js'
import { locateRollbackSurface, projectedReplyTurns, surfaceTurnOfSeq } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { nativeOpeningMessageId } from '../tavern-plugin/lib/domain/native-opening.js'
import { applyNativeSurfaceRepair, planNativeSurfaceRepair, recordNativeSurfaceRepair, repairNativeSurface } from '../tavern-plugin/lib/domain/native-surface-repair.js'
import { planShowsRow, planStoryTurn, planTranscriptRows } from '../tavern-plugin/lib/domain/transcript-row-plan.js'

const model = { kind: 'model', provider: 'test', model: 'test' }
const textOf = event => (event.data.message?.content || event.data.content || []).map(block => block.text).join('')

// A played game: prefix, opening, then rounds whose Chat rows carry anchors.
function game(rounds, { anchors = true, id = 'repair' } = {}) {
  const session = Session.create(id)
  const chat = { id: 'chat-' + id, mode: 'story', messages: [] }
  appendSessionEvent(session, 'user/message', { id: 'tavern-session-prefix:' + id, role: 'user', content: [{ type: 'text', text: '前缀' }], source: { kind: 'plugin', plugin: 'dsh-tavern' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: nativeOpeningMessageId(chat.id), role: 'assistant', content: [{ type: 'text', text: '开场' }], source: model } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  chat.messages.push({ role: 'assistant', turn: 1, greeting: true, text: '开场' })
  for (let turn = 2; turn < rounds + 2; turn++) play(session, chat, turn, anchors)
  return { session, chat }
}
function play(session, chat, turn, anchors = true) {
  appendSessionEvent(session, 'turn/start', { turn })
  appendSessionEvent(session, 'user/message', { id: 'frame-' + turn, role: 'user', content: [{ type: 'text', text: '本轮上下文' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame' } }, { surfaceOp: 'append' })
  const input = appendSessionEvent(session, 'user/message', { id: 'in-' + turn, role: 'user', content: [{ type: 'text', text: '行动' + turn }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const reply = appendSessionEvent(session, 'assistant/message', { turn, step: 1, message: { id: 'out-' + turn, role: 'assistant', content: [{ type: 'text', text: '正文' + turn }], source: model } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
  chat.messages.push({ role: 'user', text: '行动' + turn }, { role: 'assistant', turn, text: '正文' + turn, ...(anchors ? { nativeAnchor: roundAnchor(turn, input, reply) } : {}) })
  return { input, reply }
}
const nodeTexts = session => { const bySeq = new Map(sessionEvents(session).map(event => [event.seq, event])); return session.surface.nodes.map(seq => textOf(bySeq.get(seq))) }
const plan = ({ session, chat }) => planNativeSurfaceRepair({ chat, events: sessionEvents(session), nodes: session.surface.nodes })
function repair(h, repairId = 'r1') {
  const result = repairNativeSurface(h.session, h.chat, { repairId })
  recordNativeSurfaceRepair(h.chat, h.chat, result.anchors)
  return result
}

test('分叉投影为新会话保留系统消息头，宿主可追加下一轮系统提示', () => {
  const source = game(1)
  const session = Session.create('seeded-fork', [], { ...source.session.header, id: 'seeded-fork', version: 4 })
  const result = repairNativeSurface(session, source.chat, { repairId: 'seed-fork' })
  assert.equal(result.applied, true)
  const events = sessionEvents(session)
  assert.equal(events.find(event => event.seq === session.surface.nodes[0]).type, 'system/message')
  assert.deepEqual(nodeTexts(session), ['', '开场', '行动2', '正文2'])
  appendSessionEvent(session, 'turn/start', { turn: 2 })
  appendSessionEvent(session, 'step/start', { turn: 2, step: 1 })
  appendSessionEvent(session, 'system/message', { turn: 2, step: 1, message: {
    id: 'updated-system', role: 'system', content: [{ type: 'text', text: '提示词' }], source: { kind: 'system-prompt' }
  } }, { surfaceOp: 'append' })
  assert.doesNotThrow(() => Session.fromRestore(session.id, sessionEvents(session), session.header, 0, 'detached'))
})

test('一致的存档不写任何东西', () => {
  const h = game(3)
  const before = h.session.surface.nodes.slice()
  assert.equal(plan(h).status, 'intact')
  assert.equal(repair(h).applied, false)
  assert.deepEqual(h.session.surface.nodes, before)
})

test('只坏最后一轮：保留前面全部节点，只重写最后一轮，修复后回退能直接定位', () => {
  const h = game(3)
  const kept = h.session.surface.nodes.slice(0, -3) // through round 3's reply
  const last = h.chat.messages.at(-1)
  last.text = '玩家改过的正文' // Chat changed, native never followed (a lost body-edit sync).
  const result = repair(h)
  assert.equal(result.plan.status, 'tail')
  assert.deepEqual(result.plan.rounds.map(round => round.turn), [4])
  assert.deepEqual(h.session.surface.nodes.slice(0, kept.length), kept)
  assert.deepEqual(nodeTexts(h.session).slice(kept.length), ['行动4', '玩家改过的正文'])
  assert.equal(plan(h).status, 'intact', 'repair is idempotent')
  const target = locateRollbackSurface({ events: sessionEvents(h.session), nodes: h.session.surface.nodes, anchor: last.nativeAnchor })
  assert.ok(target, 'rollback finds the repaired round by its new anchor')
  assert.equal(textOf(sessionEvents(h.session).find(event => event.seq === target.assistantSeq)), '玩家改过的正文')
})

test('回退后 Chat 少了一轮、原生却留着：去掉原生多出的那一轮', () => {
  const h = game(3)
  h.chat.messages.splice(-2) // Chat committed the rollback; native mutation failed.
  const kept = h.session.surface.nodes.slice(0, -3)
  repair(h)
  assert.deepEqual(h.session.surface.nodes.slice(0, kept.length), kept)
  assert.deepEqual(nodeTexts(h.session).slice(kept.length), [''], 'only an empty placeholder stands for the removed round')
  assert.equal(plan(h).status, 'intact')
})

test('删除末尾回复后：独立 user 保留在 Surface，旧回复被遮掉', () => {
  const h = game(1)
  h.chat.messages.pop()
  const result = repair(h)
  assert.equal(result.applied, true)
  assert.deepEqual(nodeTexts(h.session).filter(Boolean), ['前缀', '开场', '本轮上下文', '行动2'])
  assert.equal(nodeTexts(h.session).includes('正文2'), false)
  assert.equal(plan(h).status, 'intact')
})

test('删除输入后：独立 assistant 写回，不带旧 user', () => {
  const h = game(1)
  h.chat.messages.splice(-2, 1)
  const result = repair(h)
  assert.equal(result.plan.rounds.length, 1)
  assert.equal(result.plan.rounds[0].userText, null)
  assert.deepEqual(nodeTexts(h.session), ['前缀', '开场', '正文2'])
  assert.equal(plan(h).status, 'intact')
})

test('独立 assistant 修复后清除旧成对锚点，不再误定位到其它正文', () => {
  const h = game(2)
  h.chat.messages.splice(1, 1)
  const standalone = h.chat.messages[1]
  assert.ok(standalone.nativeAnchor)
  repair(h)
  assert.equal(standalone.nativeAnchor, undefined)
  assert.equal(plan(h).status, 'intact')
})

test('删除中间回复后：连续 user 分别保留，不并入下一条 assistant', () => {
  const h = game(2)
  h.chat.messages.splice(2, 1)
  const result = repair(h)
  assert.equal(result.plan.rounds.length, 1)
  assert.equal(result.plan.rounds[0].userText, '行动3')
  assert.deepEqual(nodeTexts(h.session), ['前缀', '开场', '本轮上下文', '行动2', '行动3', '正文3'])
  assert.equal(nodeTexts(h.session).includes('行动2\n\n行动3'), false)
  assert.equal(plan(h).status, 'intact')
})

test('最后一轮之后残留失败的输入或半截正文：只遮掉残留，最后一轮保留', () => {
  const h = game(2)
  appendSessionEvent(h.session, 'user/message', { id: 'stray', role: 'user', content: [{ type: 'text', text: '中断的输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(h.session, 'assistant/message', { turn: 9, step: 1, message: { id: 'half', role: 'assistant', content: [{ type: 'text', text: '半截' }], source: model } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  assert.equal(plan(h).status, 'tail')
  const kept = h.session.surface.nodes.slice(0, -2)
  repair(h)
  assert.deepEqual(h.session.surface.nodes.slice(0, kept.length), kept)
  assert.deepEqual(nodeTexts(h.session).slice(kept.length), [''])
  assert.equal(plan(h).status, 'intact')
})

test('注入的上下文和空占位不算残留', () => {
  const h = game(2)
  appendSessionEvent(h.session, 'user/message', { id: 'vars', role: 'user', content: [{ type: 'text', text: '变量变化' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'variable-changes' } }, { surfaceOp: 'append' })
  assert.equal(plan(h).status, 'intact')
})

test('旧存档没有锚点：按正文文字找到断点', () => {
  const h = game(3, { anchors: false })
  h.chat.messages.at(-1).text = '新正文'
  const kept = h.session.surface.nodes.slice(0, -3)
  repair(h)
  assert.deepEqual(h.session.surface.nodes.slice(0, kept.length), kept)
  assert.deepEqual(nodeTexts(h.session).slice(-2), ['行动4', '新正文'])
})

test('压缩摘要保留：断点之前的压缩检查点不被替换', () => {
  const h = game(4)
  const nodes = h.session.surface.nodes
  // Compaction replaced rounds 2-3 (from round 2's frame through round 3's reply) by one summary.
  const start = nodes[2], end = nodes[7]
  const summary = replaceSessionSurface(h.session, 'user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: '前情摘要' }], source: { kind: 'plugin', plugin: 'compact' } }, { start, end, sourceEventSeqs: nodes.slice(2, 8) })
  h.chat.messages.at(-1).text = '改过的第五轮'
  repair(h)
  assert.ok(h.session.surface.nodes.includes(summary.seq))
  assert.deepEqual(nodeTexts(h.session), ['前缀', '开场', '前情摘要', '本轮上下文', '行动4', '正文4', '行动5', '改过的第五轮'])
})

test('压缩之后的轮次全部对不上：保留摘要，只重写压缩后的轮次', () => {
  const h = game(3, { anchors: false })
  const nodes = h.session.surface.nodes
  replaceSessionSurface(h.session, 'user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: '前情摘要' }], source: { kind: 'plugin', plugin: 'compact' } }, { start: nodes[2], end: nodes[4], sourceEventSeqs: nodes.slice(2, 5) })
  for (const message of h.chat.messages) if (message.role === 'assistant' && !message.greeting) message.text += '（改）'
  const result = repair(h)
  assert.equal(result.plan.keep, 3)
  assert.equal(nodeTexts(h.session)[2], '前情摘要')
  assert.equal(nodeTexts(h.session).at(-1), '正文4（改）')
  assert.ok(!nodeTexts(h.session).includes('正文2（改）'), '摘要已经代表的第 2 轮不被写回')
})

test('旧档迁移后锚点失效：摘要代表的轮次不写回，摘要之后没有轮次就算一致', () => {
  const h = game(1)
  const nodes = h.session.surface.nodes
  // A legacy session replaced the native log: its summary stands for round 2, and the
  // Chat's anchor still points at the old log's seqs.
  replaceSessionSurface(h.session, 'user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: '前情摘要' }], source: { kind: 'plugin', plugin: 'compact' } }, { start: nodes[2], end: nodes.at(-1), sourceEventSeqs: nodes.slice(2) })
  h.chat.messages.at(-1).nativeAnchor = { turn: 2, input: 9000, reply: 9001 }
  assert.equal(plan(h).status, 'intact')
  assert.deepEqual(nodeTexts(h.session), ['前缀', '开场', '前情摘要'])
  // A later round played on top is located and kept; still nothing to write.
  play(h.session, h.chat, 3)
  assert.equal(plan(h).status, 'intact')
})

test('一轮都对不上也不拒绝：保留前缀和开场，按 Chat 整段重写', () => {
  const h = game(2)
  for (const message of h.chat.messages) if (message.role === 'assistant' && !message.greeting) message.text += '!'
  for (const message of h.chat.messages) delete message.nativeAnchor
  const result = repair(h)
  assert.equal(result.plan.status, 'tail', 'the opening is still an intact boundary')
  assert.deepEqual(nodeTexts(h.session), ['前缀', '开场', '行动2', '正文2!', '行动3', '正文3!'])
  // Opening lost too: keep only the prefix.
  const g = game(1, { id: 'full' })
  replaceSessionSurface(g.session, 'assistant/message', { turn: 1, step: 1, message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: '坏' }], source: model } }, { start: g.session.surface.nodes[1], end: g.session.surface.nodes.at(-1), sourceEventSeqs: g.session.surface.nodes.slice(1) })
  delete g.chat.messages.at(-1).nativeAnchor
  const full = repair(g)
  assert.equal(full.plan.status, 'full')
  assert.deepEqual(nodeTexts(g.session), ['前缀', '开场', '行动2', '正文2'])
  assert.equal(plan(g).status, 'intact')
})

test('1000 轮存档坏了最后一轮：前 999 轮节点逐个不变，修复只看末尾', () => {
  const h = game(1000, { id: 'long' })
  const kept = h.session.surface.nodes.slice(0, -3)
  h.chat.messages.at(-1).text = '最后一轮改过'
  const started = performance.now()
  const result = repair(h)
  const elapsed = performance.now() - started
  assert.deepEqual(result.plan.rounds.map(round => round.turn), [1001])
  assert.deepEqual(h.session.surface.nodes.slice(0, kept.length), kept)
  assert.ok(elapsed < 1000, 'repair took ' + elapsed + 'ms')
})

test('修复写回存档：只给读时未变的楼层换锚点，清掉待修复标记与旧编辑标记', async () => {
  const { recordNativeSurfaceRepair } = await import('../tavern-plugin/lib/domain/native-surface-repair.js')
  const h = game(2)
  h.chat.messages.at(-1).text = '改过'
  h.chat.messages.at(-1).bodyEdit = { id: 'old', seq: 1, turn: 3 }
  h.chat.nativeSync = { status: 'stale', reason: 'x', at: 1 }
  const read = structuredClone(h.chat)
  const result = repairNativeSurface(h.session, read, { repairId: 'w' })
  const current = structuredClone(h.chat)
  assert.equal(recordNativeSurfaceRepair(current, read, result.anchors), true)
  assert.equal(current.nativeSync, undefined)
  assert.equal(current.messages.at(-1).bodyEdit, undefined)
  assert.deepEqual(current.messages.at(-1).nativeAnchor, result.anchors[0].anchor)
  // The row changed after the repair read it: keep its anchor, repair again later.
  const moved = structuredClone(h.chat); moved.messages.at(-1).text = '又改了'
  recordNativeSurfaceRepair(moved, read, result.anchors)
  assert.deepEqual(moved.messages.at(-1).nativeAnchor, h.chat.messages.at(-1).nativeAnchor)
  assert.equal(recordNativeSurfaceRepair(structuredClone(current), read, []), false)
})

test('修复移动正文后，锚点和映射指向实际编辑轮，修复替换不冒充重新生成投影', () => {
  const h = game(2)
  const last = h.chat.messages.at(-1)
  last.text = '修复后的正文'
  h.chat.regeneratedDshTurns = { 3: 8 } // 旧生成期映射；修复会再移动一次
  const repaired = repairNativeSurface(h.session, h.chat, { repairId: 'move' })
  recordNativeSurfaceRepair(h.chat, h.chat, repaired.anchors)
  const reply = sessionEvents(h.session).find(event => event.seq === last.nativeAnchor.reply)
  assert.equal(last.turn, 3, '修复不改稳定的存档回合号')
  assert.ok(Number(reply.data.turn) > 3)
  assert.equal(last.nativeAnchor.turn, Number(reply.data.turn), '锚点轮号与 reply 事件的原生轮一致')
  assert.equal(h.chat.regeneratedDshTurns[3], Number(reply.data.turn), '映射同步到正文实际所在行')
  assert.equal(reply.surfaceOp, 'append')
  assert.equal(projectedReplyTurns({ events: sessionEvents(h.session), nodes: h.session.surface.nodes }).get(3), Number(reply.data.turn),
    'native-repair 追加正文按显式故事号映射到实际原生轮')
  const replacement = { ...reply, surfaceOp: { op: 'replace' } }
  assert.equal(projectedReplyTurns({ events: [replacement], nodes: [reply.seq] }).has(3), false,
    'native-repair 替换不能再用范围尾部覆盖这个映射')

  last.text = '再次修复的正文'
  const second = repairNativeSurface(h.session, h.chat, { repairId: 'move-again' })
  recordNativeSurfaceRepair(h.chat, h.chat, second.anchors)
  const secondReply = sessionEvents(h.session).find(event => event.seq === last.nativeAnchor.reply)
  assert.equal(secondReply.data.message.source.tavernStoryTurn, 3, '再次修复仍使用稳定故事号，不把上次原生位置当故事号')
  assert.equal(last.nativeAnchor.turn, Number(secondReply.data.turn))
  assert.equal(h.chat.regeneratedDshTurns[3], Number(secondReply.data.turn))
})

test('原生里是模型原文（未去空白、未经正则），存档里是投影后的文字：仍算一致', () => {
  const h = game(2)
  for (const message of h.chat.messages.filter(row => row.role === 'assistant' && !row.greeting)) {
    message.sourceText = message.text
    message.text = message.text + '〔正则处理后〕'
  }
  // A further round whose raw native text keeps trailing blank lines; saved texts are trimmed.
  const input = appendSessionEvent(h.session, 'user/message', { id: 'in-raw', role: 'user', content: [{ type: 'text', text: '行动' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const reply = appendSessionEvent(h.session, 'assistant/message', { turn: 4, step: 1, message: { id: 'out-raw', role: 'assistant', content: [{ type: 'text', text: '原文\n\n' }], source: model } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  h.chat.messages.push({ role: 'user', text: '行动' }, { role: 'assistant', turn: 4, sourceText: '原文', text: '原文〔正则处理后〕', nativeAnchor: roundAnchor(4, input, reply) })
  assert.equal(plan(h).status, 'intact')
  delete h.chat.messages.at(-1).nativeAnchor
  assert.equal(plan(h).status, 'intact', 'text fallback normalizes the same way')
})

test('失败、中断或仍在进行的回合留在末尾：交给失败回合重放处理，不算残留', () => {
  for (const reason of ['error', 'aborted', null]) {
    const h = game(2, { id: 'failed-' + reason })
    appendSessionEvent(h.session, 'turn/start', { turn: 9 })
    appendSessionEvent(h.session, 'user/message', { id: 'in-9', role: 'user', content: [{ type: 'text', text: '被拦截的输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    appendSessionEvent(h.session, 'assistant/message', { turn: 9, step: 1, message: { id: 'out-9', role: 'assistant', content: [{ type: 'text', text: '半截' }], source: model } }, { surfaceOp: 'append', sourceEventSeqs: [] })
    if (reason) appendSessionEvent(h.session, 'turn/end', { turn: 9, reason: { kind: reason } })
    assert.equal(plan(h).status, 'intact', String(reason))
  }
})

test('缺 turn 的旧档行修复后写回新锚点，编辑竞争仍保留旧锚点', () => {
  const stale = { turn: 8, input: 80, reply: 81 }
  const current = { nativeSync: { status: 'stale' }, messages: [
    { role: 'assistant', text: '未变正文', nativeAnchor: stale },
    { role: 'assistant', text: '并发新正文', nativeAnchor: stale }
  ] }
  const repaired = { messages: [{ role: 'assistant', text: '未变正文' }, { role: 'assistant', text: '修复时正文' }] }
  const anchor = { turn: 2, input: 10, reply: 11 }
  assert.equal(recordNativeSurfaceRepair(current, repaired, [
    { messageIndex: 0, anchor, replyTurn: 2 }, { messageIndex: 1, anchor, replyTurn: 2 }
  ]), true)
  assert.equal(current.messages[0].nativeAnchor, anchor)
  assert.equal(current.messages[1].nativeAnchor, stale)
  assert.equal(current.nativeSync, undefined)
})

test('分叉按轮投影到空白会话：每轮独立开启原生回合与步骤，不互相覆盖', () => {
  const source = game(3)
  const forkedChat = structuredClone(source.chat)
  const session = Session.create('seeded-fork-per-round', [], { ...source.session.header, id: 'seeded-fork-per-round', version: 4 })
  const result = repairNativeSurface(session, forkedChat, { repairId: 'seed-fork-per-round', perRound: true })
  assert.equal(result.applied, true)
  recordNativeSurfaceRepair(forkedChat, forkedChat, result.anchors)

  const events = sessionEvents(session)
  assert.equal(events.find(event => event.seq === session.surface.nodes[0]).type, 'system/message')
  assert.deepEqual(nodeTexts(session), ['', '开场', '行动2', '正文2', '行动3', '正文3', '行动4', '正文4'])

  // 每轮对应一个独立的 turn/start 与 step/start，且每个 assistant/message 落在各自轮次上。
  const turnStarts = events.filter(event => event.type === 'turn/start').map(event => event.data.turn)
  const stepStarts = events.filter(event => event.type === 'step/start').map(event => [event.data.turn, event.data.step])
  const assistantTurns = events.filter(event => event.type === 'assistant/message').map(event => [event.data.turn, event.data.step, textOf(event)])
  assert.deepEqual(turnStarts, [1, 2, 3, 4])
  assert.deepEqual(stepStarts, [[1, 1], [2, 1], [3, 1], [4, 1]])
  assert.deepEqual(assistantTurns, [[1, 1, '开场'], [2, 1, '正文2'], [3, 1, '正文3'], [4, 1, '正文4']])

  // 幂等、行计划、回退定位、以及后续回合续写均正常。
  assert.equal(planNativeSurfaceRepair({ chat: forkedChat, events, nodes: session.surface.nodes }).status, 'intact')
  assert.deepEqual(Object.keys(planTranscriptRows({ chat: forkedChat, events })), [])
  const lastRow = forkedChat.messages.at(-1)
  const rollbackTarget = locateRollbackSurface({ events, nodes: session.surface.nodes, anchor: lastRow.nativeAnchor })
  assert.equal(rollbackTarget.turn, 4)
  assert.equal(textOf(events.find(event => event.seq === rollbackTarget.assistantSeq)), '正文4')

  appendSessionEvent(session, 'turn/start', { turn: 5 })
  appendSessionEvent(session, 'step/start', { turn: 5, step: 1 })
  appendSessionEvent(session, 'system/message', { turn: 5, step: 1, message: {
    id: 'updated-system', role: 'system', content: [{ type: 'text', text: '提示词' }], source: { kind: 'system-prompt' }
  } }, { surfaceOp: 'append' })
  assert.doesNotThrow(() => Session.fromRestore(session.id, sessionEvents(session), session.header, 0, 'detached'))
})

test('分叉按轮投影含独立输入或跳号轮次时，映射、行计划、回退定位与重玩隔离均保持一致', () => {
  const base = Session.create('seeded-fork-gaps-base')
  const session = Session.create('seeded-fork-gaps', [], { ...base.header, id: 'seeded-fork-gaps', version: 4 })
  const chat = {
    id: 'chat-gaps', mode: 'story',
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场' },
      { role: 'user', text: '悬空输入' },
      { role: 'user', text: '行动5' },
      { role: 'assistant', turn: 5, text: '正文5' }
    ]
  }
  const result = repairNativeSurface(session, chat, { repairId: 'seed-gaps', perRound: true, seeded: true })
  assert.equal(result.applied, true)
  recordNativeSurfaceRepair(chat, chat, result.anchors)

  const events = sessionEvents(session)
  assert.deepEqual(events.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2, 3])
  assert.deepEqual(nodeTexts(session), ['', '开场', '悬空输入', '行动5', '正文5'])
  assert.equal(chat.regeneratedDshTurns[5], 3)
  assert.equal(chat.regeneratedDshTurns[1], undefined)
  assert.equal(chat.messages.at(-1).nativeAnchor.turn, 3)
  assert.equal(planNativeSurfaceRepair({ chat, events, nodes: session.surface.nodes }).status, 'intact')
  assert.doesNotThrow(() => Session.fromRestore(session.id, events, session.header, 0, 'detached'))

  const plan = planTranscriptRows({ chat, events })
  assert.equal(planShowsRow(plan, { turn: 1, kind: 'user' }), true)
  assert.equal(planShowsRow(plan, { turn: 1, kind: 'assistant-step' }), true)
  assert.equal(planShowsRow(plan, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(plan, { turn: 2, kind: 'assistant-step' }), false)
  assert.equal(planShowsRow(plan, { turn: 3, kind: 'user' }), true)
  assert.equal(planShowsRow(plan, { turn: 3, kind: 'assistant-step' }), true)
  assert.equal(planStoryTurn(plan, 3), 5)

  const rollbackTarget = locateRollbackSurface({ events, nodes: session.surface.nodes, anchor: chat.messages.at(-1).nativeAnchor })
  assert.equal(rollbackTarget.turn, 5)
  assert.equal(surfaceTurnOfSeq(events, rollbackTarget.assistantSeq), 3)
  assert.equal(textOf(events.find(event => event.seq === rollbackTarget.assistantSeq)), '正文5')

  // 回退删掉第 5 轮及前置悬空输入后，老的播种轮次全部隐藏。
  const rolledBackChat = { ...chat, messages: chat.messages.slice(0, 1) }
  const rolledBackPlan = planTranscriptRows({ chat: rolledBackChat, events })
  assert.equal(planShowsRow(rolledBackPlan, { turn: 1, kind: 'assistant-step' }), true)
  assert.equal(planShowsRow(rolledBackPlan, { turn: 2, kind: 'user' }), false)
  assert.equal(planShowsRow(rolledBackPlan, { turn: 3, kind: 'user' }), false)
  assert.equal(planShowsRow(rolledBackPlan, { turn: 3, kind: 'assistant-step' }), false)

  // 回退后继续游玩直到在第 5 号原生轮同号重玩第 5 轮时，旧播种输入不再误显示，新第 5 轮正常显示。
  const replayedChat = { ...rolledBackChat, messages: [...rolledBackChat.messages] }
  play(session, replayedChat, 4, false)
  play(session, replayedChat, 5, false)
  const replayedPlan = planTranscriptRows({ chat: replayedChat, events: sessionEvents(session) })
  assert.equal(planShowsRow(replayedPlan, { turn: 2, kind: 'user' }), false)
  assert.equal(planShowsRow(replayedPlan, { turn: 3, kind: 'user' }), false)
  assert.equal(planShowsRow(replayedPlan, { turn: 3, kind: 'assistant-step' }), false)
  assert.equal(planShowsRow(replayedPlan, { turn: 5, kind: 'user' }), true)
  assert.equal(planShowsRow(replayedPlan, { turn: 5, kind: 'assistant-step' }), true)
})

test('开场白前有独立输入触发轮号偏移时，recordNativeSurfaceRepair 不将开场白记入 regeneratedDshTurns', () => {
  const base = Session.create('seeded-greeting-offset-base')
  const session = Session.create('seeded-greeting-offset', [], { ...base.header, id: 'seeded-greeting-offset', version: 4 })
  const chat = {
    id: 'chat-greeting-offset', mode: 'story',
    messages: [
      { role: 'user', text: '开场前旁白' },
      { role: 'user', text: '启动指令' },
      { role: 'assistant', turn: 1, greeting: true, text: '开场正文' },
      { role: 'user', text: '行动2' },
      { role: 'assistant', turn: 2, text: '正文2' }
    ]
  }
  const result = repairNativeSurface(session, chat, { repairId: 'seed-greeting-offset', perRound: true, seeded: true })
  assert.equal(result.applied, true)
  recordNativeSurfaceRepair(chat, chat, result.anchors)
  assert.equal(chat.regeneratedDshTurns?.['1'], undefined)
  assert.equal(chat.regeneratedDshTurns?.['2'], 3)

  const plan = planTranscriptRows({ chat, events: sessionEvents(session) })
  assert.equal(planShowsRow(plan, { turn: 1, kind: 'user' }), true)
  assert.equal(planShowsRow(plan, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(plan, { turn: 2, kind: 'assistant-step' }), true)
  assert.equal(planShowsRow(plan, { turn: 3, kind: 'user' }), true)
  assert.equal(planShowsRow(plan, { turn: 3, kind: 'assistant-step' }), true)
})

test('存在未闭合原生回合时，perRound 修复拒绝写入并抛错', () => {
  const { session, chat } = game(1)
  appendSessionEvent(session, 'turn/start', { turn: 3 })
  chat.messages.push({ role: 'user', text: '新增' }, { role: 'assistant', turn: 3, text: '新回复' })
  assert.throws(
    () => repairNativeSurface(session, chat, { repairId: 'open-turn-reject', perRound: true, seeded: true }),
    /闭合/
  )
})

test('perRound 为 true 且无保留轮次需清空失效尾部时，占位清空节点写入有效且可恢复', () => {
  const { session, chat } = game(1)
  const emptyChat = { ...chat, messages: [] }
  const plan = planNativeSurfaceRepair({ chat: emptyChat, events: sessionEvents(session), nodes: session.surface.nodes })
  assert.equal(plan.status, 'full')
  assert.equal(plan.rounds.length, 0)
  const applied = applyNativeSurfaceRepair(session, emptyChat, plan, { repairId: 'clear-tail', perRound: true, seeded: true })
  assert.equal(applied.applied, true)
  const events = sessionEvents(session)
  const emptyEvent = events.at(-3)
  assert.equal(emptyEvent.type, 'assistant/message')
  assert.equal(emptyEvent.data.turn, events.at(-1).data.turn)
  assert.doesNotThrow(() => Session.fromRestore(session.id, events, session.header, 0, 'detached'))
})

test('无 turn 字段旧存档按轮播种与回退时，行计划准确推断并保持一致', () => {
  const base = Session.create('seeded-legacy-no-turn-base')
  const session = Session.create('seeded-legacy-no-turn', [], { ...base.header, id: 'seeded-legacy-no-turn', version: 4 })
  const chat = {
    id: 'chat-legacy-no-turn', mode: 'story',
    messages: [
      { role: 'assistant', greeting: true, text: '开场' },
      { role: 'user', text: '第2轮输入' },
      { role: 'assistant', text: '第2轮正文' },
      { role: 'user', text: '第3轮输入' },
      { role: 'assistant', text: '第3轮正文' }
    ]
  }
  const result = repairNativeSurface(session, chat, { repairId: 'seed-legacy', perRound: true, seeded: true })
  assert.equal(result.applied, true)
  const events = sessionEvents(session)
  const plan = planTranscriptRows({ chat, events })
  for (const turn of [1, 2, 3]) {
    assert.equal(planShowsRow(plan, { turn, kind: 'assistant-step' }), true)
  }
  assert.equal(planShowsRow(plan, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(plan, { turn: 3, kind: 'user' }), true)

  // 回退掉第 3 轮后，第 3 轮输入与回复同时隐藏。
  const rolledBack = { ...chat, messages: chat.messages.slice(0, 3) }
  const backPlan = planTranscriptRows({ chat: rolledBack, events })
  assert.equal(planShowsRow(backPlan, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(backPlan, { turn: 2, kind: 'assistant-step' }), true)
  assert.equal(planShowsRow(backPlan, { turn: 3, kind: 'user' }), false)
  assert.equal(planShowsRow(backPlan, { turn: 3, kind: 'assistant-step' }), false)
})

test('分叉含多条前置 standalone 与末尾 standalone 输入时，部分回退及后续游玩显隐准确', () => {
  const base = Session.create('seeded-multi-standalone-base')
  const session = Session.create('seeded-multi-standalone', [], { ...base.header, id: 'seeded-multi-standalone', version: 4 })
  const chat = {
    id: 'chat-multi-standalone', mode: 'story',
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场' },
      { role: 'user', text: '前置1' },
      { role: 'user', text: '前置2' },
      { role: 'user', text: '正式4' },
      { role: 'assistant', turn: 4, text: '正文4' },
      { role: 'user', text: '末尾悬空' }
    ]
  }
  const result = repairNativeSurface(session, chat, { repairId: 'seed-multi-standalone', perRound: true, seeded: true })
  assert.equal(result.applied, true)
  const events = sessionEvents(session)
  // 轮次分配：1=开场, 2=前置1, 3=前置2, 4=正式4+正文4, 5=末尾悬空
  const fullPlan = planTranscriptRows({ chat, events })
  assert.equal(planShowsRow(fullPlan, { turn: 1, kind: 'assistant-step' }), true)
  assert.equal(planShowsRow(fullPlan, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(fullPlan, { turn: 3, kind: 'user' }), true)
  assert.equal(planShowsRow(fullPlan, { turn: 4, kind: 'user' }), true)
  assert.equal(planShowsRow(fullPlan, { turn: 4, kind: 'assistant-step' }), true)
  assert.equal(planShowsRow(fullPlan, { turn: 5, kind: 'user' }), true)

  // 回退删掉末尾悬空与一条前置 standalone（模拟存档中 story 4 仅余 2 条输入）：
  const trimmedChat = { ...chat, messages: [chat.messages[0], chat.messages[2], chat.messages[3], chat.messages[4]] }
  const trimmedPlan = planTranscriptRows({ chat: trimmedChat, events })
  assert.equal(planShowsRow(trimmedPlan, { turn: 2, kind: 'user' }), false)
  assert.equal(planShowsRow(trimmedPlan, { turn: 3, kind: 'user' }), true)
  assert.equal(planShowsRow(trimmedPlan, { turn: 4, kind: 'user' }), true)
  assert.equal(planShowsRow(trimmedPlan, { turn: 4, kind: 'assistant-step' }), true)
  assert.equal(planShowsRow(trimmedPlan, { turn: 5, kind: 'user' }), false)

  // 继续正常玩一轮（nativeTurn 6 发出并完成）后，末尾悬空输入依然展示且新轮正常展示。
  const playedChat = { ...chat, messages: [...chat.messages] }
  play(session, playedChat, 6, false)
  const playedPlan = planTranscriptRows({ chat: playedChat, events: sessionEvents(session) })
  assert.equal(planShowsRow(playedPlan, { turn: 5, kind: 'user' }), true)
  assert.equal(planShowsRow(playedPlan, { turn: 6, kind: 'user' }), true)
  assert.equal(planShowsRow(playedPlan, { turn: 6, kind: 'assistant-step' }), true)
})
