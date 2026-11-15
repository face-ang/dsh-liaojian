function path(op, values = {}) {
  return `api/liaojian${op === 'upload' ? '/upload' : ''}?${new URLSearchParams({ op, ...values })}`
}

export async function request(op, values, { signal, body, file } = {}) {
  const response = await fetch(path(op, values), {
    method: body !== undefined || file ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: file ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: file ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal,
  })
  const data = await response.json().catch(() => undefined)
  if (response.ok && data !== undefined) return data
  if (response.status === 401 || response.status === 403) throw new Error('请在拥有者权限的 DSH 窗口中打开聊笺。')
  throw new Error(data?.error ?? '暂时无法连接聊笺，请重试。')
}

export const archiveUrl = id => path('download', { id })

export function downloadText(name, body, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([body], { type: `${type};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Older Web profiles can serve a non-secure origin.
    }
  }
  const input = document.createElement('textarea')
  input.value = text
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('复制失败，请手动选择并复制。')
}
