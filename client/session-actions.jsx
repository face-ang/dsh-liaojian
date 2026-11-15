import React, { useEffect, useState } from 'react'
import { DEFAULT_WECHAT_PROMPT, hasWechatSceneMarker, isOwnerPrompt, isZipName, MAX_ZIP_BYTES,
  wechatBridgePath, wechatPathMentions, wechatSceneInput, WECHAT_SCENE_MARKER } from '../shared.js'
import { request } from './api.js'
import { Mark } from './icons.jsx'

const controlStyle = `
.lj-session-controls { display: inline-flex; align-items: center; gap: 7px; flex-wrap: wrap; color: inherit; font-size: 12px }
.lj-session-control { display: inline-flex; align-items: center; gap: 5px; border: 1px solid currentColor;
  border-radius: 6px; padding: 3px 8px; background: transparent; color: inherit; cursor: pointer; font: inherit }
.lj-session-control:hover:not(:disabled) { background: color-mix(in srgb, currentColor 8%, transparent) }
.lj-session-control:disabled { opacity: .45; cursor: default }
.lj-session-notice { white-space: normal }
`

export function ArchiveSend({ useAccess, useInput, useSession, inputActions, resolveDraftAttachments, useFileUploads }) {
  const access = useAccess('session/prompt')
  const subagent = useSession(state => state.subagent)
  const draft = useInput(input => input.draft)
  const phase = useInput(input => input.phase)
  const attachmentIds = useInput(input => input.attachmentIds)
  const ready = useFileUploads(uploads => attachmentIds.every(id => uploads[id]?.status === 'ready'))
  const [error, setError] = useState('')
  const mentions = wechatPathMentions(draft)
  const references = mentions.map(mention => mention.path).filter(isZipName)
  const hasWechatPath = references.length > 0 && references.every(wechatBridgePath)
  const files = resolveDraftAttachments(attachmentIds)
  const hasZip = attachmentIds.length > 0 && files.length === attachmentIds.length &&
    files.every(file => file.kind === 'file' && isZipName(file.file.name) && file.file.size > 0 && file.file.size <= MAX_ZIP_BYTES)
  if (!access || subagent || (!hasWechatPath && !hasZip) || (attachmentIds.length > 0 && !hasZip)) return null

  function send() {
    setError('')
    const text = draft.trim()
    const onlyFiles = !mentions.reduce((value, { token }) => value.replace(token, ''), text).trim()
    const prefix = `${WECHAT_SCENE_MARKER} ${onlyFiles ? DEFAULT_WECHAT_PROMPT + ' ' : ''}`
    if (!hasWechatSceneMarker(text)) {
      const { draftRev } = inputActions.captureInsertion()
      if (!inputActions.insertText(prefix, { start: 0, end: 0, draftRev })) {
        setError('输入框正在更新，请再点一次。')
        return
      }
    }
    inputActions.submit()
  }

  return <span className="lj-session-controls">
    <style>{controlStyle}</style>
    <button className="lj-session-control" type="button" disabled={phase !== 'plain' || !ready}
      title={ready ? '发送本条微信记录，分析完成后自动归档' : '等待 ZIP 上传完成'} onClick={send}>
      <Mark size={16} />存入聊笺
    </button>
    {error && <span className="lj-session-notice" role="alert">{error}</span>}
  </span>
}

export function SessionResultAction({ sessionId, turn, useChat, openResult }) {
  const completed = turn.end?.data.reason.kind === 'completed'
  const endSeq = turn.end?.seq
  const hasScene = useChat(snapshot => completed && snapshot.locations.getTurn(turn.turn).some(key => {
    const node = snapshot.nodes.get(key)
    return (node?.kind === 'user' || node?.kind === 'steering')
      && isOwnerPrompt(node.data.source) && Boolean(wechatSceneInput(node.data.content))
  }))
  const [outcome, setOutcome] = useState(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!hasScene) return
    const controller = new AbortController()
    const current = { sessionId, endSeq, retry }
    request('sessionResultLink', {}, { body: { session: sessionId, endSeq }, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setOutcome({ ...current, result }) })
      .catch(error => { if (!controller.signal.aborted) setOutcome({ ...current, error: error.message }) })
    return () => controller.abort()
  }, [sessionId, hasScene, endSeq, retry])

  if (!hasScene) return null
  const current = outcome?.sessionId === sessionId && outcome.endSeq === endSeq && outcome.retry === retry ? outcome : null
  if (current && !current.result && !current.error) return null
  return <span className="lj-session-controls">
    <style>{controlStyle}</style>
    {current?.result ? <button className="lj-session-control" type="button" onClick={() => openResult(current.result)}>
      <Mark size={16} />在聊笺查看
    </button> : current?.error ? <>
      <span className="lj-session-notice" role="alert">{current.error}</span>
      <button className="lj-session-control" type="button" onClick={() => setRetry(value => value + 1)}>重试归档</button>
    </> : <span className="lj-session-notice" role="status">正在存入聊笺…</span>}
  </span>
}
