import { isOwnerPrompt, wechatSceneInput } from '../shared.js'
import { sessionResultId } from './store.js'
import { UnavailableWechatDelivery, wechatBridgeArchive, wechatBridgeReady } from './wechat-bridge.js'

function observeTurn(state, event) {
  const { type, data } = event
  if (type === 'user/message' && event.surfaceOp === 'append') {
    if (data.source.kind !== 'user' && data.source.kind !== 'retry') return true
    const input = isOwnerPrompt(data.source) && wechatSceneInput(data.content)
    // A reply to a coalesced turn belongs to every prompt in that turn.
    if (!input) return false
    state.files.push(...input.files)
    state.references.push(...input.references)
    state.reply = ''
  } else if (type === 'assistant/message' && data.turn === state.turn && (state.files.length || state.references.length)) {
    const { message, interrupted } = data
    state.reply = interrupted || message.content.some(block => block.type === 'tool-call') ? ''
      : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n\n')
  }
  return true
}

const begin = event => ({ turn: event.data.turn, files: [], references: [], reply: '' })

export function watchSessionResults(ctx, workbench, ready = wechatBridgeReady()) {
  const active = new WeakMap()
  const captures = new Map()
  function archive(sessionId, event, state) {
    if (!state?.reply.trim() || event.data.turn !== state.turn || event.data.reason.kind !== 'completed') return
    const id = sessionResultId(sessionId, event.seq)
    if (captures.has(id)) return captures.get(id)
    const pending = workbench.captureSession({
      sessionId, endSeq: event.seq, time: event.time, reply: state.reply,
      files: [...state.references, ...state.files],
    }, async (file, signal) => {
      if (typeof file !== 'string') return { name: file.name, stream: ctx.attachments.readFileStream(file, signal) }
      try {
        return await wechatBridgeArchive(ready, file, signal)
      } catch (error) {
        if (!state.files.length || !(error instanceof UnavailableWechatDelivery)) throw error
        // An uploaded attachment remains accessible when the client and host have different disks.
        return null
      }
    })
    if (!pending) return
    const saved = pending.then(() => workbench.store.sessionResultLink(id)).finally(() => captures.delete(id))
    captures.set(id, saved)
    return saved
  }

  ctx.on('session/event', (session, event) => {
    if (session.header.origin === 'subagent') return
    if (event.type === 'turn/start') {
      active.set(session, begin(event))
      return
    }
    const state = active.get(session)
    if (!state) return
    if (event.type === 'turn/end') {
      active.delete(session)
      archive(session.id, event, state)?.catch(() => {})
    } else if (!observeTurn(state, event)) active.delete(session)
  })

  async function recoverTurn(sessionId, endSeq, signal) {
    const observation = await ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
    try {
      if (observation.header.origin === 'subagent' || endSeq < observation.inheritedEventCount) return
      const events = observation.events
      const end = events[endSeq]
      if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') return
      let start = endSeq - 1
      while (start >= observation.inheritedEventCount && events[start].type !== 'turn/start' && events[start].type !== 'turn/end') start--
      if (events[start]?.type !== 'turn/start' || start < observation.inheritedEventCount) return
      const state = begin(events[start])
      for (let at = start + 1; at < endSeq; at++) if (!observeTurn(state, events[at])) return
      return archive(sessionId, end, state)
    } finally {
      observation[Symbol.dispose]()
    }
  }

  return async function recover(sessionId, endSeq, signal) {
    const id = sessionResultId(sessionId, endSeq)
    const saved = workbench.store.sessionResultLink(id)
    if (saved) return saved
    try {
      return (await (captures.get(id) ?? recoverTurn(sessionId, endSeq, signal))) ?? null
    } catch (error) {
      if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
      throw error
    }
  }
}
