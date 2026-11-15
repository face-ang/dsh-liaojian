import React, { useEffect, useRef, useState } from 'react'
import { dateLabel, PAGE_SIZE, shiftDay } from '../shared.js'
import { copyText, downloadText, request } from './api.js'
import { ArchiveLink, Badge, Empty, IconButton, Kind, Message, number } from './components.jsx'
import { Icon } from './icons.jsx'
import { renderMarkdown } from './markdown.js'

const statsLabels = { messages: '消息', chats: '会话', observations: '精选观察', self: '我的发言' }

function headingFor(report, weekly) {
  return weekly ? `${dateLabel(report.start)}至${dateLabel(report.end)}，本周重点` : `${dateLabel(report.start)}，值得关注的事`
}

export async function exportReport({ report, period, sessionResults }) {
  const weekly = period === 'weekly'
  const lines = [`# ${headingFor(report, weekly)}`, '', report.summary, '',
    ...Object.entries(statsLabels).map(([key, label]) => `- ${label}：${number(report.stats[key])}`), '']
  const [items, results] = await Promise.all([
    Promise.all(report.highlights.map(({ id }) => request('observation', { id }))),
    Promise.all(sessionResults.map(({ id }) => request('sessionResult', { id }))),
  ])
  for (const item of items) {
    lines.push(`## ${item.title}`, '', item.summary, '', `会话：${item.chat} · ${item.day} ${item.time}`, '')
    if (item.nextStep) lines.push(`下一步：${item.nextStep}`, '')
    for (const source of item.sources) {
      lines.push(`> ${source.sender} · ${source.day} ${source.time} · ${source.filename} 第 ${source.seq} 条`,
        ...source.text.split('\n').map(line => `> ${line}`), '')
    }
  }
  if (results.length) lines.push('## 微信流分析', '')
  for (const { reply, archives } of results) {
    lines.push(`原始归档 ${archives.map(file => file.filename).join('、')}`, '', reply, '')
  }
  downloadText(`聊笺-${weekly ? '周报' : '日报'}-${report.start}.md`, lines.join('\n'))
}

export function Report({ data, open, openResult, showIntake, generating, generate }) {
  const weekly = data.period === 'weekly'
  const report = data.report
  const title = headingFor(report, weekly)
  const highlights = report.highlights
  const following = highlights.filter(item => !item.done && ['related', 'opportunity'].includes(item.category)).slice(0, 3)
  const reading = highlights.filter(item => !following.includes(item))
  return <article className="lj-reading lj-report">
    <div className="lj-kicker"><Icon name="spark" size={15} />
      <span>{weekly ? '每周简报' : '每日简报'} · {report.start}{weekly ? ` — ${report.end}` : ''}</span>
      {report.generatedAt && <span className="lj-kicker-note">· 已汇总</span>}
    </div>
    <h1>{title}</h1>
    <p className="lj-lede">{report.summary || (report.stats.messages ? '可在所有会话回看原始消息。'
      : data.sessionResults.length ? '已收录 DSH 会话分析。待归类的附件可在「所有会话」中指定归属。' : '这段时间还没有收到聊天归档。')}</p>
    <dl className="lj-stats" aria-label="简报统计">
      {Object.entries(statsLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{number(report.stats[key])}</dd></div>)}
    </dl>
    {highlights.length > 0 ? <>
      {following.length > 0 && <section className="lj-priorities">
        <h2><Icon name="spark" />先看这几件事</h2>
        <ol>{following.map((item, index) => <li key={item.id}>
          <button type="button" data-reading-link={item.id} onClick={() => open(item.id)}>
            <span className="lj-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{item.title}</strong>{item.nextStep && <small>{item.nextStep}</small>}</span>
            <Icon name="right" size={15} />
          </button>
        </li>)}</ol>
      </section>}
      {reading.length > 0 && <section className="lj-highlights">
        <header><h2>精选观察</h2><span>{reading.length} 条</span></header>
        {reading.map(item => <button key={item.id} type="button" className="lj-highlight" data-reading-link={item.id}
          onClick={() => open(item.id)}>
          <span><Badge id={item.category} /><strong>{item.title}</strong></span>
          <small>{item.summary}</small>
        </button>)}
      </section>}
    </> : !report.stats.messages && !data.sessionResults.length ? <Empty icon="inbox" title="还没有收到微信流分析"
      action={<button type="button" className="lj-primary" onClick={showIntake}>查看转发设置</button>}>
      将聊天记录转发到 DeepSeek Harness 会话，再点输入框下方的「存入聊笺」。
    </Empty> : !data.sessionResults.length && <Empty icon="file" title="暂无观察">可以回看原始会话，或在归档记录中查看分析进度。</Empty>}
    {data.sessionResults.length > 0 && <section className="lj-highlights">
      <header><h2>DSH 会话分析</h2><span>{data.sessionResults.length} 份</span></header>
      {data.sessionResults.map(result => <button key={result.id} type="button" className="lj-highlight"
        data-reading-link={result.id} onClick={() => openResult(result.id)}>
        <span><Icon name="file" /><strong>{result.chat ?? result.filename}</strong></span>
        <small>{dateLabel(result.day)} · {result.fileCount} 个原始附件{result.pending > 0 && ` · ${result.pending} 份待归类`}</small>
      </button>)}
    </section>}
    {(report.stats.messages > 0 || report.stats.observations > 0) && <footer className="lj-report-footer">
      <span><Icon name="spark" size={14} />来自会话与观察</span>
      <button type="button" className="lj-text-button" disabled={generating} onClick={generate}>
        <Icon name="refresh" size={14} />{generating ? '正在汇总…' : '立即汇总'}
      </button>
    </footer>}
  </article>
}

