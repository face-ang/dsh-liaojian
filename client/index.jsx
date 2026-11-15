import React, { useEffect, useState } from 'react'
import { Workbench } from './workbench.jsx'
import { Mark } from './icons.jsx'
import { ArchiveSend, SessionResultAction } from './session-actions.jsx'
import css from './workbench.css'

const PANEL = 'liaojian'
export const name = 'liaojian-client'
export const inject = ['slots', 'layout', 'conversation']

export function apply(ctx) {
  let pendingResult
  const openResult = result => { pendingResult = result; ctx.layout.selectPanel(PANEL) }
  function Page() {
    const [entry] = useState(pendingResult)
    useEffect(() => { if (pendingResult === entry) pendingResult = undefined }, [entry])
    return <div className="lj-root" lang="zh-CN"><style>{css}</style><Workbench entry={entry} /></div>
  }
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL,
  }, Page)), 'liaojian: main panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 5, label: '聊笺',
  }, ({ size }) => <Mark size={size} />)), 'liaojian: navigation')
  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: PANEL, inject: () => ({ openResult }),
  }, SessionResultAction)), 'liaojian: session result link')
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: PANEL, order: 10,
    inject: () => ({
      resolveDraftAttachments: ids => ctx.conversation.resolveDraftAttachments(ids),
      hooks: { fileUploads: ctx.conversation.fileUploads },
    }),
  }, ArchiveSend)), 'liaojian: archive from composer')
}
