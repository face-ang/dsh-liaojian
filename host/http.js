import { Readable } from 'node:stream'
import { MAX_ZIP_BYTES, validDay } from '../shared.js'
import { collectBytes, InputError } from './archive.js'
import { idOf, offsetOf } from './workbench.js'

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
const json = (value, status = 200) => Response.json(value, { status, headers })
const missing = () => json({ error: '未找到这条记录。' }, 404)

const MESSAGE_ID = /^[a-f0-9]{64}-\d{1,8}$/
const JSON_LIMIT = 64 * 1024

async function readJson(request) {
  try {
    return JSON.parse((await collectBytes(request.body, JSON_LIMIT, request.signal)).toString('utf8'))
  } catch {
    throw new InputError('请求内容无效，请重试。')
  }
}

async function read(workbench, op, params) {
  const id = idOf(params.get('id'))
  switch (op) {
    case 'view': return json(workbench.view(params))
    case 'status': return json(workbench.status())
    case 'settings': return json({ ...workbench.store.settings(), inboxPath: workbench.inbox.directory })
    case 'observation': {
      const item = workbench.store.observation(id)
      return item ? json(item) : missing()
    }
    case 'chat': {
      const raw = params.get('anchor') ?? ''
      const timeline = workbench.store.timeline(id, {
        anchor: MESSAGE_ID.test(raw) ? raw : '', offset: offsetOf(params.get('offset')), query: (params.get('q') ?? '').slice(0, 120),
      })
      return timeline ? json(timeline) : missing()
    }
    case 'download': {
      const file = await workbench.download(id)
      if (!file) return missing()
      const name = encodeURIComponent(file.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)
      return new Response(Readable.toWeb(file.stream), { headers: {
        ...headers, 'content-type': 'application/zip', 'content-length': String(file.bytes),
        'content-disposition': `attachment; filename="wechat.zip"; filename*=UTF-8''${name}`,
      } })
    }
    default: return missing()
  }
}

async function write(workbench, op, request, params) {
  const media = request.headers.get('content-type')?.split(';')[0]
  if (op === 'upload') {
    const hint = Number(request.headers.get('content-length'))
    if (hint > MAX_ZIP_BYTES) throw new InputError('单个 ZIP 最多 100 MB，可在微信流中分批转发。')
    if (media !== 'application/octet-stream') return json({ error: '请发送 ZIP 文件。' }, 415)
    const bytes = await collectBytes(request.body, MAX_ZIP_BYTES, request.signal)
    return json(await workbench.enqueue(bytes, {
      filename: params.get('name'), name: params.get('chat'), kind: params.get('kind'), ingress: 'upload',
    }), 202)
  }
  if (media !== 'application/json') return json({ error: '请通过聊笺工作台提交。' }, 415)
  const body = await readJson(request)
  const id = idOf(body?.id)
  switch (op) {
    case 'settings': return json(workbench.saveSettings(body))
    case 'scan': await workbench.check(); return json(workbench.status())
    case 'retry': {
      if (!id || !workbench.store.retry(id)) return missing()
      workbench.kick()
      return json(workbench.status())
    }
    case 'mark': {
      if (!['saved', 'done'].includes(body?.field) || typeof body?.value !== 'boolean') throw new InputError('无效的观察状态。')
      const item = workbench.store.mark(id, body.field, body.value)
      return item ? json(item) : missing()
    }
    case 'chat': {
      const item = workbench.editChat(id, body)
      return item ? json(item) : missing()
    }
    case 'report': {
      if (!validDay(body?.day) || !['daily', 'weekly'].includes(body?.period)) throw new InputError('请选择汇总日期。')
      return json(workbench.store.saveReport(body.period, body.day, true))
    }
    default: return missing()
  }
}

export function workbenchRoute(workbench) {
  return async request => {
    const url = new URL(request.url)
    const params = url.searchParams
    const upload = url.pathname.endsWith('/upload')
    const op = upload ? 'upload' : params.get('op') ?? 'view'
    try {
      if (!upload && op === 'upload') return missing()
      if (request.method === 'GET') return await read(workbench, op, params)
      if (request.method === 'POST') return await write(workbench, op, request, params)
      return json({ error: '请求方式无效。' }, 405)
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, 400)
      if (request.signal.aborted) return json({ error: '请求已取消。' }, 408)
      return json({ error: '聊笺暂时无法处理这个请求，请重试。' }, 500)
    }
  }
}
