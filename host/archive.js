import { win32 } from 'node:path'
import { crc32 } from 'node:zlib'
import yauzl from 'yauzl'
import { isZipName, MAX_ZIP_BYTES, validDay } from '../shared.js'

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 4000
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const HEADER = /^·([^\n]+)\n(\d{4})年(\d{1,2})月(\d{1,2})日[ \t]+(\d{1,2}):(\d{2})(?::(\d{2}))?[ \t]*(?:\n|$)/gm

export class InputError extends Error {}

export function archiveName(name) {
  const base = typeof name === 'string' ? win32.basename(name).trim() : ''
  if (!isZipName(base)) throw new InputError('请选择微信合并转发导出的 ZIP 文件。')
  const stem = base.slice(0, -4).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').slice(0, 170).toWellFormed()
  return `${stem || '微信聊天记录'}.zip`
}

export function chatNameFromArchive(name) {
  return name.replace(/\.zip$/i, '').replace(/\s*\(\d+\)$/, '').trim() || '微信会话'
}

export const isGenericChatName = name => /^(?:微信(?:聊天记录|会话|流)?|聊天记录|wechat)?$/iu.test(name.trim())

export async function collectBytes(stream, limit = MAX_ZIP_BYTES, signal) {
  const chunks = []
  let length = 0
  for await (const data of stream ?? []) {
    signal?.throwIfAborted()
    length += data.byteLength
    if (length > limit) throw new InputError('单个 ZIP 最多 100 MB，可在微信流中分批转发。')
    chunks.push(data)
  }
  return Buffer.concat(chunks, length)
}

export function assertZip(bytes) {
  if (bytes.length > MAX_ZIP_BYTES) throw new InputError('单个 ZIP 最多 100 MB，可在微信流中分批转发。')
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new InputError('无法读取 ZIP，请重新从微信流导出聊天记录。')
  }
}

export function parseTranscript(text) {
  const body = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const headers = [...body.matchAll(HEADER)]
  if (!headers.length || body.slice(0, headers[0].index).trim()) return []

  return headers.map((match, index) => {
    const [header, sender, year, month, date, hour, minute, second] = match
    const day = `${year}-${month.padStart(2, '0')}-${date.padStart(2, '0')}`
    if (!validDay(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59 || !sender.trim()) {
      throw new InputError(`聊天记录第 ${index + 1} 条的发送人或时间格式无效。`)
    }
    const time = `${hour.padStart(2, '0')}:${minute}${second ? `:${second}` : ''}`
    const end = headers[index + 1]?.index ?? body.length
    const text = body.slice(match.index + header.length, end).trim()
    return { seq: index + 1, day, time, sender: sender.trim(), text }
  })
}

function decodeTranscript(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  return UTF8.decode(bytes)
}

function transcriptEntries(zip) {
  return new Promise((resolve, reject) => {
    const candidates = []
    zip.once('error', reject)
    zip.once('end', () => resolve(candidates.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)))
    zip.on('entry', entry => {
      let path
      try {
        // WeChat sometimes stores UTF-8 names without setting ZIP's UTF-8 flag.
        path = UTF8.decode(entry.fileName)
      } catch {
        zip.readEntry()
        return
      }
      const parts = path.split('/')
      const leaf = parts.at(-1)
      if (/\.txt$/i.test(leaf) && !parts.some(part => part === '__MACOSX' || /^聊天记录内的/.test(part) || part.startsWith('.') || !part) &&
          !path.includes('\\') && !path.includes(':')) {
        const rank = leaf === '聊天记录.txt' ? 0 : /^chat(?:[ _-]?(?:history|records|log))?\.txt$/i.test(leaf) ? 1 : 2
        if (rank < 2 || parts.length === 1) candidates.push({ entry, path, rank })
      }
      zip.readEntry()
    })
    zip.readEntry()
  })
}

async function readTranscript(zip, entry) {
  if (entry.uncompressedSize > MAX_TRANSCRIPT_BYTES) throw new InputError('聊天文本超过 8 MB，请分批转发。')
  const stream = await new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value))
  })
  const bytes = await collectBytes(stream, MAX_TRANSCRIPT_BYTES)
  if (crc32(bytes) !== entry.crc32) throw new InputError('聊天文本校验失败，请重新导出 ZIP。')
  return decodeTranscript(bytes)
}

export async function readArchive(bytes, { nativeOnly = false } = {}) {
  assertZip(bytes)
  let zip
  try {
    zip = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: false, autoClose: false }, (error, value) => {
        if (error) reject(error)
        else resolve(value)
      })
    })
    if (zip.entryCount > MAX_ENTRIES) throw new InputError('ZIP 里的文件过多，请分批转发。')
    const entries = await transcriptEntries(zip)
    const candidates = nativeOnly ? entries.filter(({ rank }) => rank === 0) : entries
    for (const { entry, path, rank } of candidates.slice(0, 24)) {
      try {
        const records = parseTranscript(await readTranscript(zip, entry))
        if (records.length) return { path, records }
      } catch (error) {
        if (rank === 0) throw error
      }
    }
    throw new InputError('未识别到微信聊天记录。请导入包含原生「聊天记录.txt」的 ZIP。')
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('微信 ZIP 已损坏、已加密或聊天文本格式无法读取，请重新导出。', { cause: error })
  } finally {
    zip?.close()
  }
}
