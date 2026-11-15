import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, renameSync, rmSync } from 'node:fs'
import { mkdir, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { categories, chatKinds, clockAt, MAX_ZIP_BYTES, mondayOf, validDay } from '../shared.js'
import { analyze } from './analysis.js'
import { archiveName, assertZip, chatNameFromArchive, collectBytes, InputError, isGenericChatName, readArchive } from './archive.js'
import { Inbox } from './inbox.js'
import { digest, dueReports, messageRows, reportWindow, sessionResultId, Store } from './store.js'

export const ID = /^[a-f0-9]{64}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const plain = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const lines = (value, max) => Array.isArray(value) ? [...new Set(value.map(item => plain(item, 120)).filter(Boolean))].slice(0, max) : []
export const kindOf = value => typeof value === 'string' && Object.hasOwn(chatKinds, value) ? value : 'unknown'
export const offsetOf = value => /^\d{1,8}$/.test(value) ? Number(value) : 0
export const idOf = value => typeof value === 'string' && ID.test(value) ? value : ''

function schedule(value, old, weekly = false) {
  if (typeof value?.enabled !== 'boolean' || !TIME.test(value.time)) throw new InputError('请填写有效的汇总时间。')
  const weekday = weekly ? Number(value.weekday) : undefined
  if (weekly && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw new InputError('请选择周报生成日。')
  return { ...old, enabled: value.enabled, time: value.time, ...(weekly ? { weekday } : {}) }
}

export class Workbench {
  lease = randomUUID()
  controller = new AbortController()
  drain = null
  tick = null
  inboxError = ''
  sessionCapture = Promise.resolve()
  sessionError = ''

  constructor(directory, complete) {
    this.store = new Store(directory)
    this.archives = join(directory, 'archives')
    this.inbox = new Inbox(join(directory, 'inbox'))
    this.complete = complete
  }

  async start() {
    await mkdir(this.archives, { recursive: true, mode: 0o700 })
    await mkdir(this.inbox.directory, { recursive: true, mode: 0o700 })
    void this.check()
    this.timer = setInterval(() => void this.check(), 10_000)
    this.timer.unref?.()
    return () => this.stop()
  }

  async stop() {
    clearInterval(this.timer)
    this.controller.abort()
    await Promise.allSettled([this.tick, this.drain, this.sessionCapture])
    this.store.release(this.lease)
    this.store.close()
  }

  async enqueue(bytes, { filename, name, kind, ingress }) {
    if (this.controller.signal.aborted) throw new Error('聊笺正在停止。')
    filename = archiveName(filename)
    assertZip(bytes)
    const id = digest(bytes)
    const previous = this.store.importById(id)
    if (previous) return { id, status: previous.status, duplicate: true }
    if (ingress === 'inbox' && this.store.isArchiveRemoved(id)) return { id, status: 'removed', duplicate: true }
    const temp = await this.stageArchive(bytes)
    try {
      this.controller.signal.throwIfAborted()
      const result = this.store.enqueue({
        id, filename, name: plain(name, 120) || chatNameFromArchive(filename), kind: kindOf(kind), ingress,
      }, () => this.publishArchive(temp, id))
      this.kick()
      return result
    } finally {
      await rm(temp, { force: true })
    }
  }

  async stageArchive(bytes) {
    const path = join(this.archives, `${randomUUID()}.tmp`)
    try {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      return path
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
  }

  publishArchive(temp, id) {
    // Publication and cleanup both hold the SQLite writer lock for this hash path.
    const path = join(this.archives, `${id}.zip`)
    if (!existsSync(path)) renameSync(temp, path)
  }

  cleanArchives() {
    this.store.cleanArchives(id => rmSync(join(this.archives, `${id}.zip`), { force: true }))
  }

  captureSession(result, readFile) {
    const signal = this.controller.signal
    if (signal.aborted) return
    const pending = this.sessionCapture.then(async () => {
      try {
        await this.saveSession(result, readFile, signal)
      } catch (error) {
        signal.throwIfAborted()
        this.sessionError = error instanceof InputError ? error.message : '微信流会话分析入库失败，可重新发送该批次。'
        throw new InputError(this.sessionError)
      }
    })
    this.sessionCapture = pending.catch(() => {})
    return pending
  }

  async saveSession(result, readFile, signal) {
    signal.throwIfAborted()
    const id = sessionResultId(result.sessionId, result.endSeq)
    if (this.store.hasHandledSessionResult(id)) return
    const archives = new Map()
    try {
      const files = new Map(result.files.map(ref => [typeof ref === 'string' ? ref : ref.attachmentId, ref]))
      for (const ref of files.values()) {
        const file = await readFile(ref, signal)
        if (!file) continue
        const { name, chatName, batchId, stream } = file
        const bytes = await collectBytes(stream, MAX_ZIP_BYTES, signal)
        const filename = archiveName(name)
        const { records } = await readArchive(bytes, { nativeOnly: true })
        signal.throwIfAborted()
        const archiveId = digest(bytes)
        if (archives.has(archiveId)) continue
        const temp = await this.stageArchive(bytes)
        archives.set(archiveId, {
          id: archiveId, filename, name: plain(chatName, 120), batchId,
          kind: 'unknown', ingress: 'session', records, temp,
        })
      }
      signal.throwIfAborted()
      const deliveries = [...archives.values()]
      for (const archive of deliveries) {
        if (archive.batchId && isGenericChatName(archive.name)) {
          archive.name = `微信转发 · ${digest(archive.batchId).slice(0, 12)}`
        }
      }
      this.store.saveSessionResult({ id,
        createdAt: new Date(result.time).toISOString(), reply: result.reply }, deliveries,
      archive => this.publishArchive(archive.temp, archive.id))
      this.kick()
      this.sessionError = ''
    } finally {
      await Promise.all([...archives.values()].map(archive => rm(archive.temp, { force: true })))
    }
  }

  kick() {
    if (this.drain || this.controller.signal.aborted) return
    this.drain = this.process().catch(() => {
      // The database is the queue. A later tick can pick up a released or expired job.
    }).finally(() => { this.drain = null })
  }

  async process() {
    const signal = this.controller.signal
    while (!signal.aborted) {
      const job = this.store.claim(this.lease)
      if (!job) return
      try {
        const bytes = await collectBytes(createReadStream(join(this.archives, `${job.id}.zip`), { signal }), MAX_ZIP_BYTES, signal)
        const { path, records } = await readArchive(bytes)
        const messages = messageRows(job.chatId, job.id, records)
        const days = [...new Set(records.map(message => message.day))].sort()
        const known = this.store.knownMessages(job.chatId, job.id, days[0], days.at(-1))
        this.store.stageMessages(job, this.lease, path, messages)
        const settings = this.store.settings()
        const matchedScope = !settings.scope.length || settings.scope.includes(job.chat)
        const observations = matchedScope ? await analyze({
          complete: this.complete, job, messages, known, settings, signal,
          progress: value => this.store.progress(job.id, this.lease, value),
        }) : []
        signal.throwIfAborted()
        this.store.complete(job, this.lease, observations, matchedScope)
      } catch (error) {
        if (signal.aborted) return
        const message = error instanceof InputError || /^模型|^DSH|^请先/.test(error?.message ?? '')
          ? error.message : '聊天归档处理失败，请在归档记录中重试。'
        this.store.fail(job.id, this.lease, message)
      }
    }
  }

  publishDue() {
    for (const [period, day] of dueReports(this.store.settings(), new Date())) this.store.saveReport(period, day)
  }

  check() {
    if (this.tick) return this.tick
    const signal = this.controller.signal
    if (signal.aborted) return
    this.tick = (async () => {
      const settings = this.store.settings()
      let inboxError = ''
      if (settings.inboxEnabled) {
        await this.inbox.scan((bytes, options) => this.enqueue(bytes, options), message => { inboxError = message }, signal)
      }
      this.inboxError = inboxError
      this.cleanArchives()
      this.publishDue()
      this.kick()
    })().catch(() => {
      if (!signal.aborted) this.inboxError = '暂时无法检查收件文件夹或定时汇总。'
      this.kick()
    }).finally(() => { this.tick = null })
    return this.tick
  }

  status() {
    return { ...this.store.importStatus(), inboxPath: this.inbox.directory, inboxError: this.inboxError, sessionError: this.sessionError }
  }

  view(params) {
    const settings = this.store.settings()
    const { day: today } = clockAt(settings.timeZone)
    const days = this.store.dates()
    const period = params.get('period') === 'weekly' ? 'weekly' : 'daily'
    const requested = params.get('day')
    const day = validDay(requested) ? requested : days[0]?.day ?? today
    const { start, end } = reportWindow(period, day)
    const category = plain(params.get('category'), 32)
    const rawKind = params.get('kind')
    const requestedStatus = params.get('status')
    const status = ['all', 'open', 'done'].includes(requestedStatus) ? requestedStatus : category === 'followup' ? 'open' : 'all'
    const items = this.store.list({
      start, end, category, kind: rawKind === 'all' || !rawKind ? 'all' : kindOf(rawKind),
      query: plain(params.get('q'), 120), status, offset: offsetOf(params.get('offset')),
    })
    return {
      today, day: start, period, days, weeks: [...new Set(days.map(row => mondayOf(row.day)))],
      report: this.store.report(period, day), sessionResults: this.store.sessionResults(start, end), ...items,
      ...(category === 'chats' ? { pendingArchives: this.store.pendingArchives() } : {}),
      inbox: this.status(),
    }
  }

  saveSettings(value) {
    const old = this.store.settings()
    const timeZone = plain(value?.timeZone, 80)
    try { clockAt(timeZone) } catch { throw new InputError('时区无效，请使用 Asia/Shanghai 这样的 IANA 时区。') }
    const settings = this.store.saveSettings({
      aliases: lines(value?.aliases, 30), scope: lines(value?.scope, 60), focus: plain(value?.focus, 1000), timeZone,
      categories: categories.filter(item => Array.isArray(value?.categories) && value.categories.includes(item.id)).map(item => item.id),
      inboxEnabled: value?.inboxEnabled === true,
      daily: schedule(value?.daily, old.daily), weekly: schedule(value?.weekly, old.weekly, true),
    })
    void this.check()
    return settings
  }

  editChat(id, value) {
    const name = plain(value?.name, 120)
    if (!name) throw new InputError('请输入会话名称。')
    if (!id) return this.store.createChat(name, kindOf(value?.kind))
    const chat = this.store.editChat(id, name, kindOf(value?.kind))
    if (chat === null) throw new InputError('这个会话名称已被使用。')
    return chat
  }

  saveObservation(id, value) {
    const title = plain(value?.title, 90)
    const summary = plain(value?.summary, 500)
    const category = value?.category
    const priority = value?.priority
    const day = value?.day
    if (!title || !summary) throw new InputError('请输入标题和摘要。')
    if (!categories.some(item => item.id === category) || ![1, 2, 3].includes(priority) || !validDay(day)) {
      throw new InputError('请选择有效的分类、优先级和日期。')
    }
    return this.store.saveObservation(id, {
      chatId: idOf(value?.chatId), category, title, summary, priority, day,
      time: clockAt(this.store.settings().timeZone).time,
      importance: plain(value?.importance, 500), nextStep: plain(value?.nextStep, 500),
    })
  }

  deleteEntry(type, id) {
    const removed = type === 'chat' ? this.store.deleteChat(id) : this.store.deleteArchive(id)
    if (!removed) return false
    this.cleanArchives()
    return true
  }

  assignArchive(id, value) {
    const kind = value?.kind == null ? '' : kindOf(value.kind)
    const chatId = idOf(value?.chatId)
    const name = plain(value?.name, 120)
    if (value?.mode === 'new' && !name) throw new InputError('请输入新会话名称。')
    if (value?.mode === 'existing' && !chatId) throw new InputError('请选择已有会话。')
    if (!['new', 'existing'].includes(value?.mode)) throw new InputError('请选择会话归属。')
    const chat = this.store.assignArchive(id, { chatId: value.mode === 'existing' ? chatId : '', name, kind })
    this.kick()
    return chat
  }

  async download(id) {
    const row = this.store.importById(id)
    if (!row) return null
    const path = join(this.archives, `${id}.zip`)
    const handle = await open(path, 'r').catch(error => { if (error.code !== 'ENOENT') throw error })
    if (!handle) return null
    try {
      return { filename: row.filename, bytes: (await handle.stat()).size, stream: handle.createReadStream() }
    } catch (error) {
      await handle.close()
      throw error
    }
  }
}
