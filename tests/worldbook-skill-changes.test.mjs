import test from 'node:test'
import assert from 'node:assert/strict'
import { appendWorldbookSkillChanges } from '../tavern-plugin/lib/domain/worldbook-skill-changes.js'
function payload(events = []) {
  const session = { id: 'game', events, append(type, data) { const event = { seq: this.events.length, type, data }; this.events.push(event); return event } }
  return { agent: { session }, messages: [] }
}
const snapshot = (version, entries) => ({ version, directory: '/skills/' + version, entries })
const entry = (ref, hash) => ({ ref, hash, title: '资料' + ref })
 test('initial snapshot rides the existing input; native host owns the single durable write', () => {
  const p = payload(), input = { id: 'user-1', role: 'user', content: [{type:'text',text:'继续'}], source:{kind:'user'} }
  p.messages.push(input)
  const a = snapshot('a', [entry('1', 'old')])
  assert.equal(appendWorldbookSkillChanges(p,a),null)
  assert.equal(p.messages.length,1)
  assert.equal(input.content[0].text,'继续')
  assert.equal(p.agent.session.events.length,0)
  p.agent.session.append('user/message',structuredClone(p.messages[0])); p.messages=[]
  assert.equal(appendWorldbookSkillChanges(p,a),null)
  const b=snapshot('b',[entry('1','new')])
  const notice=appendWorldbookSkillChanges(p,b)
  assert.match(notice.content[0].text,/改写（1 条）/)
  assert.equal(p.agent.session.events.length,1)
  assert.equal(p.messages.length,1)
  assert.equal(appendWorldbookSkillChanges(p,b),null)
  p.agent.session.append('user/message',notice)
  const restarted=payload(structuredClone(p.agent.session.events))
  assert.equal(appendWorldbookSkillChanges(restarted,b),null)
})

function surfaceSession() {
  const events = []
  return {
    id: 'game',
    events,
    surface: { nodes: [] },
    append(type, data, intent) {
      const event = { seq: events.length, type, data }
      events.push(event)
      if (intent?.surfaceOp === 'append') this.surface.nodes.push(event.seq)
      return event
    }
  }
}

test('rewound baseline outside surface.nodes triggers directory-change notice and stale tool results recover', () => {
  const session = surfaceSession()
  const oldSnapshot = { version: 'old-v1', directory: '/old/worldbook-files/1_1', entries: [entry('1', 'same')] }
  const newSnapshot = { version: 'new-v1', directory: '/new/worldbook-files/1_1', entries: [entry('1', 'same')] }

  // 场景 1：旧基线仍在活跃表面，新目录通知已在历史事件中被撤回移出 surface.nodes
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '旧回合' }], source: { kind: 'user', worldbookSkills: oldSnapshot } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'u2-retracted', role: 'user', content: [{ type: 'text', text: '已撤回' }], source: { kind: 'plugin:dsh-tavern', worldbookSkills: newSnapshot } })

  const p1 = { agent: { session }, messages: [{ id: 'u3', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }] }
  const notice1 = appendWorldbookSkillChanges(p1, newSnapshot)
  assert.ok(notice1, '已撤回的未来基线不得阻止重新下发目录变更提醒')
  assert.match(notice1.content[0].text, /目录已变，旧绝对路径不再适用；用 worldbook_grep 或 worldbook_list 重新定位/)

  // 场景 2：模拟 Turn 4 清理 + Turn 6/9 保留旧世界书工具结果 + Turn 19 迁目录后连同通知被撤回
  const fork = surfaceSession()
  fork.append('user/message', { id: 'u-cleaned', role: 'user', content: [{ type: 'text', text: '清理轮' }], source: { kind: 'user', worldbookSkills: oldSnapshot } })
  const callId = 'call-wb-list'
  fork.append('assistant/message', { turn: 6, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'worldbook_list', arguments: '{}' }] } }, { surfaceOp: 'append' })
  fork.append('tool/result', { turn: 6, step: 1, message: { role: 'tool', toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify({
    directory: '/old/worldbook-files/1_1',
    directories: ['/old/worldbook-files/1_1'],
    version: 'old-view',
    files: [{ path: '/old/worldbook-files/1_1/常驻资料/媚华舰娘.md' }]
  }) }] } }, { surfaceOp: 'append' })
  // 非世界书普通 JSON 工具结果和已撤回的新目录通知不得干扰判断
  fork.append('assistant/message', { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'other', name: 'tavern_read_variables', arguments: '{}' }] } }, { surfaceOp: 'append' })
  fork.append('tool/result', { turn: 7, step: 1, message: { role: 'tool', toolCallId: 'other', isError: false, content: [{ type: 'text', text: JSON.stringify({ directory: '/new/worldbook-files/1_1', directories: ['/new/worldbook-files/1_1'], version: 'x', files: [] }) }] } }, { surfaceOp: 'append' })
  fork.append('user/message', { id: 'u-retracted-notice', role: 'user', content: [{ type: 'text', text: '被撤回通知' }], source: { kind: 'plugin:dsh-tavern', worldbookSkills: newSnapshot } })

  const p2 = { agent: { session: fork }, messages: [{ id: 'u-next', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }] }
  const notice2 = appendWorldbookSkillChanges(p2, newSnapshot)
  assert.ok(notice2, '活跃工具输出仍指向旧目录时必须提醒目录已变，不能静默挂载 carrier')
  assert.match(notice2.content[0].text, /目录已变，旧绝对路径不再适用；用 worldbook_grep 或 worldbook_list 重新定位/)
  assert.equal(p2.messages.at(-1), notice2)
  fork.append('user/message', notice2, { surfaceOp: 'append' })

  const p3 = { agent: { session: fork }, messages: [{ id: 'u-after', role: 'user', content: [{ type: 'text', text: '下一轮' }], source: { kind: 'user' } }] }
  assert.equal(appendWorldbookSkillChanges(p3, newSnapshot), null, '新基线已在活跃面后不再重复提醒')
})

