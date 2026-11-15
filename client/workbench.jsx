import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { categories, mondayOf, shiftDay } from '../shared.js'
import { copyText, request } from './api.js'
import { cat, Empty, IconButton, Kind, number, shortDate } from './components.jsx'
import { Chat, dayHeading, exportReport, Observation, Report, SessionResult } from './details.jsx'
import { AssignArchiveDialog, ChatDialog, DeleteDialog, ImportDialog, InboxDialog, ObservationDialog, SettingsDialog } from './dialogs.jsx'
import { Icon, Mark } from './icons.jsx'
import { PaneDivider, usePaneWidths } from './panes.jsx'

const NAV_ORDER = ['related', 'learning', 'topic', 'opportunity', 'self']
const INBOX = { jobs: [], active: 0, pending: 0, inboxPath: '', inboxError: '' }
const REPORT = { type: 'report' }

function NavRow({ id, label, icon, count, current, onClick }) {
  return <button type="button" className="lj-nav-row" data-selected={current === id} data-category={id}
    aria-current={current === id ? 'page' : undefined} onClick={onClick}>
    <Icon name={icon} size={16} /><span>{label}</span>{count !== undefined && <small>{number(count)}</small>}
  </button>
}

function Navigation({ data, category, choose, inbox, show, close }) {
  const stats = data?.report.stats
  return <aside className="lj-sidebar" id="lj-sidebar" aria-label="聊笺分类">
    <div className="lj-brand"><Mark color size={36} /><strong>聊笺</strong>
      <IconButton icon="close" label="关闭分类" onClick={close} />
    </div>
    <nav className="lj-navigation">
      <div className="lj-nav-label">我的简报</div>
      <NavRow id="all" label="全部观察" icon="grid" count={stats?.observations ?? 0} current={category} onClick={() => choose('all')} />
      {NAV_ORDER.map(id => {
        const item = cat(id)
        return <NavRow key={id} id={id} label={item.label} icon={item.icon} count={stats?.groups[id] ?? 0}
          current={category} onClick={() => choose(id)} />
      })}
      <div className="lj-nav-label lj-nav-label-second">资料与收藏</div>
      <NavRow id="chats" label="所有会话" icon="chat" count={stats?.allChats ?? 0} current={category} onClick={() => choose('chats')} />
      <NavRow id="followup" label="跟进清单" icon="check" count={stats?.followup ?? 0} current={category} onClick={() => choose('followup')} />
      <NavRow id="saved" label="收藏" icon="star" count={stats?.saved ?? 0} current={category} onClick={() => choose('saved')} />
    </nav>
    <div className="lj-sidebar-bottom">
      <NavRow id="inbox" label="归档记录" icon="inbox" count={inbox.active + inbox.pending || undefined} onClick={() => show('inbox')} />
      <NavRow id="settings" label="工作台设置" icon="settings" onClick={() => show('settings')} />
    </div>
  </aside>
}

function DateStrip({ data, selectDay }) {
  const weekly = data.period === 'weekly'
  const available = new Set(weekly ? data.weeks : data.days.map(item => item.day))
  const base = weekly ? mondayOf(data.today) : data.today
  const step = weekly ? 7 : 1
  const start = data.day < shiftDay(base, -3 * step) || data.day > base ? data.day : base
  const dates = Array.from({ length: 4 }, (_, index) => shiftDay(start, -index * step))
  return <div className="lj-date-strip" aria-label={weekly ? '简报周次' : '简报日期'}>
    {dates.map(day => {
      const title = weekly ? day === base ? '本周' : day === shiftDay(base, -7) ? '上周' : '周报' : dayHeading(day, data.today)
      return <button type="button" key={day} className="lj-date" aria-pressed={data.day === day}
        aria-label={`${day} ${title}`} data-present={available.has(day)} onClick={() => selectDay(day)}>
        <strong>{title}</strong>
        <span>{shortDate(day)}</span>
        <small>{available.has(day) ? weekly ? '周报' : '日报' : '暂无简报'}</small>
      </button>
    })}
  </div>
}

