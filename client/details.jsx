import React, { useEffect, useRef, useState } from 'react'
import { dateLabel, PAGE_SIZE, shiftDay } from '../shared.js'
import { downloadText, request } from './api.js'
import { ArchiveLink, Badge, Empty, IconButton, Kind, Message, number } from './components.jsx'
import { Icon } from './icons.jsx'

const statsLabels = { messages: '消息', chats: '会话', observations: '精选观察', self: '我的发言' }

function headingFor(report, weekly) {
  return weekly ? `${dateLabel(report.start)}至${dateLabel(report.end)}，本周重点` : `${dateLabel(report.start)}，值得关注的事`
}

export async function exportReport(report, weekly) {
  const lines = [`# ${headingFor(report, weekly)}`, '', report.summary, '',
    ...Object.entries(statsLabels).map(([key, label]) => `- ${label}：${number(report.stats[key])}`), '']
  const items = await Promise.all(report.highlights.map(({ id }) => request('observation', { id })))
  for (const item of items) {
    lines.push(`## ${item.title}`, '', item.summary, '', `会话：${item.chat} · ${item.day} ${item.time}`, '')
    if (item.nextStep) lines.push(`下一步：${item.nextStep}`, '')
    for (const source of item.sources) {
      lines.push(`> ${source.sender} · ${source.day} ${source.time} · ${source.filename} 第 ${source.seq} 条`,
        ...source.text.split('\n').map(line => `> ${line}`), '')
    }
  }
  downloadText(`聊笺-${weekly ? '周报' : '日报'}-${report.start}.md`, lines.join('\n'))
}

export function Report({ data, open, upload, generating, generate }) {
  const weekly = data.period === 'weekly'
  const report = data.report
  const title = headingFor(report, weekly)
  const highlights = report.highlights
  const candidates = highlights.filter(item => item.category !== 'self')
  const actionable = candidates.filter(item => item.nextStep || item.priority >= 2)
  const following = (actionable.length ? actionable : candidates).slice(0, 3)
  return <article className="lj-reading lj-report">
    <div className="lj-kicker"><Icon name="spark" size={15} />
      <span>{weekly ? '每周简报' : '每日简报'} · {report.start}{weekly ? ` — ${report.end}` : ''}</span>
      {report.generatedAt && <span className="lj-kicker-note">· 已汇总</span>}
    </div>
    <h1>{title}</h1>
    <p className="lj-lede">{report.summary || (report.stats.messages ? '这段时间的聊天已整理入库，可以在所有会话中回看。' : '这段时间还没有收到聊天归档。')}</p>
    <dl className="lj-stats" aria-label="简报统计">
      {Object.entries(statsLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{number(report.stats[key])}</dd></div>)}
    </dl>
    {highlights.length > 0 ? <>
      {following.length > 0 && <section className="lj-priorities">
        <h2><Icon name="spark" />先看这几件事</h2>
        <ol>{following.map((item, index) => <li key={item.id}>
          <button type="button" onClick={() => open(item.id)}>
            <span className="lj-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{item.title}</strong>{item.nextStep && <small>{item.nextStep}</small>}</span>
            <Icon name="right" size={15} />
          </button>
        </li>)}</ol>
      </section>}
      <section className="lj-highlights">
        <header><h2>值得展开阅读</h2><span>{highlights.length} 条重点</span></header>
        {highlights.map(item => <button key={item.id} type="button" className="lj-highlight" onClick={() => open(item.id)}>
          <span><Badge id={item.category} /><strong>{item.title}</strong></span>
          <small>{item.summary}</small>
        </button>)}
      </section>
    </> : !report.stats.messages ? <Empty icon="inbox" title="简报等你带来第一份消息"
      action={<button type="button" className="lj-primary" onClick={upload}><Icon name="upload" />导入微信 ZIP</button>}>
      在微信里选中消息并合并转发。微信流投递的 ZIP 也会出现在导入记录里。
    </Empty> : <Empty icon="file" title="暂无观察">可以回看原始会话，或在导入记录中查看分析进度。</Empty>}
    {report.stats.messages > 0 && <footer className="lj-report-footer">
      <span><Icon name="spark" size={14} />基于导入消息的 AI 摘要</span>
      <button type="button" className="lj-text-button" disabled={generating} onClick={generate}>
        <Icon name="refresh" size={14} />{generating ? '正在汇总…' : '立即汇总'}
      </button>
    </footer>}
  </article>
}