test('cleaned initial carrier rebinds silently and retracted history does not emit for empty snapshot', () => {
  const session = surfaceSession()
  const snap = snapshot('a', [entry('1', 'body')])
  session.append('user/message', { id: 'cleaned', role: 'user', content: [{ type: 'text', text: '首轮失败' }], source: { kind: 'user', worldbookSkills: snap } })

  const nextInput = { id: 'retry', role: 'user', content: [{ type: 'text', text: '再试' }], source: { kind: 'user' } }
  const p = { agent: { session }, messages: [nextInput] }
  assert.equal(appendWorldbookSkillChanges(p, snap), null)
  assert.deepEqual(p.messages[0].source.worldbookSkills, snap, '首轮载体离开活跃面后，下轮应重新挂载基线到当前输入')

  // 空快照且仅历史中有已撤回的基线时不得输出无意义的撤回提醒
  const empty = { version: 'empty', directory: '', entries: [] }
  const retractedSession = surfaceSession()
  retractedSession.append('user/message', { id: 'gone', role: 'user', content: [{ type: 'text', text: '已撤回' }], source: { kind: 'user', worldbookSkills: snap } })
  assert.equal(appendWorldbookSkillChanges({ agent: { session: retractedSession }, messages: [nextInput] }, empty), null)
})

test('installWorldbookSkillRead guides model to rediscover paths on out-of-scope or stale reads', async () => {
  const { installWorldbookSkillRead } = await import('../tavern-plugin/lib/domain/worldbook-skill-read.js')
  let handler
  const ctx = { on: (name, fn) => { if (name === 'tools/execute') handler = fn; return () => {} } }
  let virtual = true
  const provider = {
    ownsPath: filePath => String(filePath || '').startsWith('/current/worldbook-files/'),
    authorizeRead: async filePath => filePath === '/current/worldbook-files/valid.md'
  }
  installWorldbookSkillRead(ctx, provider, { virtualOnly: async () => virtual })

  const runRead = filePath => handler({ name: 'read', arguments: { file_path: filePath }, agent: { session: { id: 's1' } } }, async () => 'passed-through')

  await assert.rejects(runRead('/old-root/worldbook-files/stale.md'), /This game’s read tool is limited to its generated worldbook files\. Use worldbook_list or worldbook_grep for current paths\./)
  await assert.rejects(runRead('/current/worldbook-files/outdated.md'), /Worldbook resource is unknown or no longer available in this game\. Use worldbook_list or worldbook_grep for current paths\./)
  assert.equal(await runRead('/current/worldbook-files/valid.md'), 'passed-through')

  virtual = false
  assert.equal(await runRead('/workspace/ordinary.txt'), 'passed-through')
})
