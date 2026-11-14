import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { categories, clockAt, dayOfWeek, defaultSettings, mondayOf, PAGE_SIZE, shiftDay } from '../shared.js'

const LEASE_MS = 5 * 60_000
const DEFAULT_ORDER = 'o.priority DESC, o.day DESC, o.time DESC, o.rowid DESC'
const OBSERVATION_COLUMNS = `o.id, o.category, o.title, o.summary, o.importance, o.nextStep, o.priority,
  o.day, o.time, o.saved, o.done, c.id AS chatId, c.name AS chat, c.kind`

export const digest = value => createHash('sha256').update(value).digest('hex')
export const normalized = value => value.normalize('NFKC').trim().toLowerCase()

function searchText(value, pattern) {
  return Number(normalized(value).includes(pattern))
}

export function messageRows(chatId, archiveId, records) {
  const frequency = new Map()
  return records.map(record => {
    const { day, time, sender, text, seq } = record
    const fingerprint = digest(JSON.stringify([chatId, day, time, sender, text]))
    const occurrence = (frequency.get(fingerprint) ?? 0) + 1
    frequency.set(fingerprint, occurrence)
    return { ...record, id: `${fingerprint}-${occurrence}`, chatId, archiveId, seq, senderKey: normalized(sender) }
  })
}

export function reportWindow(period, day) {
  const start = period === 'weekly' ? mondayOf(day) : day
  return { start, end: period === 'weekly' ? shiftDay(start, 6) : start }
}

