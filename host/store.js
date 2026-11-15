import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { categories, clockAt, dayOfWeek, defaultSettings, mondayOf, PAGE_SIZE, shiftDay } from '../shared.js'
import { chatNameFromArchive, InputError, isGenericChatName } from './archive.js'

const LEASE_MS = 5 * 60_000
const DEFAULT_ORDER = 'o.priority DESC, o.day DESC, o.time DESC, o.rowid DESC'
const OBSERVATION_COLUMNS = `o.id, o.category, o.title, o.summary, o.importance, o.nextStep, o.priority,
  o.day, o.time, o.saved, o.done, o.origin, c.id AS chatId, c.name AS chat, c.kind`

export const digest = value => createHash('sha256').update(value).digest('hex')
export const normalized = value => value.normalize('NFKC').trim().toLowerCase()
export const sessionResultId = (sessionId, endSeq) => digest(JSON.stringify([sessionId, endSeq]))
const UNASSIGNED_CHAT = digest('liaojian:unassigned')

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
      CREATE TABLE IF NOT EXISTS manual_chats (id TEXT PRIMARY KEY REFERENCES chats(id));
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
      CREATE TABLE IF NOT EXISTS session_results (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, createdAt TEXT NOT NULL, reply TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_results_day ON session_results (day);
      CREATE TABLE IF NOT EXISTS session_result_archives (
        resultId TEXT NOT NULL REFERENCES session_results(id), archiveId TEXT NOT NULL REFERENCES imports(id),
        PRIMARY KEY (resultId, archiveId)
      );
      CREATE TABLE IF NOT EXISTS removed_session_results (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS removed_archives (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS archive_cleanup (id TEXT PRIMARY KEY);
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
    this.transaction(() => {
      if (this.get('PRAGMA user_version').user_version >= 1) return
      const legacy = this.all(`SELECT i.id, i.filename, c.name, c.kind FROM imports i JOIN chats c ON c.id=i.chatId
        WHERE i.ingress='session' AND i.status='done' AND i.observations=0`)
      for (const { id, filename, name, kind } of legacy) {
        const needsReview = kind === 'unknown' && (isGenericChatName(name) || name === chatNameFromArchive(filename))
        const status = needsReview ? 'pending' : 'queued'
        this.run('UPDATE imports SET status=? WHERE id=?', status, id)
      }
      this.db.exec('PRAGMA user_version = 1')
    })
    this.transaction(() => {
      if (this.get('PRAGMA user_version').user_version >= 2) return
      if (!this.all('PRAGMA table_info(observations)').some(column => column.name === 'origin')) {
        this.db.exec("ALTER TABLE observations ADD COLUMN origin TEXT NOT NULL DEFAULT 'analysis'")
      }
      this.db.exec('PRAGMA user_version = 2')
    })
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

  enqueue(job, publish) {
    const { status, duplicate } = this.transaction(() => {
      if (job.ingress === 'inbox' && this.isArchiveRemoved(job.id) && !this.importById(job.id)) {
        return { status: 'removed', duplicate: true }
      }
      const result = this.ensureImport(job)
      if (!result.duplicate) publish()
      return result
    })
    return { id: job.id, status, duplicate }
  }

  ensureImport(job) {
    const prior = this.get('SELECT status, chatId FROM imports WHERE id=?', job.id)
    if (prior) return { ...prior, duplicate: true }
    if (job.pending) this.run("INSERT OR IGNORE INTO chats VALUES (?, '', 'unknown')", UNASSIGNED_CHAT)
    const chatId = job.pending ? UNASSIGNED_CHAT : this.ensureChat(job.name, job.kind, job.id)
    const status = job.pending ? 'pending' : 'queued'
    this.run('INSERT INTO imports (id, filename, chatId, ingress, createdAt, status) VALUES (?, ?, ?, ?, ?, ?)',
      job.id, job.filename, chatId, job.ingress, new Date().toISOString(), status)
    return { chatId, status, duplicate: false }
  }

  createChat(name, kind) {
    return this.transaction(() => {
      if (this.findChat(name)) throw new InputError('这个会话名称已被使用。')
      const id = this.ensureChat(name, kind, randomUUID())
      this.run('INSERT INTO manual_chats VALUES (?)', id)
      return this.chat(id)
    })
  }

  findChat(name) {
    return this.get('SELECT id FROM chats WHERE name=? ORDER BY rowid LIMIT 1', name)?.id
      ?? this.get('SELECT chatId FROM chat_aliases WHERE name=?', name)?.chatId
  }

  ensureChat(name, kind, archiveId) {
    const existing = this.findChat(name)
    if (existing) {
      if (kind !== 'unknown') this.run("UPDATE chats SET kind=? WHERE id=? AND kind='unknown'", kind, existing)
      return existing
    }
    const id = digest(name)
    const chatId = this.chat(id) ? digest(`${name}\0${archiveId}`) : id
    this.run('INSERT INTO chats VALUES (?, ?, ?)', chatId, name, kind)
    return chatId
  }

  routeArchive(id, chatId) {
    this.run("UPDATE imports SET chatId=?, status='queued' WHERE id=?", chatId, id)
  }

  assignArchive(id, { chatId, name, kind }) {
    return this.transaction(() => {
      const archive = this.get("SELECT 1 FROM imports WHERE id=? AND status='pending'", id)
      if (!archive) throw new InputError('这份归档已处理，或已不存在。')
      if (chatId) {
        if (chatId === UNASSIGNED_CHAT || !this.chat(chatId)) throw new InputError('所选会话已不存在。')
        if (kind) this.run('UPDATE chats SET kind=? WHERE id=?', kind, chatId)
      } else {
        if (this.findChat(name)) throw new InputError('这个名称已存在，请选择归入已有会话。')
        chatId = this.ensureChat(name, kind || 'unknown', id)
      }
      this.routeArchive(id, chatId)
      return this.chat(chatId)
    })
  }

  archiveDestinations() {
    return this.all('SELECT * FROM chats WHERE id!=? ORDER BY name COLLATE NOCASE', UNASSIGNED_CHAT)
  }

  pendingArchives() {
    return this.all(`SELECT i.id, i.filename, nullif(c.name, '') AS chat
      FROM imports i JOIN chats c ON c.id=i.chatId WHERE i.status='pending' ORDER BY i.createdAt DESC, i.rowid DESC`)
  }

  hasHandledSessionResult(id) {
    return Boolean(this.get('SELECT 1 FROM session_results WHERE id=? UNION SELECT 1 FROM removed_session_results WHERE id=?', id, id))
  }

  saveSessionResult(result, archives, publish) {
    this.transaction(() => {
      if (this.hasHandledSessionResult(result.id)) return
      let day = ''
      for (const { records } of archives) {
        for (const message of records) if (message.day > day) day = message.day
      }
      const added = this.run('INSERT OR IGNORE INTO session_results VALUES (?, ?, ?, ?)',
        result.id, day, result.createdAt, result.reply)
      if (!added.changes) return
      for (const archive of archives) {
        const { status, duplicate } = this.ensureImport({ ...archive, pending: !archive.batchId })
        if (!duplicate) publish(archive)
        if (archive.batchId && status === 'pending') {
          const target = this.ensureChat(archive.name, archive.kind, archive.id)
          this.routeArchive(archive.id, target)
        }
        this.run('INSERT INTO session_result_archives VALUES (?, ?)', result.id, archive.id)
      }
    })
  }

  sessionResults(start, end) {
    return this.all(`SELECT r.id, r.day, r.createdAt, min(i.filename) AS filename, count(i.id) AS fileCount,
      CASE WHEN count(DISTINCT c.id)=1 AND sum(i.status='pending')=0 THEN max(c.name) END AS chat,
      sum(i.status='pending') AS pending
      FROM session_results r JOIN session_result_archives a ON a.resultId=r.id JOIN imports i ON i.id=a.archiveId
      JOIN chats c ON c.id=i.chatId
      WHERE r.day BETWEEN ? AND ? GROUP BY r.id ORDER BY r.createdAt DESC, r.rowid DESC`, start, end)
  }

  sessionResult(id) {
    const result = this.get('SELECT id, day, createdAt, reply FROM session_results WHERE id=?', id)
    if (!result) return undefined
    const archives = this.all(`SELECT i.id, i.filename, i.chatId, nullif(c.name, '') AS chat, i.status FROM session_result_archives a
      JOIN imports i ON i.id=a.archiveId JOIN chats c ON c.id=i.chatId WHERE a.resultId=? ORDER BY a.rowid`, id)
    return { ...result, archives }
  }

  sessionResultLink(id) {
    return this.get('SELECT id, day FROM session_results WHERE id=?', id)
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

  isArchiveRemoved(id) { return Boolean(this.get('SELECT 1 FROM removed_archives WHERE id=?', id)) }

  cleanArchives(removeFile) {
    for (const { id } of this.all('SELECT id FROM archive_cleanup')) {
      this.transaction(() => {
        if (!this.importById(id)) {
          try { removeFile(id) } catch { return }
        }
        this.run('DELETE FROM archive_cleanup WHERE id=?', id)
      })
    }
  }

  removeMessages(field, id) {
    const affected = this.all(`SELECT DISTINCT o.id, o.day FROM observations o JOIN sources s ON s.observationId=o.id
      JOIN messages m ON m.id=s.messageId WHERE m.${field}=?`, id)
    const days = new Set(this.all(`SELECT DISTINCT day FROM messages WHERE ${field}=?`, id).map(row => row.day))
    this.run(`DELETE FROM sources WHERE messageId IN (SELECT id FROM messages WHERE ${field}=?)`, id)
    for (const item of affected) {
      const deletion = this.run('DELETE FROM observations WHERE id=? AND NOT EXISTS (SELECT 1 FROM sources WHERE observationId=?)', item.id, item.id)
      if (deletion.changes) days.add(item.day)
    }
    this.run(`DELETE FROM messages WHERE ${field}=?`, id)
    this.invalidateReports(days)
  }

  removeArchives(archives) {
    const results = new Set()
    for (const id of archives) {
      for (const { resultId } of this.all('SELECT resultId FROM session_result_archives WHERE archiveId=?', id)) results.add(resultId)
    }
    for (const id of results) {
      this.run('INSERT OR IGNORE INTO removed_session_results VALUES (?)', id)
      this.run('DELETE FROM session_result_archives WHERE resultId=?', id)
      this.run('DELETE FROM session_results WHERE id=?', id)
    }
    for (const id of archives) {
      this.removeMessages('archiveId', id)
      this.run('DELETE FROM imports WHERE id=?', id)
      this.run('INSERT OR IGNORE INTO removed_archives VALUES (?)', id)
      this.run('INSERT OR IGNORE INTO archive_cleanup VALUES (?)', id)
    }
  }

  deleteArchive(id) {
    return this.transaction(() => {
      if (!this.importById(id)) return false
      this.removeArchives([id])
      return true
    })
  }

  deleteChat(id) {
    return this.transaction(() => {
      if (id === UNASSIGNED_CHAT || !this.chat(id)) return undefined
      const archives = this.all('SELECT id FROM imports WHERE chatId=?', id).map(row => row.id)
      this.removeArchives(archives)
      this.invalidateReports(this.all('SELECT DISTINCT day FROM observations WHERE chatId=?', id).map(row => row.day))
      this.run('DELETE FROM sources WHERE observationId IN (SELECT id FROM observations WHERE chatId=?)', id)
      this.run('DELETE FROM observations WHERE chatId=?', id)
      this.removeMessages('chatId', id)
      this.run('DELETE FROM chat_aliases WHERE chatId=?', id)
      this.run('DELETE FROM manual_chats WHERE id=?', id)
      this.run('DELETE FROM chats WHERE id=?', id)
      return true
    })
  }

  importStatus() {
    return {
      active: this.get("SELECT count(*) AS count FROM imports WHERE status IN ('queued','running')").count,
      pending: this.get("SELECT count(*) AS count FROM imports WHERE status='pending'").count,
      sessionRevision: this.get('SELECT coalesce(max(rowid), 0) AS revision FROM session_results').revision,
      jobs: this.all(`SELECT i.id, i.filename, i.ingress, i.createdAt, i.status, i.progress, i.error, i.count,
        i.observations, c.name AS chat FROM imports i JOIN chats c ON c.id=i.chatId
        ORDER BY (i.status IN ('pending','queued','running')) DESC, i.createdAt DESC, i.rowid DESC LIMIT 40`),
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
      // A moved legacy archive can still supply an original quote for another observation.
      this.run(`DELETE FROM messages WHERE archiveId=? AND chatId!=? AND NOT EXISTS (
        SELECT 1 FROM sources WHERE messageId=messages.id)`, job.id, job.chatId)
      const count = this.addMessages(job.id, job.chatId, messages)
      this.run('UPDATE imports SET transcript=?, count=? WHERE id=? AND lease=?', transcript, count, job.id, lease)
    })
  }

  addMessages(archiveId, chatId, messages) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const m of messages) insert.run(m.id, m.chatId, m.archiveId, m.seq, m.day, m.time, m.sender, m.senderKey, m.text)
    return this.get('SELECT count(*) AS count FROM messages WHERE archiveId=? AND chatId=?', archiveId, chatId).count
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
    return this.all(`SELECT day, sum(count) AS count FROM (
      SELECT day, count(*) AS count FROM messages GROUP BY day
      UNION ALL SELECT day, 0 FROM session_results
      UNION ALL SELECT day, 0 FROM observations
    ) GROUP BY day ORDER BY day DESC`)
  }

  counts(start, end) {
    const aliases = this.settings().aliases.map(normalized)
    const mine = aliases.length ? `sum(senderKey IN (${aliases.map(() => '?').join(',')}))` : '0'
    const stats = this.get(`SELECT count(*) AS messages, coalesce(${mine}, 0) AS self
      FROM messages WHERE day BETWEEN ? AND ?`, ...aliases, start, end)
    const chats = this.get(`SELECT count(*) AS count FROM (
      SELECT chatId FROM messages WHERE day BETWEEN ? AND ? UNION SELECT chatId FROM observations WHERE day BETWEEN ? AND ?
    )`, start, end, start, end).count
    const groups = this.all('SELECT category, count(*) AS count FROM observations WHERE day BETWEEN ? AND ? GROUP BY category', start, end)
    return {
      ...stats, chats,
      groups: Object.fromEntries(groups.map(row => [row.category, row.count])),
      observations: groups.reduce((total, row) => total + row.count, 0),
      saved: this.get('SELECT count(*) AS count FROM observations WHERE saved=1').count,
      allChats: this.get(`SELECT count(*) AS count FROM chats c WHERE
        EXISTS (SELECT 1 FROM messages WHERE chatId=c.id) OR EXISTS (SELECT 1 FROM manual_chats WHERE id=c.id)
        OR EXISTS (SELECT 1 FROM observations WHERE chatId=c.id)`).count,
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
    if (!result.stats.messages && !result.stats.observations) return result
    const data = JSON.stringify({ summary: result.summary })
    const generatedAt = new Date().toISOString()
    this.run(`INSERT INTO reports VALUES (?, ?, ?, ?, ?) ON CONFLICT(period, start) DO UPDATE
      SET generatedAt=excluded.generatedAt, fingerprint=excluded.fingerprint, data=excluded.data
      WHERE reports.fingerprint != excluded.fingerprint OR ? = 1`, period, result.start, generatedAt, fingerprint, data, Number(force))
    return this.report(period, day)
  }

  invalidateReports(days) {
    for (const day of days) this.run("DELETE FROM reports WHERE (period='daily' AND start=?) OR (period='weekly' AND start=?)",
      day, mondayOf(day))
  }

  list(view) {
    return view.category === 'chats' ? this.listChats(view) : this.listObservations(view)
  }

  listObservations({ start, end, category, kind, query, status, offset = 0 }) {
    const where = []
    const args = []
    if (category === 'saved') where.push('o.saved=1')
    else if (category === 'followup') where.push("o.category IN ('related', 'opportunity')")
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
    const where = [`(EXISTS (SELECT 1 FROM messages WHERE chatId=c.id) OR EXISTS (SELECT 1 FROM manual_chats WHERE id=c.id)
      OR EXISTS (SELECT 1 FROM observations WHERE chatId=c.id))`]
    const args = []
    if (kind !== 'all') { where.push('c.kind=?'); args.push(kind) }
    if (query) {
      where.push(`(search_contains(c.name, ?) OR EXISTS (SELECT 1 FROM messages m WHERE m.chatId=c.id
        AND search_contains(m.senderKey || ' ' || m.text, ?)))`)
      args.push(normalized(query), normalized(query))
    }
    const items = this.all(`SELECT c.*, count(m.id) AS count, max(m.day) AS day FROM chats c
      LEFT JOIN messages m ON m.chatId=c.id WHERE ${where.join(' AND ')}
      GROUP BY c.id ORDER BY day DESC, c.name LIMIT ? OFFSET ?`, ...args, PAGE_SIZE + 1, offset)
    const matches = this.get(`SELECT count(*) AS count FROM chats c WHERE ${where.join(' AND ')}`, ...args).count
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

  saveObservation(id, fields) {
    const { chatId, category, title, summary, importance, nextStep, priority, day, time } = fields
    return this.transaction(() => {
      if (id) {
        const current = this.get('SELECT origin FROM observations WHERE id=?', id)
        if (!current) return undefined
        this.run(`UPDATE observations SET category=?, title=?, summary=?, importance=?, nextStep=?, priority=? WHERE id=?`,
          category, title, summary, importance, nextStep, priority, id)
        if (current.origin === 'manual') {
          if (!this.chat(chatId) || chatId === UNASSIGNED_CHAT) throw new InputError('请选择已有会话。')
          this.run('UPDATE observations SET chatId=?, day=? WHERE id=?', chatId, day, id)
        }
      } else {
        if (!this.chat(chatId) || chatId === UNASSIGNED_CHAT) throw new InputError('请选择已有会话。')
        id = digest(randomUUID())
        this.run(`INSERT INTO observations (id, chatId, category, title, summary, importance, nextStep, priority, day, time, origin)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`, id, chatId, category, title, summary, importance, nextStep, priority, day, time)
      }
      return this.observation(id)
    })
  }

  deleteObservation(id) {
    return this.transaction(() => {
      const item = this.get('SELECT day FROM observations WHERE id=?', id)
      if (!item) return false
      this.run('DELETE FROM sources WHERE observationId=?', id)
      this.run('DELETE FROM observations WHERE id=?', id)
      this.invalidateReports([item.day])
      return true
    })
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