export function SessionResult({ id, refresh, openChat, assign, toast }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    request('sessionResult', { id }, { signal: controller.signal }).then(setResult)
      .catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => controller.abort()
  }, [id, refresh])

  if (error) return <Empty icon="alert" title="分析结果加载失败">{error}</Empty>
  if (!result) return <p className="lj-reading lj-loading" role="status">正在读取微信流分析…</p>
  return <article className="lj-reading lj-detail">
    <div className="lj-kicker"><Icon name="spark" />微信流分析 · {result.day}</div>
    <h1>{result.archives[0]?.chat && result.archives.every(file => file.chat === result.archives[0].chat)
      ? result.archives[0].chat : '会话分析'}</h1>
    <div className="lj-detail-actions">
      <button type="button" className="lj-text-button" onClick={() => copyText(result.reply)
        .then(() => toast('分析已复制')).catch(error => toast(error.message))}>
        <Icon name="copy" />复制分析
      </button>
      <button type="button" className="lj-text-button" onClick={() => downloadText(`聊笺-${result.day}-会话分析.md`, result.reply)}>
        <Icon name="download" />导出分析
      </button>
    </div>
    <div className="lj-session-reply" dangerouslySetInnerHTML={{ __html: renderMarkdown(result.reply) }} />
    <section className="lj-original">
      <header><h2>原始归档</h2></header>
      {result.archives.map(file => <div key={file.id} className="lj-message">
        <header><strong>{file.status === 'pending' ? '待归类' : file.chat}</strong><span>{file.filename}</span></header>
        <footer>
          {file.status === 'pending'
            ? <button type="button" className="lj-text-button" onClick={() => assign(file)}>选择归属</button>
            : <button type="button" className="lj-text-button" data-reading-link={file.id}
              onClick={() => openChat(file.chatId, file.id)}>查看聊天记录</button>}
          <ArchiveLink id={file.id} filename={file.filename} />
        </footer>
      </div>)}
    </section>
  </article>
}

export function Observation({ item, toggle, marking, source, copy, edit, remove }) {
  return <article className="lj-reading lj-detail">
    <div className="lj-kicker"><Badge id={item.category} /><Kind kind={item.kind} /><span>{dateLabel(item.day)} · {item.time}</span>
      {item.origin === 'manual' && <span>手动添加</span>}
    </div>
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
      <button type="button" className="lj-text-button" disabled={marking} onClick={() => edit(item)}><Icon name="pen" />编辑观察</button>
      <button type="button" className="lj-text-button lj-danger" disabled={marking} onClick={() => remove(item)}>
        <Icon name="trash" />删除观察
      </button>
    </div>
    <div className="lj-findings">
      <section><h2>信息摘要</h2><p>{item.summary}</p></section>
      {item.importance && <section><h2>为什么值得关注</h2><p>{item.importance}</p></section>}
      {item.nextStep && <section className="lj-next"><h2><Icon name="check" />建议下一步</h2><p>{item.nextStep}</p></section>}
    </div>
    {item.sources.length > 0 && <section className="lj-original">
      <header><h2>原消息</h2><span>{item.sources.length} 条来源</span></header>
      {item.sources.map(message => <Message key={message.id} item={message} actions={<>
        <button type="button" className="lj-text-button" data-reading-link={message.id} onClick={() => source(message)}>
          查看上下文<Icon name="right" size={13} />
        </button>
        <ArchiveLink id={message.archiveId} filename={message.filename} />
      </>} />)}
    </section>}
  </article>
}

export function Chat({ target, refresh, query, edit, upload }) {
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
      {!page.items.length && (query ? <Empty icon="search" title="没有匹配的消息">可以试试其他关键词。</Empty>
        : <Empty icon="chat" title="还没有消息" action={<button type="button" className="lj-secondary" onClick={() => upload(page.chat)}>
          <Icon name="upload" />导入 ZIP
        </button>} />)}
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
