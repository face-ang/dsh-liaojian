import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { categories, chatKinds, clockAt, MAX_ZIP_BYTES, mondayOf, validDay } from '../shared.js'
import { analyze } from './analysis.js'
import { archiveName, assertZip, chatNameFromArchive, collectBytes, InputError, readArchive } from './archive.js'
import { Inbox } from './inbox.js'
import { digest, dueReports, messageRows, reportWindow, Store } from './store.js'

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
    await Promise.allSettled([this.tick, this.drain])
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
    // Hard-link a closed staging file into its content-addressed name. A crash
    // can leave an orphan, and a retry can safely reuse the completed ZIP.
    const target = join(this.archives, `${id}.zip`)
    const temp = join(this.archives, `${randomUUID()}.tmp`)
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      await link(temp, target).catch(error => { if (error.code !== 'EEXIST') throw error })
    } finally {
      await rm(temp, { force: true })
    }
    this.controller.signal.throwIfAborted()
    const result = this.store.enqueue({
      id, filename, name: plain(name, 120) || chatNameFromArchive(filename), kind: kindOf(kind), ingress,
    })
    this.kick()
    return result
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
          ? error.message : '聊天归档处理失败，请在导入记录中重试。'
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
      this.publishDue()
      this.kick()
    })().catch(() => {
      if (!signal.aborted) this.inboxError = '暂时无法检查收件文件夹或定时汇总。'
      this.kick()
    }).finally(() => { this.tick = null })
    return this.tick
  }

  status() { return { ...this.store.importStatus(), inboxPath: this.inbox.directory, inboxError: this.inboxError } }

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
    const status = ['open', 'done'].includes(params.get('status')) ? params.get('status') : 'all'
    const items = this.store.list({
      start, end, category, kind: rawKind === 'all' || !rawKind ? 'all' : kindOf(rawKind),
      query: plain(params.get('q'), 120), status, offset: offsetOf(params.get('offset')),
    })
    return {
      today, day: start, period, days, weeks: [...new Set(days.map(row => mondayOf(row.day)))],
      report: this.store.report(period, day), ...items,
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
    const chat = this.store.editChat(id, name, kindOf(value?.kind))
    if (chat === null) throw new InputError('这个会话名称已被使用。')
    return chat
  }

  async download(id) {
    const row = this.store.importById(id)
    if (!row) return null
    const path = join(this.archives, `${id}.zip`)
    return { filename: row.filename, bytes: (await stat(path)).size, stream: createReadStream(path) }
  }
}
