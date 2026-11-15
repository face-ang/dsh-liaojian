export const MAX_ZIP_BYTES = 100 * 1024 * 1024
export const PAGE_SIZE = 60
export const WECHAT_SCENE_MARKER = '【微信流归档】'
export const DEFAULT_WECHAT_PROMPT = '阅读随消息发送的微信聊天记录。先用一两句话概括结论，再用 Markdown 列出重点和待办。合并重复内容，只保留有依据的信息。待办注明已知的负责人和截止时间，缺失的留空。'

export const isZipName = name => typeof name === 'string' && /\.zip$/i.test(name)

export function isOwnerPrompt(source) {
  return source?.kind === 'user' && (source.principal?.kind ?? 'owner') === 'owner'
}

export function hasWechatSceneMarker(text) {
  // Paste can collapse the break between the marker and the scene prompt.
  return text.trimStart().startsWith(WECHAT_SCENE_MARKER)
}

export function wechatPathMentions(text) {
  const mentions = []
  for (const [token, quoted, bare] of text.matchAll(/(?:^|\s)@(?:"([^"\r\n]+)"|([^\s"<>]+))(?=\s|$)/gu)) {
    mentions.push({ token: token.trim(), path: quoted ?? bare })
  }
  return mentions
}

export function wechatBridgePath(path) {
  const normalized = path.replaceAll('\\', '/')
  return /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/|\/(?!\/))/iu.test(normalized) &&
    /\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/files\/[^/:*?"<>|\u0000-\u001f]+\.zip$/iu.test(normalized)
}

export function wechatSceneInput(content) {
  // DSH may put the uploaded files before the pasted prompt.
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (!hasWechatSceneMarker(text) || content.some(block => block.type !== 'text' && block.type !== 'file')) return null
  const files = content.filter(block => block.type === 'file').map(block => block.attachment)
  if (files.some(file => !isZipName(file.name) || file.bytes <= 0 || file.bytes > MAX_ZIP_BYTES)) return null
  const paths = wechatPathMentions(text).map(mention => mention.path).filter(isZipName)
  const references = paths.filter(wechatBridgePath)
  if (!files.length && references.length !== paths.length) return null
  return files.length || references.length ? { files, references } : null
}

export const categories = [
  { id: 'related', label: '与我有关', badge: '待办', icon: 'message' },
  { id: 'opportunity', label: '机会', badge: '商机', icon: 'bulb' },
  { id: 'learning', label: '学习', badge: '学习', icon: 'book' },
  { id: 'topic', label: '内容选题', badge: '选题', icon: 'pen' },
  { id: 'self', label: '我的发言', badge: '发言', icon: 'person' },
]

export const chatKinds = { group: '群聊', private: '私聊', unknown: '未标注' }
export const defaultSettings = {
  aliases: [],
  focus: '',
  scope: [],
  categories: categories.map(({ id }) => id),
  timeZone: 'Asia/Shanghai',
  inboxEnabled: true,
  daily: { enabled: true, time: '08:30' },
  weekly: { enabled: true, time: '09:00', weekday: 1 },
}

export function clockAt(timeZone, date = new Date()) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const parts = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

export function shiftDay(day, offset) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function dayOfWeek(day) {
  return new Date(`${day}T00:00:00Z`).getUTCDay()
}

export function mondayOf(day) {
  return shiftDay(day, -((dayOfWeek(day) + 6) % 7))
}

export function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) && shiftDay(day, 0) === day
}

export function dateLabel(day) {
  const [, month, date] = day.split('-')
  return `${Number(month)} 月 ${Number(date)} 日`
}
