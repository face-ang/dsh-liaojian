export const MAX_ZIP_BYTES = 100 * 1024 * 1024
export const PAGE_SIZE = 60

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
