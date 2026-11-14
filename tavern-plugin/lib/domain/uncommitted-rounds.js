import { storyEventTurn } from './session-upgrade-references.js'
import { sessionEvents } from './session-events.js'
import { assistantResultForTurn } from './session-turn-result.js'
import { inputEventForTurn, isFailedTurnEnd } from './session-turn-input.js'
import { roundAnchor } from './round-anchor.js'

function contentText(message) {
  return (Array.isArray(message?.content) ? message.content : []).filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n').trim()
}

/**
 * Completed player rounds that the model saw but the story save never recorded,
 * after its latest committed round. Such a gap (#196) made regenerate, rollback
 * and body edits act on the wrong round for good; adopting it heals the save.
 * Rolled-back, failed, regenerate and replay rounds are never adopted.
 */
export function uncommittedRounds(session, header = {}) {
  const commits = header.nativeCommits && typeof header.nativeCommits === 'object' ? header.nativeCommits : {}
  const committed = Object.keys(commits).map(Number).filter(Number.isSafeInteger)
  // Legacy saves without commit records cannot be judged: leave them alone.
  if (!committed.length) return []
  const regenerated = header.regeneratedDshTurns && typeof header.regeneratedDshTurns === 'object' ? Object.values(header.regeneratedDshTurns).map(Number).filter(Number.isSafeInteger) : []
  const skipped = new Set([...(Array.isArray(header.suppressedDshTurns) ? header.suppressedDshTurns : []), ...regenerated].map(Number))
  // nativeCommits 的键与 regeneratedDshTurns 的值均是宿主原生轮号，与 turn/end、
  // inputEventForTurn、assistantResultForTurn 和 roundAnchor 同属原生轮坐标系。
  const latest = Math.max(...committed, ...regenerated)
  const nodes = new Set((session.surface?.nodes || []).map(Number))
  const rounds = []
  for (const event of sessionEvents(session)) {
    if (event?.type !== 'turn/end') continue
    const hostTurn = storyEventTurn(event)
    if (!(hostTurn > latest) || skipped.has(hostTurn) || isFailedTurnEnd(event.data?.reason?.kind)) continue
    const inputEvent = inputEventForTurn(session, hostTurn), input = inputEvent?.data
    if (!input || input.source?.kind !== 'user') continue
    const reply = assistantResultForTurn(session, hostTurn)
    // The reply must still be what the model sees: a rolled-back round is tombstoned.
    // 投影/修复写回会把正文换成新的 seq，位置变了但正文还在面上，就算仍然可见。
    if (!reply || reply.text === '') continue
    if (!nodes.has(Number(reply.event.seq)) && !surfaceShowsText(session, nodes, reply.text)) continue
    rounds.push({ turn: hostTurn, requestId: String(input.source.rpcId ?? '').trim(), userText: contentText(input), userContent: input.content || [], assistantText: reply.text, nativeAnchor: roundAnchor(hostTurn, inputEvent, reply.event) })
  }
  return rounds.sort((left, right) => left.turn - right.turn)
}

// A repaired/projected copy of the reply is the same reply: compare the text, not the seq.
function surfaceShowsText(session, nodes, wanted) {
  const compact = value => String(value ?? '').replace(/\s+/g, '')
  const target = compact(wanted)
  if (target === '') return false
  const events = sessionEvents(session)
  for (const seq of nodes) {
    const event = events.find(item => Number(item.seq) === Number(seq))
    if (!event || event.type !== 'assistant/message') continue
    if (compact(contentText(event.data?.message)) === target) return true
  }
  return target && false
}
