import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_ZIP_BYTES } from '../shared.js'
import { archiveName, collectBytes, InputError } from './archive.js'

const MAX_NOTE_BYTES = 4 * 1024 * 1024
const MAX_DEPTH = 4
const MAX_FILES = 3000

async function filesUnder(directory, depth, found, signal) {
  if (depth > MAX_DEPTH || found.length >= MAX_FILES) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (found.length >= MAX_FILES) break
    signal.throwIfAborted()
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await filesUnder(join(directory, entry.name), depth + 1, found, signal)
    else if (entry.isFile() && /\.(zip|md)$/i.test(entry.name)) found.push({ directory, name: entry.name })
  }
}

function field(line) {
  const text = line?.trim() ?? ''
  if (!text.startsWith('"')) return text
  try { return JSON.parse(text) } catch { return '' }
}

function namesByArchive(text) {
  const [front] = text.match(/^\uFEFF?---\r?\n[\s\S]{0,6000}?\r?\n---(?=\r?\n|$)/u) ?? []
  if (!front || !/^source:\s*WeChat\s*$/im.test(front)) return []
  const chat = field(front.match(/^chat:[ \t]*(.+)$/im)?.[1]) || field(front.match(/^title:[ \t]*(.+)$/im)?.[1])
  if (typeof chat !== 'string' || !chat.trim()) return []
  const archive = field(front.match(/^archive:[ \t]*(.+)$/im)?.[1])
  const additions = [...text.matchAll(/^> 追加归档：!?\[\[(附件\/[^\]|\r\n]+\.zip)(?:\|[^\]]*)?\]\]/gim)].map(match => match[1])
  return [archive, ...additions].filter(path => typeof path === 'string' && /^附件\/[^/\\]+\.zip$/i.test(path))
    .map(path => [path.slice(3), chat.trim().slice(0, 120)])
}

export class Inbox {
  seen = new Map()
  nameCache = new Map()
  errors = new Map()

  constructor(directory) { this.directory = directory }

  async scan(importZip, onError, signal) {
    const files = []
    await filesUnder(this.directory, 0, files, signal)
    const names = new Map()
    const present = new Set(files.map(file => join(file.directory, file.name)))
    for (const key of this.seen.keys()) if (!present.has(key)) this.seen.delete(key)
    for (const key of this.nameCache.keys()) if (!present.has(key)) this.nameCache.delete(key)
    for (const key of this.errors.keys()) if (!present.has(key)) this.errors.delete(key)

    for (const file of files.filter(file => /\.md$/i.test(file.name))) {
      const path = join(file.directory, file.name)
      try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) continue
        const key = `${stat.size}:${stat.mtimeMs}`
        const cached = this.nameCache.get(path)
        const pairs = cached?.key === key ? cached.pairs : namesByArchive(await readFile(path, { encoding: 'utf8', signal }))
        if (cached?.key !== key) this.nameCache.set(path, { key, pairs })
        for (const [name, chat] of pairs) names.set(join(file.directory, '附件', name), chat)
      } catch (error) {
        if (error.code !== 'ENOENT') signal.throwIfAborted()
      }
    }

    for (const file of files.filter(file => /\.zip$/i.test(file.name))) {
      const path = join(file.directory, file.name)
      let key
      try {
        signal.throwIfAborted()
        const stat = await lstat(path)
        if (!stat.isFile() || Date.now() - stat.mtimeMs < 2000) continue
        key = `${stat.size}:${stat.mtimeMs}`
        if (this.seen.get(path) === key) continue
        const filename = archiveName(file.name)
        if (stat.size > MAX_ZIP_BYTES) throw new InputError('单个 ZIP 最多 100 MB，可在微信流中分批转发。')
        const bytes = await collectBytes(createReadStream(path, { signal }), MAX_ZIP_BYTES, signal)
        const after = await lstat(path)
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) continue
        await importZip(bytes, { filename, name: names.get(path), ingress: 'inbox' })
        this.seen.set(path, key)
        this.errors.delete(path)
      } catch (error) {
        signal.throwIfAborted()
        if (error.code === 'ENOENT') continue
        if (key && error instanceof InputError) this.seen.set(path, key)
        this.errors.set(path, error instanceof InputError ? `${file.name}：${error.message}` : '读取微信流收件夹失败，请检查目录权限。')
      }
    }
    const errors = [...this.errors.values()]
    if (errors.length) onError(errors.slice(0, 4).join('\n'))
  }
}
