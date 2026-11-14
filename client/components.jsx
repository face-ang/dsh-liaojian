import React, { useEffect, useRef } from 'react'
import { categories, chatKinds } from '../shared.js'
import { Icon } from './icons.jsx'
import { archiveUrl } from './api.js'

export const cat = id => categories.find(item => item.id === id)
export const number = value => new Intl.NumberFormat('zh-CN').format(value ?? 0)
export const shortDate = day => day?.slice(5).replace('-', ' / ') ?? ''

export function IconButton({ icon, label, pressed, size, ...props }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={pressed} className="lj-icon-button" {...props}>
    <Icon name={icon} size={size} />
  </button>
}

export function Badge({ id }) {
  const item = cat(id)
  return item && <span className="lj-badge" data-category={id}><Icon name={item.icon} size={13} />{item.badge}</span>
}

export function Kind({ kind }) {
  return <span className="lj-kind" title={chatKinds[kind]}>
    <Icon name={kind === 'group' ? 'people' : kind === 'private' ? 'person' : 'chat'} size={14} />
    {chatKinds[kind]}
  </span>
}

export function Empty({ icon = 'file', title, children, action }) {
  return <div className="lj-empty">
    <span className="lj-empty-icon"><Icon name={icon} size={24} /></span>
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action}
  </div>
}

export function Dialog({ title, close, children, footer }) {
  const ref = useRef(null)
  useEffect(() => {
    const dialog = ref.current
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return <dialog ref={ref} className="lj-dialog" aria-labelledby="lj-dialog-title"
    onCancel={event => { event.preventDefault(); close() }}>
    <header><h2 id="lj-dialog-title">{title}</h2><IconButton icon="close" label="关闭" onClick={close} /></header>
    <div className="lj-dialog-body">{children}</div>
    {footer && <footer>{footer}</footer>}
  </dialog>
}

export function ArchiveLink({ id, filename, children }) {
  return <a className="lj-text-button" href={archiveUrl(id)} download={filename}>
    <Icon name="download" size={14} />{children ?? '原始 ZIP'}
  </a>
}

export function Message({ item, active, actions }) {
  return <article className="lj-message" data-message={item.id} data-active={Boolean(active)}>
    <header><strong>{item.sender}</strong><time>{item.day} {item.time}</time></header>
    <div className="lj-message-text">{item.text || '（空消息）'}</div>
    <footer>
      <span title={item.filename}>{item.filename} · 第 {item.seq} 条</span>
      {actions}
    </footer>
  </article>
}
