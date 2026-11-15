import { randomUUID } from 'node:crypto'
import { appendSessionEvent, sessionEvents } from './session-events.js'
import { promptSection } from './prompt-section.js'

const WORLDBOOK_LOOKUP_TOOLS = new Set(['worldbook_list', 'worldbook_grep'])

/** 仅按当前活跃消息面提取对模型可见的事件，无 surface 时兼容简化测试桩 */
function visibleSurfaceEvents(session) {
  const events = sessionEvents(session)
  if (!Array.isArray(session?.surface?.nodes)) return events
  const bySeq = new Map(events.map(event => [event.seq, event]))
  return session.surface.nodes.map(seq => bySeq.get(seq)).filter(Boolean)
}

/** 从当前活跃表面中提取最近一次世界书检索工具返回的工作目录 */
function visibleWorldbookToolDirectory(events) {
  const toolNames = new Map()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content || []) {
      if (block?.type === 'tool-call' && block.id && block.name) toolNames.set(block.id, block.name)
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'tool/result' || event.data?.error) continue
    const message = event.data?.message
    if (!message || message.isError) continue
    const toolName = toolNames.get(message.toolCallId)
    if (toolName && !WORLDBOOK_LOOKUP_TOOLS.has(toolName)) continue
    const text = (message.content || [])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
      .trim()
    if (!text.startsWith('{')) continue
    let parsed
    try { parsed = JSON.parse(text) } catch { continue }
    if (typeof parsed?.directory === 'string' && parsed.directory
      && Array.isArray(parsed.directories) && typeof parsed.version === 'string'
      && (Array.isArray(parsed.files) || Array.isArray(parsed.matches))) {
      return parsed.directory
    }
  }
  return null
}

/** Persist the comparison baseline in native history, outside model-visible text.
 * One batch notice per effective version survives restarts and turn retries. */
export function appendWorldbookSkillChanges(payload, snapshot) {
  if (!snapshot || !payload.agent?.session) return null
  const session = payload.agent.session
  const pending = Array.isArray(payload.messages) ? payload.messages : []
  const visible = visibleSurfaceEvents(session)
  const previous = [...pending].reverse().find(message => message.source?.worldbookSkills)?.source.worldbookSkills
    || [...visible].reverse().find(event => event.type === 'user/message' && event.data?.source?.worldbookSkills)?.data.source.worldbookSkills
  if (previous?.version === snapshot.version) return null
  // 若基线已被撤回或清理出当前消息面，检查活跃工具返回是否仍滞留在旧目录
  const visibleDirectory = !previous ? visibleWorldbookToolDirectory(visible) : null
  const hasStaleToolDirectory = Boolean(visibleDirectory && visibleDirectory !== snapshot.directory)
  if (!snapshot.entries.length && !previous && !hasStaleToolDirectory) return null
  const old = new Map((previous?.entries || []).map(entry => [entry.ref, entry]))
  const current = new Map(snapshot.entries.map(entry => [entry.ref, entry]))
  const added = snapshot.entries.filter(entry => !old.has(entry.ref))
  const changed = snapshot.entries.filter(entry => old.has(entry.ref) && (old.get(entry.ref).hash !== entry.hash || old.get(entry.ref).category !== entry.category))
  const removed = [...old.values()].filter(entry => !current.has(entry.ref))
  // Initial discovery needs only a durable baseline, not another prompt.
  if (!previous && !hasStaleToolDirectory && !snapshot.entries.some(entry => entry.category === '动态快照')) {
    const carrier = [...pending].reverse().find(message => message.role === 'user' && !message.source?.worldbookSkills)
    if (carrier) {
      // Native inbox/history messages may be frozen. Enrich a new envelope,
      // preserving the original message identity and content for host persistence.
      pending[pending.indexOf(carrier)] = { ...carrier, source: { ...carrier.source, worldbookSkills: snapshot } }
      return null
    }
  }
  const initialDynamic = !previous ? snapshot.entries.filter(entry => entry.category === '动态快照') : []
  const lines = []
  const describe = (label, entries) => {
    if (!entries.length) return
    lines.push(`${label}（${entries.length} 条）：` + entries.slice(0, 12).map(entry => String(entry.title).replace(/\s+/g, ' ').slice(0, 70)).join('；') + (entries.length > 12 ? '；其余请查当前目录' : ''))
  }
  if (initialDynamic.length) {
    describe('动态快照已就绪', initialDynamic)
    lines.push('动态快照已可检索，读取不会执行代码。')
  }
  if (previous) {
    describe('新增', added); describe('改写', changed); describe('撤回资料', removed)
    lines.push('改写、撤回项的旧资料失效；需要时重新检索。')
    if (previous.directory !== snapshot.directory) lines.push('目录已变，旧绝对路径不再适用；用 worldbook_grep 或 worldbook_list 重新定位。')
  } else if (hasStaleToolDirectory) {
    lines.push(snapshot.entries.length
      ? '目录已变，旧绝对路径不再适用；用 worldbook_grep 或 worldbook_list 重新定位。'
      : '当前已无可查阅的世界书文件，旧绝对路径不再适用。')
  }
  const message = { id: `tavern-worldbook-skills:${snapshot.version}:${randomUUID()}`, role: 'user', content: lines.length ? [{ type: 'text', text: promptSection('lorebook_files_update', lines.join('\n')) }] : [],
    source: { kind: 'plugin:dsh-tavern', worldbookSkills: snapshot } }
  // pre-step messages are persisted by the host when the step starts. Writing
  // both here and there creates duplicate surface rows for the same message.
  if (Array.isArray(payload.messages)) payload.messages.push(message)
  else appendSessionEvent(session, 'user/message', message, { surfaceOp: 'append' })
  return message
}