function ItemRow({ item, chats, selected, open }) {
  const category = cat(item.category)
  const icon = chats ? 'chat' : item.priority === 3 ? 'alert' : category?.icon ?? 'file'
  return <button type="button" className="lj-result" data-selected={selected} aria-current={selected ? 'true' : undefined} onClick={() => open(item)}>
    <span className="lj-result-icon" data-category={item.category} data-urgent={item.priority === 3}><Icon name={icon} size={17} /></span>
    <span className="lj-result-content">
      <strong>{chats ? item.name : item.title}</strong>
      {!chats && <span className="lj-result-excerpt">{item.summary}</span>}
      <span className="lj-result-meta">
        <span>{chats ? `${number(item.count)} 条消息${item.day ? ` · ${shortDate(item.day)}` : ''}` : `${item.chat} · ${shortDate(item.day)}`}</span>
        {item.saved ? <Icon name="star" size={13} /> : null}
        {item.done ? <span className="lj-list-done"><Icon name="check" size={12} />已处理</span> : null}
        <Kind kind={item.kind} />
      </span>
    </span>
  </button>
}

function Rows({ items, chats, grouped, title, selected, choose, edit, collapsed, flip, countByCategory, next, more, loading, pending }) {
  if (!items.length && pending) return null
  if (!items.length) return <Empty icon={chats ? 'chat' : 'search'} title={loading ? '正在读取…' : chats ? '没有匹配的会话' : '暂无匹配的观察'} />
  const render = item => {
    const row = <ItemRow key={item.id} item={item} chats={chats} selected={selected.id === item.id} open={choose} />
    return chats ? <div className="lj-chat-row" key={item.id}>{row}
      <IconButton icon="pen" label={`标注会话 ${item.name}`} onClick={() => edit(item)} />
    </div> : row
  }
  return <>
    {grouped ? categories.map(item => {
      const rows = items.filter(row => row.category === item.id)
      if (!rows.length) return null
      return <section className="lj-group" key={item.id}>
        <h3><button type="button" data-category={item.id} aria-expanded={!collapsed[item.id]} onClick={() => flip(item.id)}>
          <Icon name={item.icon} size={16} />{item.label}<small>{countByCategory?.[item.id] ?? rows.length}</small>
          <Icon name={collapsed[item.id] ? 'right' : 'down'} size={13} />
        </button></h3>
        {!collapsed[item.id] && rows.map(render)}
      </section>
    }) : <section className="lj-group"><h3 className="lj-group-caption">{title}</h3>{items.map(render)}</section>}
    {next !== null && <button type="button" className="lj-more" disabled={loading} onClick={more}>
      {loading ? '正在读取…' : '查看更多'}<Icon name="down" size={13} />
    </button>}
  </>
}

