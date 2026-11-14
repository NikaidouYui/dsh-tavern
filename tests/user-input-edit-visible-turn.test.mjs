import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from './fixtures/client-vm.mjs'
import { sourceFunction } from './fixtures/source-function.mjs'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { planTranscriptRows } from '../tavern-plugin/lib/domain/transcript-row-plan.js'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
function loadClient() {
  const declarations = ['nodeTurn', 'latestTavernUserTurn', 'tavernPlanShowsRow'].map(name => sourceFunction(source, name)).join('\n');
  return vm.runInNewContext(declarations + '\n({ latestTavernUserTurn })');
}

function playTurn(session, turn, text) {
  appendSessionEvent(session, 'turn/start', { turn })
  const user = appendSessionEvent(session, 'user/message', { id: 'u' + turn, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r' + turn } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn, step: 1, message: { id: 'a' + turn, role: 'assistant', content: [{ type: 'text', text: '回复' + turn }], source: { kind: 'model', provider: 'f', model: 'f' } } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
  return user
}
function failedTurn(session, turn, text) {
  appendSessionEvent(session, 'turn/start', { turn })
  appendSessionEvent(session, 'user/message', { id: 'u' + turn, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r' + turn } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn, step: 1, message: { id: 'a' + turn, role: 'assistant', content: [{ type: 'text', text: '失败' }], source: { kind: 'model', provider: 'f', model: 'f' } } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'error' } })
}

test('回退后，编辑入口认的是页面剩下的最后一条输入，不是日志里被藏掉的那条', () => {
  const session = Session.create('user-input-visible-turn')
  playTurn(session, 1, '开始')
  playTurn(session, 2, '第一条输入')
  // A failed turn keeps its append nodes too; the plan hides it after it was cleared.
  failedTurn(session, 6, '失败轮输入')
  const rolledInput = playTurn(session, 10, '被回退的输入')
  const rolledReply = sessionEvents(session).findLast(event => event.type === 'assistant/message')
  replaceSessionSurface(session, 'assistant/message', {
    turn: 11, step: 1,
    message: { id: 'rollback', role: 'assistant', content: [], source: { kind: 'model', provider: 'f', model: 'f' } }
  }, { start: Number(rolledInput.seq), end: Number(rolledReply.seq), sourceEventSeqs: [rolledInput.seq, rolledReply.seq] })
  // What the host keeps: every append message node, including the one on screen no
  // longer because the row plan hides it.
  const nodes = []
  for (const event of sessionEvents(session)) {
    if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data?.source?.kind === 'user') nodes.push({ kind: 'user', seq: event.seq })
    else if (event.type === 'assistant/message' && event.surfaceOp === 'append') nodes.push({ kind: 'assistant', turn: Number(event.data?.turn) })
  }
  const plan = planTranscriptRows({
    chat: { messages: [
      { role: 'assistant', turn: 1, greeting: true },
      { role: 'user' },
      { role: 'assistant', turn: 2 }
    ] },
    events: sessionEvents(session)
  })
  assert.equal(plan['10']?.input, 0, '回退掉的输入行由行计划隐藏')
  assert.equal(plan['6']?.input, 0, '清掉的失败轮输入行同样隐藏')
  const client = loadClient()
  assert.equal(client.latestTavernUserTurn({ legacy: { nodes } }, { turns: plan, from: null }), 2)
  // Without the plan the old scan still walks to the hidden node; the view always
  // carries a plan in play mode, but the helper must not throw on a host without one.
  assert.equal(client.latestTavernUserTurn({ legacy: { nodes } }, null), 10)
})

async function loadTurnHistoryGuards() {
  const { parse } = await import('acorn')
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  let shownDecl = ''
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'VariableDeclaration' && node.declarations?.some(d => d.id?.name === 'tavernShownBodies')) {
      shownDecl = source.slice(node.start, node.end)
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object') visit(v)
    }
  }
  visit(ast)
  assert.ok(shownDecl, 'client.js 中应存在 tavernShownBodies 定义')
  const fnNames = ['tavernPlanBodyDigest', 'tavernPlanDrawsBodyElsewhere', 'tavernPlanErasesRow', 'tavernPlanErasesRowForRender']
  return vm.runInNewContext([
    shownDecl,
    ...fnNames.map(name => sourceFunction(source, name)),
    '({ tavernShownBodies, tavernPlanBodyDigest, tavernPlanDrawsBodyElsewhere, tavernPlanErasesRow, tavernPlanErasesRowForRender })',
  ].join('\n'), { Object, Map, Set, Number, String, Array })
}

test('客户端防抹除与撞号隔离：区分搬迁副本与同 story 独立撞号轮，支持二次重摇回查与真实回退精准擦除', async () => {
  const g = await loadTurnHistoryGuards()

  // 场景 1：跳号分叉轮 native=2 (story=7) 在重摇进行中遭遇脏计划隐藏正文且无别处无输入副本 -> 保护老第 2 轮不被擦白；
  // 即使后续撞号续聊轮 native=7 (story=7) 也已在屏幕展示且仍在正常绘制，也不能把带输入的独立撞号轮 7 当成 native=2 的搬迁目标。
  const sid1 = 'guard-collision-s'
  g.tavernShownBodies.remember(sid1, 2, 7)
  g.tavernShownBodies.remember(sid1, 7, 7)
  const dirtyCollisionPlan = {
    from: null,
    turns: {
      2: { input: 1, reply: 0 },
      7: { input: 1, reply: 1 },
    }
  }
  assert.equal(g.tavernPlanErasesRowForRender(sid1, dirtyCollisionPlan, 2, true), true, '撞号新轮 native=7 存在时，老分叉轮 native=2 重摇脏态必须受保护')
  assert.equal(g.tavernPlanErasesRowForRender(sid1, dirtyCollisionPlan, 2, false), false, '非重摇期间（用户主动删除）允许按计划隐藏')

  // 场景 1b：真实回退撞号新轮 native=7（{ input: 0, reply: 0 }）与真实回退老轮 native=2（{ input: 0, reply: 0 }） -> 即使在重摇态也精准允许擦除。
  const rollbackNewPlan = {
    from: null,
    turns: { 2: { input: 1, reply: 1, story: 7 }, 7: { input: 0, reply: 0 } }
  }
  assert.equal(g.tavernPlanErasesRowForRender(sid1, rollbackNewPlan, 7, true), false, '撞号新轮 7 自身输入已消亡时不误借用老第 2 轮输入而阻拦回退')
  const rollbackOldPlan = {
    from: null,
    turns: { 2: { input: 0, reply: 0 }, 7: { input: 1, reply: 1 } }
  }
  assert.equal(g.tavernPlanErasesRowForRender(sid1, rollbackOldPlan, 2, true), false, '老轮 2 输入已回退清零时不阻拦擦除')

  // 场景 1c：当 native=2 真正完成搬移（native=5 出现无输入副本 { input: 0, reply: 1, story: 7 }）时，允许旧行 native=2 收起正文。
  const movedPlan = {
    from: null,
    turns: {
      2: { input: 1, reply: 0 },
      5: { input: 0, reply: 1, story: 7 },
    }
  }
  assert.equal(g.tavernPlanDrawsBodyElsewhere(g.tavernPlanBodyDigest(movedPlan), movedPlan, 7, { excludeTurn: 2, sessionId: sid1 }), true)
  assert.equal(g.tavernPlanErasesRowForRender(sid1, movedPlan, 2, true), false)

  // 场景 2：二次重摇保护（native=5 曾作为 story=7 的无输入搬移副本显示过），再次重摇时 native=5 自身无 input，
  // 需顺沿 story=7 回查到仍在场上的原生输入轮 native=2 的 input，从而保护 native=5 不在二次重摇脏态下消失。
  const sid2 = 'guard-double-regen-s'
  g.tavernShownBodies.remember(sid2, 2, 7)
  g.tavernShownBodies.remember(sid2, 5, 7)
  const secondRegenDirtyPlan = {
    from: null,
    turns: {
      2: { input: 1, reply: 0 },
      5: { input: 0, reply: 0 },
    }
  }
  assert.equal(g.tavernPlanErasesRowForRender(sid2, secondRegenDirtyPlan, 5, true), true, '搬移副本 native=5 二次重摇应通过回查 native=2 输入得到保护')
})