export function dueReports(settings, date) {
  const { day, time } = clockAt(settings.timeZone, date)
  const periods = []
  if (settings.daily.enabled) periods.push(['daily', shiftDay(day, time >= settings.daily.time ? -1 : -2)])
  if (settings.weekly.enabled) {
    const schedule = settings.weekly
    let due = shiftDay(day, -((dayOfWeek(day) - schedule.weekday + 7) % 7))
    if (due === day && time < schedule.time) due = shiftDay(due, -7)
    periods.push(['weekly', shiftDay(mondayOf(due), -7)])
  }
  return periods
}

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(directory, 'workbench.sqlite'))
    this.db.function('search_contains', { deterministic: true }, searchText)
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_aliases (name TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id));
      CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, chatId TEXT NOT NULL REFERENCES chats(id),
        ingress TEXT NOT NULL, createdAt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        progress TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0,
        observations INTEGER NOT NULL DEFAULT 0, lease TEXT, leaseUntil INTEGER, transcript TEXT
      );
      CREATE INDEX IF NOT EXISTS imports_status ON imports (status, createdAt);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id), archiveId TEXT NOT NULL REFERENCES imports(id),
        seq INTEGER NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL, sender TEXT NOT NULL, senderKey TEXT NOT NULL, text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_day ON messages (day);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages (chatId, day, time);
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id), category TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL, importance TEXT NOT NULL, nextStep TEXT NOT NULL,
        priority INTEGER NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL, saved INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS observations_day ON observations (day);
      CREATE TABLE IF NOT EXISTS sources (
        observationId TEXT NOT NULL REFERENCES observations(id), messageId TEXT NOT NULL REFERENCES messages(id),
        PRIMARY KEY (observationId, messageId)
      );
      CREATE TABLE IF NOT EXISTS reports (
        period TEXT NOT NULL, start TEXT NOT NULL, generatedAt TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (period, start)
      );
    `)
  }

  all(sql, ...args) { return this.db.prepare(sql).all(...args) }
  get(sql, ...args) { return this.db.prepare(sql).get(...args) }
  run(sql, ...args) { return this.db.prepare(sql).run(...args) }
  close() { this.db.close() }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = callback()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  settings() {
    const row = this.get('SELECT data FROM settings WHERE id = 1')
    return { ...defaultSettings, ...(row ? JSON.parse(row.data) : {}) }
  }

  saveSettings(settings) {
    this.run('INSERT INTO settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', JSON.stringify(settings))
    return settings
  }

  enqueue(job) {
    return this.transaction(() => {
      const prior = this.get('SELECT id, status FROM imports WHERE id = ?', job.id)
      if (prior) return { ...prior, duplicate: true }
      let chatId = this.get('SELECT id FROM chats WHERE name=? ORDER BY rowid LIMIT 1', job.name)?.id
        ?? this.get('SELECT chatId FROM chat_aliases WHERE name=?', job.name)?.chatId
      if (!chatId) {
        chatId = digest(job.name)
        if (this.chat(chatId)) chatId = digest(`${job.name}\0${job.id}`)
        this.run('INSERT INTO chats VALUES (?, ?, ?)', chatId, job.name, job.kind)
      } else if (job.kind !== 'unknown') {
        this.run("UPDATE chats SET kind = ? WHERE id = ? AND kind = 'unknown'", job.kind, chatId)
      }
      this.run('INSERT INTO imports (id, filename, chatId, ingress, createdAt) VALUES (?, ?, ?, ?, ?)',
        job.id, job.filename, chatId, job.ingress, new Date().toISOString())
      return { id: job.id, status: 'queued', duplicate: false }
    })
  }

  claim(lease) {
    return this.transaction(() => {
      const now = Date.now()
      this.run("UPDATE imports SET status='queued', lease=NULL, leaseUntil=NULL WHERE status='running' AND leaseUntil < ?", now)
      if (this.get("SELECT 1 FROM imports WHERE status='running' LIMIT 1")) return undefined
      const job = this.get(`SELECT i.*, c.name AS chat, c.kind FROM imports i JOIN chats c ON c.id=i.chatId
        WHERE i.status='queued' ORDER BY i.createdAt, i.rowid LIMIT 1`)
      if (job) {
        this.run("UPDATE imports SET status='running', lease=?, leaseUntil=?, progress='正在读取微信归档' WHERE id=?",
          lease, now + LEASE_MS, job.id)
      }
      return job
    })
  }

  progress(id, lease, progress) {
    this.run('UPDATE imports SET progress=?, leaseUntil=? WHERE id=? AND lease=?', progress, Date.now() + LEASE_MS, id, lease)
  }

  fail(id, lease, message) {
    this.run("UPDATE imports SET status='failed', error=?, progress='', lease=NULL, leaseUntil=NULL WHERE id=? AND lease=?",
      message, id, lease)
  }

  release(lease) {
    this.run("UPDATE imports SET status='queued', lease=NULL, leaseUntil=NULL, progress='' WHERE lease=?", lease)
  }

  retry(id) {
    return this.run("UPDATE imports SET status='queued', error='' WHERE id=? AND status='failed'", id).changes > 0
  }

  importById(id) { return this.get('SELECT id, filename, status FROM imports WHERE id=?', id) }

  importStatus() {
    return {
      active: this.get("SELECT count(*) AS count FROM imports WHERE status IN ('queued','running')").count,
      jobs: this.all(`SELECT i.id, i.filename, i.ingress, i.createdAt, i.status, i.progress, i.error, i.count,
        i.observations, c.name AS chat FROM imports i JOIN chats c ON c.id=i.chatId
        ORDER BY (i.status IN ('queued','running')) DESC, i.createdAt DESC, i.rowid DESC LIMIT 40`),
    }
  }

  knownMessages(chatId, archiveId, first, last) {
    return new Set(this.all(`SELECT m.id FROM messages m JOIN imports i ON i.id=m.archiveId
      WHERE m.chatId=? AND m.archiveId!=? AND i.status='done' AND m.day BETWEEN ? AND ?`,
      chatId, archiveId, first, last).map(row => row.id))
  }

  stageMessages(job, lease, transcript, messages) {
    this.transaction(() => {
      if (!this.get('SELECT 1 FROM imports WHERE id=? AND lease=?', job.id, lease)) return
      const insert = this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const m of messages) insert.run(m.id, m.chatId, m.archiveId, m.seq, m.day, m.time, m.sender, m.senderKey, m.text)
      const { count } = this.get('SELECT count(*) AS count FROM messages WHERE archiveId=?', job.id)
      this.run('UPDATE imports SET transcript=?, count=? WHERE id=? AND lease=?', transcript, count, job.id, lease)
    })
  }

  complete(job, lease, observations, matchedScope) {
    return this.transaction(() => {
      if (!this.get('SELECT 1 FROM imports WHERE id=? AND lease=?', job.id, lease)) return
      const addObservation = this.db.prepare(`INSERT OR IGNORE INTO observations
        (id, chatId, category, title, summary, importance, nextStep, priority, day, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const addSource = this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?, ?)')
      let added = 0
      for (const o of observations) {
        const result = addObservation.run(o.id, job.chatId, o.category, o.title, o.summary, o.importance, o.nextStep, o.priority, o.day, o.time)
        if (!result.changes) continue
        added++
        for (const id of o.sources) addSource.run(o.id, id)
      }
      this.run(`UPDATE imports SET status='done', observations=?, progress=?, error='',
        lease=NULL, leaseUntil=NULL WHERE id=?`, added, matchedScope ? '' : '会话在分析范围外，原文已入库。', job.id)
    })
  }

  dates() {
    return this.all('SELECT day, count(*) AS count FROM messages GROUP BY day ORDER BY day DESC')
  }

  counts(start, end) {
    const aliases = this.settings().aliases.map(normalized)
    const mine = aliases.length ? `sum(senderKey IN (${aliases.map(() => '?').join(',')}))` : '0'
    const stats = this.get(`SELECT count(*) AS messages, count(DISTINCT chatId) AS chats, coalesce(${mine}, 0) AS self
      FROM messages WHERE day BETWEEN ? AND ?`, ...aliases, start, end)
    const groups = this.all('SELECT category, count(*) AS count FROM observations WHERE day BETWEEN ? AND ? GROUP BY category', start, end)
    return {
      ...stats,
      groups: Object.fromEntries(groups.map(row => [row.category, row.count])),
      observations: groups.reduce((total, row) => total + row.count, 0),
      saved: this.get('SELECT count(*) AS count FROM observations WHERE saved=1').count,
      allChats: this.get('SELECT count(DISTINCT chatId) AS count FROM messages').count,
      followup: this.get("SELECT count(*) AS count FROM observations WHERE done=0 AND category IN ('related', 'opportunity')").count,
    }
  }

  report(period, day) {
    const { fingerprint, ...report } = this.reportDraft(period, day)
    const saved = this.get('SELECT generatedAt, data FROM reports WHERE period=? AND start=? AND fingerprint=?',
      period, report.start, fingerprint)
    return saved ? { ...report, summary: JSON.parse(saved.data).summary, generatedAt: saved.generatedAt } : report
  }

  reportDraft(period, day) {
    const { start, end } = reportWindow(period, day)
    const stats = this.counts(start, end)
    const highlights = this.all(`SELECT ${OBSERVATION_COLUMNS} FROM observations o JOIN chats c ON c.id=o.chatId
      WHERE o.day BETWEEN ? AND ? ORDER BY (o.category='self'), ${DEFAULT_ORDER} LIMIT 4`, start, end)
    const summary = highlights.slice(0, 2).map(item => item.summary).join(' ')
    const fingerprint = digest(JSON.stringify([summary, highlights.map(item => item.id), stats.messages, stats.observations, stats.self]))
    return { start, end, stats, highlights, summary, fingerprint }
  }

  saveReport(period, day, force = false) {
    const { fingerprint, ...result } = this.reportDraft(period, day)
    if (!result.stats.messages) return result
    const data = JSON.stringify({ summary: result.summary })
    const generatedAt = new Date().toISOString()
    this.run(`INSERT INTO reports VALUES (?, ?, ?, ?, ?) ON CONFLICT(period, start) DO UPDATE
      SET generatedAt=excluded.generatedAt, fingerprint=excluded.fingerprint, data=excluded.data
      WHERE reports.fingerprint != excluded.fingerprint OR ? = 1`, period, result.start, generatedAt, fingerprint, data, Number(force))
    return this.report(period, day)
  }

  list(view) {
    return view.category === 'chats' ? this.listChats(view) : this.listObservations(view)
  }

  listObservations({ start, end, category, kind, query, status, offset = 0 }) {
    const where = []
    const args = []
    if (category === 'saved') where.push('o.saved=1')
    else if (category === 'followup') where.push("o.done=0 AND o.category IN ('related', 'opportunity')")
    else if (categories.some(item => item.id === category)) { where.push('o.category=?'); args.push(category) }
    if (kind !== 'all') { where.push('c.kind=?'); args.push(kind) }
    if (status !== 'all') { where.push('o.done=?'); args.push(Number(status === 'done')) }
    if (query) {
      where.push(`(search_contains(o.title || ' ' || o.summary || ' ' || o.nextStep || ' ' || c.name, ?) OR EXISTS (
        SELECT 1 FROM sources s JOIN messages m ON m.id=s.messageId WHERE s.observationId=o.id
        AND search_contains(m.senderKey || ' ' || m.text, ?)))`)
      args.push(normalized(query), normalized(query))
    } else if (!['saved', 'followup'].includes(category)) { where.push('o.day BETWEEN ? AND ?'); args.push(start, end) }
    const items = this.all(`SELECT ${OBSERVATION_COLUMNS} FROM observations o JOIN chats c ON c.id=o.chatId
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${DEFAULT_ORDER} LIMIT ? OFFSET ?`, ...args, PAGE_SIZE + 1, offset)
    const matches = this.get(`SELECT count(*) AS count FROM observations o JOIN chats c ON c.id=o.chatId
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...args).count
    return { items: items.slice(0, PAGE_SIZE), next: items.length > PAGE_SIZE ? offset + PAGE_SIZE : null, matches }
  }

  listChats({ kind, query, offset = 0 }) {
    const where = []
    const args = []
    if (kind !== 'all') { where.push('c.kind=?'); args.push(kind) }
    if (query) {
      where.push(`(search_contains(c.name, ?) OR EXISTS (SELECT 1 FROM messages m WHERE m.chatId=c.id
        AND search_contains(m.senderKey || ' ' || m.text, ?)))`)
      args.push(normalized(query), normalized(query))
    }
    const items = this.all(`SELECT c.*, count(m.id) AS count, max(m.day) AS day FROM chats c
      JOIN messages m ON m.chatId=c.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY c.id ORDER BY day DESC, c.name LIMIT ? OFFSET ?`, ...args, PAGE_SIZE + 1, offset)
    const matches = this.get(`SELECT count(*) AS count FROM chats c WHERE EXISTS (SELECT 1 FROM messages WHERE chatId=c.id)
      ${where.length ? `AND ${where.join(' AND ')}` : ''}`, ...args).count
    return { items: items.slice(0, PAGE_SIZE), next: items.length > PAGE_SIZE ? offset + PAGE_SIZE : null, matches }
  }

  observation(id) {
    const item = this.get(`SELECT ${OBSERVATION_COLUMNS} FROM observations o JOIN chats c ON c.id=o.chatId WHERE o.id=?`, id)
    if (!item) return undefined
    const sources = this.all(`SELECT m.*, i.filename, i.transcript FROM sources s JOIN messages m ON m.id=s.messageId
      JOIN imports i ON i.id=m.archiveId WHERE s.observationId=? ORDER BY m.day, m.time, m.rowid`, id)
    return { ...item, sources }
  }

  mark(id, field, value) {
    if (field === 'saved' || field === 'done') this.run(`UPDATE observations SET ${field}=? WHERE id=?`, Number(value), id)
    return this.observation(id)
  }

  chat(id) { return this.get('SELECT * FROM chats WHERE id=?', id) }

  editChat(id, name, kind) {
    return this.transaction(() => {
      const previous = this.chat(id)
      if (!previous) return undefined
      const existing = this.get(`SELECT id FROM chats WHERE name=? AND id!=?
        UNION SELECT chatId FROM chat_aliases WHERE name=? AND chatId!=?`, name, id, name, id)
      if (existing) return null
      if (previous.name !== name) this.run('INSERT OR IGNORE INTO chat_aliases VALUES (?, ?)', previous.name, id)
      this.run('UPDATE chats SET name=?, kind=? WHERE id=?', name, kind, id)
      return this.chat(id)
    })
  }

  timeline(id, { anchor, offset, query }) {
    const chat = this.chat(id)
    if (!chat) return undefined
    const around = anchor && this.get('SELECT day, time, rowid AS sort FROM messages WHERE id=? AND chatId=?', anchor, id)
    if (around) {
      const before = this.get(`SELECT count(*) AS count FROM messages WHERE chatId=? AND (day,time,rowid) > (?,?,?)`,
        id, around.day, around.time, around.sort).count
      offset = Math.max(0, before - Math.floor(PAGE_SIZE / 2))
    }
    const args = query && !around && !normalized(chat.name).includes(normalized(query)) ? [normalized(query)] : []
    const items = this.all(`SELECT m.*, i.filename, i.transcript FROM messages m JOIN imports i ON i.id=m.archiveId
      WHERE m.chatId=? ${args.length ? "AND search_contains(m.senderKey || ' ' || m.text, ?)" : ''}
      ORDER BY m.day DESC, m.time DESC, m.rowid DESC LIMIT ? OFFSET ?`, id, ...args, PAGE_SIZE + 1, offset)
    return { chat, items: items.slice(0, PAGE_SIZE), offset, next: items.length > PAGE_SIZE ? offset + PAGE_SIZE : null }
  }
}