export function Workbench({ entry }) {
  const [data, setData] = useState(null)
  const [inbox, setInbox] = useState(INBOX)
  const [filters, setFilters] = useState({ period: 'daily', day: entry?.day ?? '', category: 'all', kind: 'all', status: 'all' })
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [target, setTarget] = useState(entry ? { type: 'sessionResult', id: entry.id } : REPORT)
  const [history, setHistory] = useState([])
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [dialog, setDialog] = useState(null)
  const [toast, setToast] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [grouped, setGrouped] = useState(true)
  const [collapsed, setCollapsed] = useState({})
  const [mobile, setMobile] = useState('reading')
  const [moreFilters, setMoreFilters] = useState(false)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [dropping, setDropping] = useState(false)
  const reader = useRef(null)
  const restore = useRef(null)
  const panes = usePaneWidths()
  const list = useRef(null)
  const lastStatus = useRef('')
  const dragDepth = useRef(0)
  const params = useRef({})
  const viewVersion = useRef(0)
  const viewLoaded = useRef(false)

  function update() { setRefresh(value => value + 1) }
  function show(type, extra) { setDialog({ type, ...extra }) }
  function notify(message) { setToast(message) }
  const close = () => setDialog(null)
  const setFilter = value => setFilters(current => ({ ...current, ...value }))
  const previous = history.at(-1)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const controller = new AbortController()
    const values = { ...filters, q: search }
    params.current = values
    viewVersion.current++
    setLoading(true)
    request('view', values, { signal: controller.signal }).then(value => {
      setData(value)
      setInbox(value.inbox)
      setLoadError('')
      viewLoaded.current = true
      lastStatus.current = statusSignature(value.inbox)
    }).catch(error => { if (!controller.signal.aborted) setLoadError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filters, search, refresh])

  useEffect(() => {
    const controller = new AbortController()
    let checking = false
    const updateStatus = async () => {
      if (checking) return
      if (document.hidden) return
      checking = true
      try {
        const next = await request('status', {}, { signal: controller.signal })
        if (controller.signal.aborted) return
        const key = statusSignature(next)
        setInbox(next)
        if (viewLoaded.current && key !== lastStatus.current) update()
        lastStatus.current = key
      } catch {
        // Keep the current report usable while the host reconnects.
      } finally { checking = false }
    }
    const timer = setInterval(updateStatus, 3000)
    const reports = setInterval(() => { if (!document.hidden) update() }, 60_000)
    document.addEventListener('visibilitychange', updateStatus)
    return () => {
      clearInterval(timer)
      clearInterval(reports)
      document.removeEventListener('visibilitychange', updateStatus)
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (target.type !== 'observation') return
    const controller = new AbortController()
    setDetailError('')
    request('observation', { id: target.id }, { signal: controller.signal }).then(setDetail)
      .catch(error => { if (!controller.signal.aborted) setDetailError(error.message) })
    return () => controller.abort()
  }, [target.type, target.id, refresh])

  useLayoutEffect(() => {
    if (restore.current) {
      if (target.type === 'observation' && target.id !== detail?.id && !detailError) return
      const { scroll, opener } = restore.current
      restore.current = null
      reader.current.scrollTop = scroll
      const link = opener && reader.current.querySelector(`[data-reading-link="${CSS.escape(opener)}"]`)
      const focus = link || reader.current
      focus.focus({ preventScroll: true })
    } else reader.current.scrollTop = 0
  }, [target.type, target.id, target.anchor, data?.day, data?.period, detail?.id, detailError])
  useEffect(() => { if (list.current) list.current.scrollTop = 0 }, [filters, search])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  function navigate(next, pane = 'reading') {
    restore.current = null
    setHistory([])
    setTarget(next)
    setMobile(pane)
  }

  function drill(next, opener) {
    if (target.type === 'report' && !filters.day && data?.day) setFilter({ day: data.day })
    setHistory(current => [...current, { target, scroll: reader.current.scrollTop, opener }])
    setTarget(next)
    setMobile('reading')
  }

  function goBack() {
    restore.current = previous
    setHistory(current => current.slice(0, -1))
    setTarget(previous.target)
    setMobile('reading')
  }

  function choose(category) {
    setFilter({ category, status: category === 'followup' ? 'open' : 'all' })
    navigate(REPORT, 'list')
  }

  function selectDay(day) {
    setQuery('')
    setSearch('')
    setFilter({ day })
    navigate(REPORT)
  }

  function selectPeriod(period) {
    if (filters.period === period) return
    setFilter({ period, day: data?.day ?? '' })
    navigate(REPORT, 'list')
  }

  function openObservation(id) { navigate({ type: 'observation', id }) }

  function openResultChat(id, opener) { drill({ type: 'chat', id }, opener) }

  function openSource(source) {
    drill({ type: 'chat', id: source.chatId, anchor: source.id }, source.id)
  }

  async function more() {
    const version = viewVersion.current
    setLoading(true)
    try {
      const next = await request('view', { ...params.current, offset: data.next })
      if (version !== viewVersion.current) return
      setData(current => ({ ...current, next: next.next, items: [...current.items, ...next.items.filter(item => !current.items.some(row => row.id === item.id))] }))
    } catch (error) { notify(error.message) } finally {
      if (version === viewVersion.current) setLoading(false)
    }
  }

  async function mark(field) {
    setBusy(field)
    try {
      const next = await request('mark', {}, { body: { id: detail.id, field, value: !detail[field] } })
      setDetail(current => current?.id === next.id ? next : current)
      update()
    } catch (error) { notify(error.message) } finally { setBusy('') }
  }

  async function generate() {
    setBusy('report')
    try {
      await request('report', {}, { body: { day: data.day, period: data.period } })
      update()
      notify(data.period === 'weekly' ? '周报已汇总' : '日报已汇总')
    } catch (error) { notify(error.message) } finally { setBusy('') }
  }

  function imported(result) {
    const parts = []
    if (result.accepted) parts.push(`已接收 ${result.accepted} 个 ZIP`)
    if (result.duplicates) parts.push(`跳过 ${result.duplicates} 个重复 ZIP`)
    if (parts.length) notify(parts.join('，'))
    update()
    if (result.accepted && !dialog.chat) {
      setFilter({ day: '', category: 'all' })
      navigate(REPORT)
    }
    if (result.complete) show('inbox')
  }

  function copyObservation() {
    const lines = [detail.title, detail.summary, detail.importance, detail.nextStep, '', ...detail.sources.map(source =>
      `${source.sender} · ${source.day} ${source.time}\n${source.text}`)]
    copyText(lines.filter(Boolean).join('\n\n')).then(() => notify('观察已复制')).catch(error => notify(error.message))
  }

  function savedObservation(item) {
    if (!dialog.item) openObservation(item.id)
    setDetail(item)
    close()
    update()
    notify(dialog.item ? '观察已更新' : '记录已添加')
  }

  function savedChat(chat) {
    if (dialog.returnTo === 'observation') show('observation', { initialChat: chat.id })
    else {
      if (!dialog.chat) navigate({ type: 'chat', id: chat.id })
      close()
    }
    update()
    notify(dialog.chat ? '会话已更新' : '会话已创建')
  }

  function removedEntry() {
    const { entryType, item, returnTo } = dialog
    if (target.id === item.id || (entryType === 'chat' && detail?.id === target.id && detail.chatId === item.id)) {
      if (previous && previous.target.id !== item.id) goBack()
      else navigate(REPORT)
    }
    if (returnTo?.type === 'inbox') show('inbox')
    else close()
    update()
    notify({ chat: '会话已删除', archive: '归档已删除', observation: '观察已删除' }[entryType])
  }

  const hasDate = data?.report.stats.messages > 0 || data?.report.stats.observations > 0 || data?.sessionResults.length > 0
  const chats = filters.category === 'chats'
  const pending = chats ? data?.pendingArchives ?? [] : []
  const followup = filters.category === 'followup'
  const title = cat(filters.category)?.label ?? ({ all: '全部观察', chats: '所有会话', saved: '收藏', followup: '跟进清单' }[filters.category])
  const stats = data?.report.stats
  const categoryCounts = { chats: stats?.allChats, saved: stats?.saved, followup: stats?.followup, all: stats?.observations, ...stats?.groups }
  const count = categoryCounts[filters.category] ?? 0
  const filtered = Boolean(search) || filters.kind !== 'all' || (!chats && filters.status !== (followup ? 'open' : 'all'))
  const sectionTitle = target.type === 'report' ? data?.period === 'weekly' ? '每周总览' : '每日总览'
    : { observation: '观察详情', sessionResult: '微信流分析', chat: '原始会话' }[target.type]
  const byDate = data?.period === 'weekly' ? data?.weeks : data?.days.map(item => item.day)
  const before = byDate?.find(day => day < data.day)
  const after = byDate?.findLast(day => day > data.day)

  const backLabel = previous && { report: '返回简报', observation: '返回观察', sessionResult: '返回分析', chat: '返回会话' }[previous.target.type]

  return <div className="lj-workbench" ref={panes.frame} style={panes.style} data-mobile={mobile}
    onDragEnter={event => {
      if (!event.dataTransfer.types.includes('Files') || dialog) return
      event.preventDefault()
      dragDepth.current++
      setDropping(true)
    }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false) } }}
    onDrop={event => {
      if (!event.dataTransfer.files.length || dialog) return
      event.preventDefault()
      dragDepth.current = 0
      setDropping(false)
      show('upload', { files: Array.from(event.dataTransfer.files) })
    }}>
    <Navigation data={data} category={filters.category} choose={choose} inbox={inbox} show={show} close={() => setMobile('list')} />
    <PaneDivider side="sidebar" panes={panes} label="调整分类栏宽度" controls="lj-sidebar" />

    <section className="lj-list" id="lj-list" aria-label="观察列表">
      <header className="lj-bar lj-list-bar">
        <IconButton icon="list" label="打开分类" onClick={() => setMobile('nav')} className="lj-icon-button lj-mobile-only" />
        <h2>{title}</h2><span className="lj-count">{number(filtered ? data?.matches : count)}</span>
        <div className="lj-spacer" />
        <IconButton icon="plus" label={chats ? '新建会话' : followup ? '新建待办' : '新建观察'} disabled={!data}
          onClick={() => show(chats ? 'chat' : 'observation')} />
        <IconButton icon="upload" label="导入 ZIP" onClick={() => show('upload')} />
      </header>
      <div className="lj-controls">
        <div className="lj-period-row">
          <div className="lj-period" aria-label="简报类型">
            {Object.entries({ daily: '日报', weekly: '周报' }).map(([period, label]) =>
              <button type="button" key={period} aria-pressed={filters.period === period} onClick={() => selectPeriod(period)}>{label}</button>)}
          </div>
          {data && <label className="lj-date-picker" title="选择简报日期"><Icon name="calendar" size={15} />
            <input aria-label="选择简报日期" type="date" value={data.day} onChange={event => { if (event.target.value) selectDay(event.target.value) }} />
          </label>}
        </div>
        {data && <DateStrip data={data} selectDay={selectDay} />}
        <button className="lj-overview" type="button" aria-current={target.type === 'report' ? 'page' : undefined}
          onClick={() => navigate(REPORT)}>
          <span className="lj-overview-icon"><Icon name="file" size={18} /></span>
          <span><strong>{filters.period === 'weekly' ? '每周总览' : '每日总览'}</strong><small>先看重点，再展开阅读</small></span>
          <span className="lj-overview-arrow"><Icon name="right" size={15} /></span>
        </button>
        <div className="lj-search-row">
          <label className="lj-search"><Icon name="search" size={15} />
            <input aria-label="搜索话题、会话、人物" placeholder="搜索话题、会话、人物" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} />
            {query && <IconButton icon="close" label="清空搜索" size={13} onClick={() => setQuery('')} />}
          </label>
          <div className="lj-filter-group" aria-label="列表与会话筛选">
            <IconButton icon="list" label={grouped ? '展开为平铺列表' : '按分类分组列表'} pressed={!grouped} disabled={filters.category !== 'all'} onClick={() => setGrouped(!grouped)} />
            <IconButton icon="grid" label="全部会话类型" pressed={filters.kind === 'all'} onClick={() => setFilter({ kind: 'all' })} />
            <IconButton icon="person" label="只看私聊" pressed={filters.kind === 'private'} onClick={() => setFilter({ kind: filters.kind === 'private' ? 'all' : 'private' })} />
            <IconButton icon="people" label="只看群聊" pressed={filters.kind === 'group'} onClick={() => setFilter({ kind: filters.kind === 'group' ? 'all' : 'group' })} />
            {!chats && !followup && <IconButton icon="filter" label="按处理状态筛选" aria-expanded={moreFilters} pressed={filters.status !== 'all'}
              onClick={() => setMoreFilters(!moreFilters)} />}
          </div>
        </div>
        {(moreFilters || followup) && !chats && <div className="lj-status-filter">
          {Object.entries({ all: '全部状态', open: '待处理', done: '已处理' }).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={filters.status === value} onClick={() => setFilter({ status: value })}>{label}</button>)}
        </div>}
      </div>
      <div className="lj-results" ref={list} aria-busy={loading}>
        {pending.length > 0 && <section className="lj-group" aria-label="待归类归档">
          <h3 className="lj-group-caption">待归类 · {number(pending.length)}</h3>
          {pending.map(file => <div key={file.id} className="lj-chat-row"><button type="button" className="lj-result" onClick={() => show('assign', { file })}>
            <span className="lj-result-icon"><Icon name="file" size={17} /></span>
            <span className="lj-result-content"><strong>{file.filename}</strong>
              <span className="lj-result-meta">选择归属{file.chat && ` · 原归属 ${file.chat}`}</span></span>
            <Icon name="right" size={15} />
          </button><IconButton icon="trash" label={`删除归档 ${file.filename}`}
            onClick={() => show('delete', { entryType: 'archive', item: file })} /></div>)}
        </section>}
        {data && <Rows items={data.items} chats={chats} title={search ? '搜索结果' : title}
          grouped={grouped && filters.category === 'all'} countByCategory={!search && filters.kind === 'all' && filters.status === 'all' ? stats.groups : undefined}
          selected={target} collapsed={collapsed} flip={id => setCollapsed(value => ({ ...value, [id]: !value[id] }))}
          choose={item => chats ? navigate({ type: 'chat', id: item.id }) : openObservation(item.id)}
          edit={chat => show('chat', { chat })} pending={pending.length > 0}
          next={data.next} more={more} loading={loading} />}
        {!data && !loadError && <p className="lj-list-loading" role="status">正在打开聊笺…</p>}
      </div>
    </section>
    <PaneDivider side="list" panes={panes} label="调整列表栏宽度" controls="lj-list" />

    <section className="lj-main" aria-label="聊笺阅读区">
      <header className="lj-bar lj-reading-bar">
        {!previous && <IconButton icon="left" label="返回列表" onClick={() => setMobile('list')} className="lj-icon-button lj-mobile-only" />}
        {backLabel && <button type="button" className="lj-text-button lj-reading-back" onClick={goBack}>
          <Icon name="left" size={15} />{backLabel}
        </button>}
        <span>{sectionTitle}</span>
        <div className="lj-spacer" />
        {inbox.active > 0 && <button type="button" className="lj-job-pill" onClick={() => show('inbox')}><Icon name="clock" size={14} />{inbox.active} 份待分析</button>}
        {target.type === 'report' && data && <>
          <IconButton icon="download" label="导出简报" disabled={!hasDate} onClick={() => exportReport(data)
            .catch(error => notify(error.message))} />
          <span className="lj-bar-divider" />
          <IconButton icon="left" label="上一期简报" disabled={!before} onClick={() => selectDay(before)} />
          <IconButton icon="right" label="下一期简报" disabled={!after} onClick={() => selectDay(after)} />
        </>}
        {!previous && ['observation', 'sessionResult'].includes(target.type) && <IconButton icon="file" label="返回简报" onClick={() => navigate(REPORT)} />}
        <button type="button" className="lj-header-import" onClick={() => show('inbox')}><Icon name="inbox" size={15} />归档记录</button>
      </header>
      <div className="lj-reading-scroll" ref={reader} tabIndex={-1}>
        {loadError && <div className="lj-reading"><p className="lj-error" role="alert">{loadError}
          <button type="button" className="lj-text-button" onClick={update}>重试</button></p></div>}
        {target.type === 'report' && data && <Report data={data} open={id => drill({ type: 'observation', id }, id)} showIntake={() => show('inbox')}
          openResult={id => drill({ type: 'sessionResult', id }, id)}
          generating={busy === 'report'} generate={generate} />}
        {target.type === 'observation' && (detailError ? <Empty icon="alert" title="观察加载失败">{detailError}</Empty>
          : detail?.id === target.id ? <Observation item={detail} toggle={mark} marking={Boolean(busy)} source={openSource} copy={copyObservation}
            edit={item => show('observation', { item })} remove={item => show('delete', { entryType: 'observation', item })} />
          : <p className="lj-reading lj-loading" role="status">正在读取观察…</p>)}
        {target.type === 'sessionResult' && <SessionResult key={target.id} id={target.id} refresh={refresh}
          openChat={openResultChat} assign={file => show('assign', { file })} toast={notify} />}
        {target.type === 'chat' && <Chat key={`${target.id}:${target.anchor ?? ''}:${search}`} target={target} refresh={refresh}
          query={search} edit={chat => show('chat', { chat })} upload={chat => show('upload', { chat })} />}
      </div>
    </section>

    {dropping && <div className="lj-drag-screen"><Icon name="upload" size={32} /><strong>松开以导入微信 ZIP</strong></div>}
    {toast && <div role="status" className="lj-toast"><Icon name="message" size={16} />{toast}</div>}
    {dialog?.type === 'upload' && <ImportDialog close={close} onImport={imported} inboxPath={inbox.inboxPath} initialFiles={dialog.files} intoChat={dialog.chat} />}
    {dialog?.type === 'inbox' && <InboxDialog data={inbox} close={close} upload={() => show('upload')}
      assign={file => show('assign', { file })}
      remove={item => show('delete', { entryType: 'archive', item, returnTo: dialog })}
      changed={next => { setInbox(next); update() }} toast={notify} />}
    {dialog?.type === 'assign' && <AssignArchiveDialog archive={dialog.file} close={close} saved={chat => {
      close(); update(); notify(`已归入「${chat.name}」，正在整理观察`)
    }} />}
    {dialog?.type === 'settings' && <SettingsDialog close={close} saved={() => { close(); update(); notify('设置已保存') }} />}
    {dialog?.type === 'chat' && <ChatDialog chat={dialog.chat} close={close} saved={savedChat}
      remove={item => show('delete', { entryType: 'chat', item, returnTo: dialog })} />}
    {dialog?.type === 'observation' && <ObservationDialog item={dialog.item} day={data?.day} initialChat={dialog.initialChat}
      category={cat(filters.category)?.id ?? 'related'} followup={!dialog.item && followup} close={close} saved={savedObservation}
      newChat={() => show('chat', { returnTo: 'observation' })} />}
    {dialog?.type === 'delete' && <DeleteDialog entryType={dialog.entryType} item={dialog.item} removed={removedEntry}
      close={() => setDialog(dialog.returnTo ?? null)} />}
  </div>
}

function statusSignature(data) {
  return `${data.sessionRevision}|${data.pending}|${data.jobs.map(item => `${item.id}:${item.status}`).join(',')}`
}
