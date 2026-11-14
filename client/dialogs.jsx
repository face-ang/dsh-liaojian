import React, { useEffect, useRef, useState } from 'react'
import { categories, chatKinds, MAX_ZIP_BYTES } from '../shared.js'
import { copyText, request } from './api.js'
import { ArchiveLink, Dialog, Empty, IconButton } from './components.jsx'
import { Icon } from './icons.jsx'

const statusLabel = { queued: '等待分析', running: '分析中', done: '已入库', failed: '需要重试' }
const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const fileSize = size => size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`

export function ImportDialog({ close, onImport, inboxPath, initialFiles = [] }) {
  const [files, setFiles] = useState(initialFiles)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [chat, setChat] = useState('')
  const [kind, setKind] = useState('unknown')
  const input = useRef(null)

  function add(candidate) {
    if (busy) return
    const incoming = Array.from(candidate)
    const valid = incoming.filter(file => /\.zip$/i.test(file.name) && file.size && file.size <= MAX_ZIP_BYTES)
    setFiles(items => {
      const unique = new Map([...items, ...valid].map(file => [`${file.name}:${file.size}:${file.lastModified}`, file]))
      return [...unique.values()].slice(0, 30)
    })
    setError(valid.length < incoming.length ? '请选择微信流导出的 ZIP，单个文件最多 100 MB。' : '')
  }

  useEffect(() => {
    if (!initialFiles.length) return
    setFiles([])
    add(initialFiles)
  }, [])

  async function submit(event) {
    event.preventDefault()
    if (!files.length || busy) return
    setBusy(true)
    setError('')
    const failed = []
    let accepted = 0
    let duplicates = 0
    for (const [index, file] of files.entries()) {
      setProgress(`正在接收 ${index + 1} / ${files.length}`)
      try {
        const result = await request('upload', { name: file.name, chat, kind }, { file })
        if (result.duplicate) duplicates++
        else accepted++
      } catch (error) {
        failed.push({ file, message: `${file.name}：${error.message}` })
      }
    }
    setBusy(false)
    setProgress('')
    onImport({ accepted, duplicates, complete: !failed.length })
    if (failed.length) {
      setFiles(failed.map(item => item.file))
      setError(failed.map(item => item.message).join('\n'))
    }
  }

  return <Dialog title="导入微信 ZIP" close={() => { if (!busy) close() }}
    footer={<><button type="button" className="lj-secondary" disabled={busy} onClick={close}>取消</button>
      <button type="submit" form="lj-upload-form" className="lj-primary" disabled={!files.length || busy}>
        <Icon name={busy ? 'clock' : 'spark'} />{busy ? progress : '开始分析'}
      </button></>}>
    <form id="lj-upload-form" className="lj-form" onSubmit={submit}>
      <input type="file" accept=".zip,application/zip" multiple ref={input} hidden onChange={event => {
        add(event.target.files)
        event.target.value = ''
      }} />
      <button type="button" className="lj-drop" data-drag={drag} disabled={busy} onClick={() => input.current.click()}
        onDragOver={event => { event.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); setDrag(false); add(event.dataTransfer.files) }}>
        <span className="lj-drop-icon"><Icon name="upload" size={23} /></span>
        <strong>选择或拖入微信 ZIP</strong>
        <small>支持多选 · 单个最多 100 MB</small>
      </button>
      {!!files.length && <ul className="lj-file-list">{files.map((file, index) => <li key={`${file.name}-${index}`}>
        <Icon name="file" /><span>{file.name}<small>{fileSize(file.size)}</small></span>
        <IconButton icon="close" label={`移除 ${file.name}`} disabled={busy} onClick={() => setFiles(files.filter((_, at) => at !== index))} />
      </li>)}</ul>}
      <div className="lj-form-row">
        <label>会话名称 <small>选填</small><input value={chat} maxLength={120} disabled={busy} onChange={event => setChat(event.target.value)} placeholder="默认使用 ZIP 文件名" /></label>
        <label>会话类型<select value={kind} disabled={busy} onChange={event => setKind(event.target.value)}>
          {Object.entries(chatKinds).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
      </div>
      <p className="lj-help">聊天文本交由 DSH 的默认模型分析。建议同一个会话的分批归档使用同一个名称。</p>
      {inboxPath && <p className="lj-help">也可以在微信流使用「沉淀到文件夹」，把 ZIP 投递到聊笺的收件目录。</p>}
      {error && <p role="alert" className="lj-error">{error}</p>}
    </form>
  </Dialog>
}

export function InboxDialog({ data, close, upload, changed, toast }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  async function run(op, id) {
    setBusy(id ?? op)
    setError('')
    try {
      const next = await request(op, {}, { body: { id } })
      changed(next)
      if (op === 'scan') toast('已检查收件目录')
    } catch (error) {
      setError(error.message)
    } finally { setBusy('') }
  }
  return <Dialog title="导入记录" close={close} footer={<>
    <button type="button" className="lj-secondary" disabled={Boolean(busy)} onClick={() => run('scan')}>
      <Icon name="refresh" />{busy === 'scan' ? '正在检查…' : '检查收件目录'}
    </button>
    <button type="button" className="lj-primary" onClick={upload}><Icon name="upload" />导入 ZIP</button>
  </>}>
    <div className="lj-inbox-location">
      <label>微信流收件目录</label>
      <div><code title={data.inboxPath}>{data.inboxPath}</code>
        <IconButton icon="copy" label="复制收件目录" disabled={!data.inboxPath} onClick={() => copyText(data.inboxPath)
          .then(() => toast('收件目录已复制')).catch(error => setError(error.message))} />
      </div>
      <p className="lj-help">在微信流的「沉淀到文件夹」里选择这个目录。DSH 打开时会接收这里的新 ZIP。</p>
    </div>
    {(error || data.inboxError) && <p role="alert" className="lj-error">{error || data.inboxError}</p>}
    {!data.jobs.length ? <Empty icon="inbox" title="还没有导入记录" /> : <ul className="lj-job-list">
      {data.jobs.map(job => <li key={job.id}>
        <div className="lj-job-title"><Icon name={job.status === 'failed' ? 'alert' : 'file'} />
          <strong title={job.filename}>{job.filename}</strong><span data-status={job.status}>{statusLabel[job.status]}</span>
        </div>
        <div className="lj-job-meta">
          <span>{job.chat} · {job.ingress === 'inbox' ? '微信流收件' : job.ingress === 'command' ? 'DSH 会话' : '手动上传'}</span>
          <time>{new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
        </div>
        <div className="lj-job-meta">
          <span>{job.error || job.progress || (job.status === 'done' ? `新增 ${job.count} 条消息 · ${job.observations} 条观察` : '')}</span>
          {job.status === 'failed'
            ? <button type="button" className="lj-text-button" disabled={Boolean(busy)} onClick={() => run('retry', job.id)}>重新分析</button>
            : job.status === 'done' && <ArchiveLink id={job.id} filename={job.filename} />}
        </div>
      </li>)}
    </ul>}
  </Dialog>
}

export function SettingsDialog({ close, saved }) {
  const [value, setValue] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    request('settings', {}, { signal: controller.signal }).then(data => setValue({
      ...data, aliasText: data.aliases.join('\n'), scopeText: data.scope.join('\n'),
    })).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => controller.abort()
  }, [])

  const change = (key, next) => setValue(previous => ({ ...previous, [key]: next }))
  const changeSchedule = (key, field, next) => change(key, { ...value[key], [field]: next })

  async function save(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request('settings', {}, { body: {
        ...value, aliases: value.aliasText.split(/[\n,，]+/u), scope: value.scopeText.split('\n'),
      } })
      saved()
    } catch (error) {
      setError(error.message)
    } finally { setBusy(false) }
  }

  return <Dialog title="工作台设置" close={() => { if (!busy) close() }} footer={<>
    <button type="button" className="lj-secondary" disabled={busy} onClick={close}>取消</button>
    <button type="submit" form="lj-settings-form" className="lj-primary" disabled={busy || !value}>{busy ? '保存中…' : '保存设置'}</button>
  </>}>
    {error && <p role="alert" className="lj-error">{error}</p>}
    {!value ? !error && <p role="status">正在读取设置…</p> : <form className="lj-form" id="lj-settings-form" onSubmit={save}>
      <div className="lj-form-row lj-form-halves">
        <label>我在微信里的称呼<textarea rows="3" value={value.aliasText} onChange={event => change('aliasText', event.target.value)}
          placeholder="每行一个，用于识别「我的发言」" /></label>
        <label>分析的会话<textarea rows="3" value={value.scopeText} onChange={event => change('scopeText', event.target.value)}
          placeholder="每行一个会话全名，留空分析全部导入会话" /></label>
      </div>
      <label>关注重点<textarea rows="3" maxLength={1000} value={value.focus} onChange={event => change('focus', event.target.value)}
        placeholder="例如客户跟进、自动化落地、公众号选题" /></label>
      <fieldset><legend>分析分类</legend><div className="lj-checks">
        {categories.map(item => <label className="lj-check" key={item.id}><input type="checkbox" checked={value.categories.includes(item.id)}
          onChange={event => change('categories', event.target.checked
            ? [...value.categories, item.id] : value.categories.filter(id => id !== item.id))} />{item.label}</label>)}
      </div></fieldset>
      <label className="lj-check"><input type="checkbox" checked={value.inboxEnabled} onChange={event => change('inboxEnabled', event.target.checked)} />
        自动接收微信流投递的 ZIP</label>
      <fieldset className="lj-schedules"><legend>定时汇总</legend>
        <div><label className="lj-check"><input type="checkbox" checked={value.daily.enabled} onChange={event => changeSchedule('daily', 'enabled', event.target.checked)} />日报</label>
          <span className="lj-help">汇总前一天</span>
          <input aria-label="日报时间" type="time" required value={value.daily.time} onChange={event => changeSchedule('daily', 'time', event.target.value)} />
        </div>
        <div><label className="lj-check"><input type="checkbox" checked={value.weekly.enabled} onChange={event => changeSchedule('weekly', 'enabled', event.target.checked)} />周报</label>
          <select aria-label="周报生成日" value={value.weekly.weekday} onChange={event => changeSchedule('weekly', 'weekday', Number(event.target.value))}>
            {weekdayLabels.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
          <input aria-label="周报时间" type="time" required value={value.weekly.time} onChange={event => changeSchedule('weekly', 'time', event.target.value)} />
        </div>
      </fieldset>
      <label>汇总时区<input required value={value.timeZone} maxLength={80} onChange={event => change('timeZone', event.target.value)} /></label>
      <p className="lj-help">定时汇总使用已导入的消息。周报覆盖上一自然周。DSH 重新启动时会检查最近一期。</p>
    </form>}
  </Dialog>
}

export function ChatDialog({ chat, close, saved }) {
  const [name, setName] = useState(chat.name)
  const [kind, setKind] = useState(chat.kind)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const next = await request('chat', {}, { body: { id: chat.id, name, kind } })
      saved(next)
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  return <Dialog title="编辑会话" close={close} footer={<>
    <button type="button" className="lj-secondary" onClick={close}>取消</button>
    <button type="submit" className="lj-primary" form="lj-chat-form" disabled={busy || !name.trim()}>保存</button>
  </>}>
    <form id="lj-chat-form" className="lj-form" onSubmit={save}>
      <label>会话名称<input required value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
      <label>会话类型<select value={kind} onChange={event => setKind(event.target.value)}>
        {Object.entries(chatKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {error && <p role="alert" className="lj-error">{error}</p>}
    </form>
  </Dialog>
}