export function Observation({ item, toggle, marking, source, copy }) {
  return <article className="lj-reading lj-detail">
    <div className="lj-kicker"><Badge id={item.category} /><Kind kind={item.kind} /><span>{dateLabel(item.day)} · {item.time}</span></div>
    <h1>{item.title}</h1>
    <p className="lj-detail-chat"><Icon name="chat" size={15} />{item.chat}</p>
    <div className="lj-detail-actions">
      <button type="button" className="lj-secondary" aria-pressed={Boolean(item.saved)} disabled={marking} onClick={() => toggle('saved')}>
        <Icon name="star" />{item.saved ? '已收藏' : '收藏'}
      </button>
      <button type="button" className="lj-secondary" aria-pressed={Boolean(item.done)} disabled={marking} onClick={() => toggle('done')}>
        <Icon name="check" />{item.done ? '已处理' : '标为已处理'}
      </button>
      <button type="button" className="lj-text-button" onClick={copy}><Icon name="copy" />复制观察</button>
    </div>
    <div className="lj-findings">
      <section><h2>信息摘要</h2><p>{item.summary}</p></section>
      {item.importance && <section><h2>为什么值得关注</h2><p>{item.importance}</p></section>}
      {item.nextStep && <section className="lj-next"><h2><Icon name="check" />建议下一步</h2><p>{item.nextStep}</p></section>}
    </div>
    <section className="lj-original">
      <header><h2>原消息</h2><span>{item.sources.length} 条来源</span></header>
      {item.sources.map(message => <Message key={message.id} item={message} actions={<>
        <button type="button" className="lj-text-button" onClick={() => source(message)}>
          查看上下文<Icon name="right" size={13} />
        </button>
        <ArchiveLink id={message.archiveId} filename={message.filename} />
      </>} />)}
    </section>
  </article>
}

export function Chat({ target, refresh, query, edit }) {
  const [page, setPage] = useState(null)
  const [error, setError] = useState('')
  const [offset, setOffset] = useState(null)
  const scroll = useRef(null)
  const [loading, setLoading] = useState(true)
  const firstAnchor = offset === null ? target.anchor : ''
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    request('chat', { id: target.id, offset: offset ?? 0, anchor: firstAnchor ?? '', q: target.anchor ? '' : query }, { signal: controller.signal })
      .then(setPage).catch(error => { if (!controller.signal.aborted) setError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [target.id, target.anchor, offset, firstAnchor, query, refresh])
  useEffect(() => {
    if (page && firstAnchor) scroll.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center' })
  }, [page, firstAnchor])

  if (error) return <Empty icon="alert" title="会话加载失败">{error}</Empty>
  if (!page) return <p className="lj-reading lj-loading" role="status">正在读取会话…</p>
  return <article className="lj-reading lj-detail" ref={scroll}>
    <div className="lj-kicker"><Icon name="chat" /><span>原始会话</span><Kind kind={page.chat.kind} /></div>
    <div className="lj-chat-heading"><h1>{page.chat.name}</h1>
      <IconButton icon="pen" label="编辑会话名称和类型" onClick={() => edit(page.chat)} />
    </div>
    <div className="lj-original">
      {!page.items.length && <Empty icon="search" title="没有匹配的消息">可以试试其他关键词。</Empty>}
      {page.items.map(item => <Message key={item.id} item={item} active={item.id === target.anchor}
        actions={<ArchiveLink id={item.archiveId} filename={item.filename} />} />)}
    </div>
    {(page.offset > 0 || page.next !== null) && <div className="lj-pages">
      <button type="button" className="lj-secondary" disabled={page.offset === 0 || loading}
        onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}>更新的消息</button>
      <button type="button" className="lj-secondary" disabled={page.next === null || loading}
        onClick={() => setOffset(page.next)}>更早的消息</button>
    </div>}
  </article>
}

export function dayHeading(day, today) {
  if (day === today) return '今天'
  if (day === shiftDay(today, -1)) return '昨天'
  return `周${'日一二三四五六'[new Date(`${day}T00:00:00Z`).getUTCDay()]}`
}
