import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { MAX_ZIP_BYTES, defaultSettings, wechatBridgePath, WECHAT_SCENE_MARKER } from '../shared.js'
import { renderMarkdown } from '../client/markdown.js'
import { createComplete } from '../host/analysis.js'
import { readArchive } from '../host/archive.js'
import { workbenchRoute } from '../host/http.js'
import { watchSessionResults } from '../host/session.js'
import { wechatBridgeReady } from '../host/wechat-bridge.js'
import { dueReports, Store } from '../host/store.js'
import { Workbench } from '../host/workbench.js'
import { entry, zipOf } from './fixtures.js'

async function makeWorkbench(t, complete) {
  const directory = await mkdtemp(join(tmpdir(), 'liaojian-test-'))
  const bench = new Workbench(directory, complete)
  await bench.start()
  await bench.check()
  t.after(async () => {
    await bench.stop()
    await rm(directory, { recursive: true, force: true })
  })
  return bench
}

function makeRequest(bench, recover) {
  const route = workbenchRoute(bench, recover)
  return function request(op, values = {}, body) {
    const path = op === 'upload' ? '/api/liaojian/upload' : '/api/liaojian'
    const query = new URLSearchParams({ op, ...values })
    const zip = Buffer.isBuffer(body)
    return route(new Request(`http://localhost${path}?${query}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: body !== undefined ? { 'content-type': zip ? 'application/octet-stream' : 'application/json' } : undefined,
      body: zip ? body : body !== undefined ? JSON.stringify(body) : undefined,
    }))
  }
}

async function settled(bench) {
  bench.kick()
  await bench.drain
}

const first = entry('王一', '10:02', '能否周一前给一份上线清单？\n包含价格和测试条件。')
const second = entry('我', '10:03', '可以，周一前先发草稿。')
const native = zipOf({ '聊天记录.txt': '\uFEFF' + first + second, '聊天记录内的图片、视频和文件/图片.png': 'test' })
const finding = seq => ({
  category: 'related',
  title: '周一前发送上线清单',
  summary: '王一需要价格和测试条件。',
  importance: '有明确交付时间。',
  nextStep: '准备清单并确认联系人。',
  priority: 3,
  sources: [seq],
})

test('creates empty chats and lets manual observations drive reports and the follow-up list', async t => {
  const bench = await makeWorkbench(t, async () => assert.fail('手动添加无需模型'))
  const req = makeRequest(bench)
  const create = await req('chat', {}, { name: '项目讨论', kind: 'group' })
  assert.equal(create.status, 201)
  const chat = await create.json()
  const listing = await (await req('view', { category: 'chats' })).json()
  assert.equal(listing.report.stats.allChats, 1)
  assert.equal(listing.items[0].count, 0)
  assert.equal((await req('chat', {}, { name: chat.name })).status, 400)
  const values = { chatId: chat.id, title: '确认交付时间', summary: '找客户确认', category: 'related', priority: 2, day: '2026-11-13' }
  const saved = await req('observation', {}, values)
  assert.equal(saved.status, 201)
  const item = await saved.json()
  assert.deepEqual(item.sources, [])
  assert.equal(item.origin, 'manual')
  const report = await (await req('view', { day: values.day })).json()
  assert.equal(report.report.highlights[0].id, item.id)
  assert.equal(report.report.stats.chats, 1)
  await req('mark', {}, { id: item.id, field: 'done', value: true })
  await req('mark', {}, { id: item.id, field: 'saved', value: true })
  const edited = await (await req('observation', {}, { ...values, id: item.id, title: '已确认交付', day: '2026-11-14' })).json()
  assert.deepEqual([edited.day, edited.done, edited.saved], ['2026-11-14', 1, 1])
  assert.equal((await (await req('view', { category: 'followup' })).json()).matches, 0)
  assert.equal((await (await req('view', { category: 'followup', status: 'done' })).json()).items[0].title, '已确认交付')
  assert.equal((await req('deleteObservation', {}, { id: item.id })).status, 200)
  assert.equal((await (await req('view', { category: 'saved' })).json()).matches, 0)
  assert.equal((await req('chat', { id: chat.id })).status, 200)
  assert.equal((await req('deleteChat', {}, { id: chat.id })).status, 200)
  assert.equal((await req('chat', { id: chat.id })).status, 404)
})

test('edits an extracted observation with its citations and deletes its archive safely', async t => {
  const bench = await makeWorkbench(t, async () => JSON.stringify({ observations: [finding(1)] }))
  const req = makeRequest(bench)
  const batch = await deliveredBatch(bench)
  const harness = sessionHarness(bench, {}, batch.ready)
  const session = { id: 'deletion', header: {} }
  harness.start(session)
  harness.user(session, batch.prompt)
  harness.assistant(session, 'reply', [textBlock('这轮分析')])
  const endSeq = harness.end(session)
  await bench.sessionCapture
  await settled(bench)
  const link = await (await req('sessionResultLink', { session: session.id, endSeq })).json()
  const item = (await (await req('view', { day: link.day })).json()).items[0]
  const edited = await (await req('observation', {}, { ...item, day: '2026-11-14', title: '已补交付条件' })).json()
  assert.equal(edited.day, item.day)
  assert.equal(edited.sources.length, 1)
  const archiveId = edited.sources[0].archiveId
  const manual = await (await req('observation', {}, { ...item, id: undefined, title: '手动备注' })).json()

  assert.equal((await req('deleteArchive', {}, { id: archiveId })).status, 200)
  assert.equal((await req('observation', { id: item.id })).status, 404)
  assert.equal((await req('observation', { id: manual.id })).status, 200)
  assert.equal((await req('sessionResult', { id: link.id })).status, 404)
  assert.equal(bench.store.hasHandledSessionResult(link.id), true)
  assert.equal((await req('download', { id: archiveId })).status, 404)
  await assert.rejects(stat(join(bench.archives, `${archiveId}.zip`)), { code: 'ENOENT' })
  assert.equal((await bench.enqueue(native, { filename: '原始.zip', ingress: 'inbox' })).status, 'removed')

  const uploaded = await bench.enqueue(native, { filename: '新上传.zip', name: item.chat, ingress: 'upload' })
  assert.equal(uploaded.duplicate, false)
  await settled(bench)
  assert.equal((await req('deleteChat', {}, { id: item.chatId })).status, 200)
  assert.equal((await req('observation', { id: manual.id })).status, 404)
  assert.equal((await req('download', { id: uploaded.id })).status, 404)
  assert.deepEqual(bench.store.all('PRAGMA foreign_key_check'), [])
})

function sessionHarness(bench, archives, ready) {
  let listener
  let reads = 0
  let seq = 0
  const logs = new Map()
  const recover = watchSessionResults({
    on(event, callback) {
      assert.equal(event, 'session/event')
      listener = callback
    },
    attachments: { async *readFileStream(ref) { reads++; yield archives[ref.attachmentId] } },
    sessionQuery: { async observeSession(id) { return logs.get(id) } },
  }, bench, ready)
  function send(session, type, data, surfaceOp) {
    const event = { type, data, surfaceOp, seq: seq++, time: Date.parse('2026-11-14T12:30:00Z') }
    listener(session, event)
    return event.seq
  }
  return {
    send, recover, logs, get reads() { return reads },
    start: (session, turn = 1) => send(session, 'turn/start', { turn }),
    user: (session, content, source = { kind: 'user' }) => send(session, 'user/message', { content, source }, 'append'),
    assistant: (session, id, content, turn = 1) => send(session, 'assistant/message', { turn, message: { id, content } }),
    end: (session, kind = 'completed', turn = 1) => send(session, 'turn/end', { turn, reason: { kind } }),
  }
}

const textBlock = text => ({ type: 'text', text })
const fileBlock = (attachmentId, name, bytes) => ({ type: 'file', attachment: { attachmentId, name, bytes: bytes.length } })
const scene = [textBlock(`${WECHAT_SCENE_MARKER}\r\n阅读附件后给出结论和待办。`)]
const nativeFile = fileBlock('native', '聊天记录_20261114_204852.zip', native)

async function deliveredBatch(bench, batchId = '00000000-0000-4000-8000-000000000001', bytes = native, chatName = '真实微信会话名',
  ready = resolve(bench.inbox.directory, '..', '迁移后的微信流数据', '自定义投递目录')) {
  const batch = join(ready, batchId)
  const filename = '聊天记录 客户.zip'
  const path = join(batch, 'files', filename)
  await mkdir(join(batch, 'files'), { recursive: true })
  await writeFile(path, bytes)
  await writeFile(join(batch, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, batchId, action: 'hub',
    items: [{ relativePath: `files/${filename}`, displayName: filename, byteCount: bytes.length }],
  }))
  await writeFile(join(batch, 'state.json'), JSON.stringify({
    schemaVersion: 1, action: 'deepSeekHarness', targetName: 'DeepSeek Harness',
    outcome: { kind: 'delivered' }, chatName,
  }))
  const reference = path
  return { ready, batch, path, reference, filename, prompt: [textBlock(`${WECHAT_SCENE_MARKER}阅读聊天记录。 @"${reference}"`)] }
}

test('resolves the delivery directory from the host environment and recognizes native absolute paths', () => {
  assert.equal(wechatBridgeReady({ LOCALAPPDATA: 'Q:\\Profiles\\Local' }, 'win32'), 'Q:\\Profiles\\Local\\WeChatBridge\\Inbox\\Ready')
  assert.equal(wechatBridgeReady({ LIAOJIAN_WECHAT_READY_DIR: '/var/example/ready' }, 'darwin'), '/var/example/ready')
  assert.equal(wechatBridgeReady({ LIAOJIAN_WECHAT_READY_DIR: 'relative/ready' }, 'linux'), '')
  assert.equal(wechatBridgeReady({}, 'win32'), '')
  const tail = '00000000-0000-4000-8000-000000000001/files/客户.zip'
  assert.equal(wechatBridgePath(`//example.local/Profiles/Transfer/${tail}`), true)
  assert.equal(wechatBridgePath(`/var/example/ready/${tail}`), true)
  assert.equal(wechatBridgePath(`Transfer/${tail}`), false)
})

test('archives the desktop ZIP reference when the pasted scene marker is joined to the prompt', async t => {
  const bench = await makeWorkbench(t, async () => '{"observations":[]}')
  const batch = await deliveredBatch(bench)
  const harness = sessionHarness(bench, {}, batch.ready)
  const session = { id: 'desktop', header: { id: 'desktop' } }
  harness.start(session)
  harness.user(session, batch.prompt)
  harness.assistant(session, 'desktop-reply', [textBlock('保留这轮分析。')])
  const endSeq = harness.end(session)
  await bench.sessionCapture

  const req = makeRequest(bench)
  const link = await (await req('sessionResultLink', { session: session.id, endSeq })).json()
  assert.ok(link, '同一轮回复应已归档')
  const result = await (await req('sessionResult', { id: link.id })).json()
  assert.equal(result.reply, '保留这轮分析。')
  assert.equal(result.archives[0].chat, '真实微信会话名')
  assert.equal(harness.reads, 0)
})

test('keeps generic desktop deliveries together by batch and restores structured observations', async t => {
  const bench = await makeWorkbench(t, async () => JSON.stringify({ observations: [finding(1)] }))
  bench.store.saveSettings({ ...bench.store.settings(), aliases: ['我'] })
  const batch = await deliveredBatch(bench)
  const extra = zipOf({ '聊天记录.txt': entry('王一', '11:00', '请周一发清单。') })
  await writeFile(join(batch.batch, 'files', '第二批.zip'), extra)
  await writeFile(join(batch.batch, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, batchId: '00000000-0000-4000-8000-000000000001', items: [
      { relativePath: `files/${batch.filename}`, byteCount: native.length },
      { relativePath: 'files/第二批.zip', byteCount: extra.length },
    ],
  }))
  await writeFile(join(batch.batch, 'state.json'), JSON.stringify({
    schemaVersion: 1, action: 'deepSeekHarness', outcome: { kind: 'delivered' }, chatName: '微信',
  }))
  const harness = sessionHarness(bench, {}, batch.ready)
  const session = { id: 'batch-structured', header: {} }
  harness.start(session)
  harness.user(session, [...batch.prompt, textBlock(`@"${join(batch.batch, 'files', '第二批.zip')}"`)])
  harness.assistant(session, 'reply', [textBlock('## 重点\n- 周一前发送清单')])
  harness.end(session)
  await bench.sessionCapture
  await settled(bench)

  const view = bench.view(new URLSearchParams({ day: '2026-11-13', category: 'chats' }))
  assert.equal(view.items.length, 1)
  assert.notEqual(view.items[0].name, '微信')
  assert.equal(view.items[0].count, 3)
  assert.deepEqual({ ...view.report.stats.groups }, { related: 2, self: 1 })
  assert.equal(view.report.stats.followup, 2)
  assert.equal(bench.store.observation(view.report.highlights[0].id).sources[0].sender, '王一')

  const unrelatedZip = zipOf({ '聊天记录.txt': entry('韩四', '11:11', '试点需要一份清单。') })
  const independent = await deliveredBatch(bench, '00000000-0000-4000-8000-000000000002', unrelatedZip, '微信')
  harness.start(session, 2)
  harness.user(session, independent.prompt)
  harness.assistant(session, 'other-reply', [textBlock('另一批分析')], 2)
  harness.end(session, 'completed', 2)
  await bench.sessionCapture
  await settled(bench)
  const separated = bench.view(new URLSearchParams({ category: 'chats' }))
  assert.equal(separated.items.length, 2)
  assert.deepEqual(separated.items.map(item => item.count).sort(), [1, 3])
})

test('recovers the exact completed desktop turn from DSH history and reuses the saved result', async t => {
  const bench = await makeWorkbench(t, async () => '{"observations":[]}')
  const batch = await deliveredBatch(bench)
  const harness = sessionHarness(bench, {}, batch.ready)
  const events = [
    ['turn/start', { turn: 1 }],
    ['user/message', { source: { kind: 'user' }, content: batch.prompt }, 'append'],
    ['assistant/message', { turn: 1, message: { content: [textBlock('已完成的分析。')] } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ['turn/start', { turn: 2 }],
    ['user/message', { source: { kind: 'user' }, content: [textBlock(`普通问题 @"${batch.reference}"`)] }, 'append'],
    ['assistant/message', { turn: 2, message: { content: [textBlock('普通回复。')] } }],
    ['turn/end', { turn: 2, reason: { kind: 'completed' } }],
  ].map(([type, data, surfaceOp], seq) => ({ type, data, surfaceOp, seq, time: Date.parse('2026-11-14T12:30:00Z') }))
  harness.logs.set('saved-session', {
    header: { id: 'saved-session' }, inheritedEventCount: 0, events, [Symbol.dispose]() {},
  })
  const req = makeRequest(bench, harness.recover)
  const ordinary = await req('sessionResultLink', {}, { session: 'saved-session', endSeq: 7 })
  assert.equal(ordinary.status, 200)
  assert.equal(await ordinary.json(), null)
  const saved = { session: 'saved-session', endSeq: 3 }
  const response = await req('sessionResultLink', {}, saved)
  assert.equal(response.status, 200)
  const link = await response.json()
  assert.equal((await (await req('sessionResult', { id: link.id })).json()).reply, '已完成的分析。')
  assert.deepEqual(await (await req('sessionResultLink', {}, saved)).json(), link)
  assert.equal(bench.status().sessionRevision, 1)
})

test('requires a desktop ZIP in the delivery manifest for DeepSeek Harness', async t => {
  const bench = await makeWorkbench(t, () => assert.fail('无需调用模型'))
  const batch = await deliveredBatch(bench)
  const harness = sessionHarness(bench, {}, batch.ready)
  const session = { id: 'desktop-unverified', header: {} }
  const extra = join(batch.batch, 'files', '普通.zip')
  await writeFile(extra, native)
  const complete = async (turn, path) => {
    harness.start(session, turn)
    harness.user(session, [textBlock(`${WECHAT_SCENE_MARKER}阅读附件 @"${path}"`)])
    harness.assistant(session, 'reply', [textBlock('不应存入的回复')], turn)
    harness.end(session, 'completed', turn)
    await bench.sessionCapture
    assert.equal(bench.status().sessionRevision, 0)
    assert.equal(bench.status().jobs.length, 0)
  }
  await complete(1, extra)
  await writeFile(join(batch.batch, 'state.json'), JSON.stringify({
    schemaVersion: 1, action: 'codex', outcome: { kind: 'delivered' },
  }))
  await complete(2, batch.path)
  const external = await deliveredBatch(bench, undefined, native, '外部投递', resolve(batch.ready, '..', '另一个收件目录'))
  await complete(3, external.path)
  assert.match(bench.status().sessionError, /核对微信流投递记录/)
})

test('uses a DSH upload when the prompt also contains ZIP paths unavailable to the host', async t => {
  const bench = await makeWorkbench(t, async () => assert.fail('应先选择会话归属'))
  const remote = await deliveredBatch(bench, undefined, native, '客户端投递')
  const harness = sessionHarness(bench, { native }, resolve(remote.ready, '..', '服务端投递目录'))
  const session = { id: 'separate-client', header: {} }
  harness.start(session)
  harness.user(session, [...remote.prompt, textBlock(`@"${join(bench.inbox.directory, '临时文件.zip')}"`), nativeFile])
  harness.assistant(session, 'reply', [textBlock('附件分析')])
  const endSeq = harness.end(session)
  await bench.sessionCapture
  const req = makeRequest(bench)
  const link = await (await req('sessionResultLink', { session: session.id, endSeq })).json()
  const result = await (await req('sessionResult', { id: link.id })).json()
  assert.equal(harness.reads, 1)
  assert.equal(result.archives.length, 1)
  assert.equal(result.archives[0].filename, nativeFile.attachment.name)
  assert.equal(result.archives[0].status, 'pending')
})

test('archives the completed session reply verbatim, keeps the sources and reuses existing ZIPs', async t => {
  let analyses = 0
  const bench = await makeWorkbench(t, async () => { analyses++; return '{"observations":[]}' })
  const duplicate = await bench.enqueue(native, { filename: '客户群.zip', ingress: 'upload' })
  await settled(bench)
  const otherZip = zipOf({ '聊天记录.txt': entry('周二', '09:00', '这个月确定续约。') })
  const harness = sessionHarness(bench, { native, other: otherZip })
  const session = { id: 'target-session', header: {} }
  const feedback = { id: 'other-session', header: {} }
  const firstResult = '## 结论\n确认续约。'
  const secondResult = '## 待办\n周一前发上线清单。'
  harness.start(session)
  harness.user(session, [nativeFile, fileBlock('other', '第二批.zip', otherZip), ...scene])
  harness.assistant(session, 'step', [textBlock('正在读取'), { type: 'tool-call', id: 'tool' }])
  harness.start(feedback)
  harness.user(feedback, [textBlock('继续普通对话')])
  harness.assistant(feedback, 'unrelated', [textBlock('普通回复')])
  const unrelatedSeq = harness.end(feedback)
  harness.assistant(session, 'result', [textBlock(firstResult), { type: 'reasoning', text: '不入库的推理' }, textBlock(secondResult)])
  assert.equal(harness.reads, 0)
  const endSeq = harness.end(session)
  await bench.sessionCapture

  const req = makeRequest(bench)
  const link = await (await req('sessionResultLink', { session: session.id, endSeq })).json()
  const result = await (await req('sessionResult', { id: link.id })).json()
  assert.equal(analyses, 1)
  assert.equal(link.day, '2026-11-13')
  assert.equal(result.reply, `${firstResult}\n\n${secondResult}`)
  assert.equal(result.archives.length, 2)
  assert.equal(result.archives[0].id, duplicate.id)
  assert.equal(result.archives[1].status, 'pending')
  assert.equal((await (await req('sessionResultLink', { session: feedback.id, endSeq: unrelatedSeq })).json()), null)
  const report = await (await req('view', { day: '2026-11-14', period: 'weekly' })).json()
  assert.equal(report.sessionResults.length, 1)
  assert.equal(report.report.stats.messages, 2)
  assert.equal(report.sessionResults[0].pending, 1)
  const original = await req('download', { id: result.archives[1].id })
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), otherZip)

  const pending = (await (await req('view', { category: 'chats' })).json()).pendingArchives
  assert.deepEqual(pending.map(file => file.id), [result.archives[1].id])
  const existing = await req('assignArchive', {}, {
    id: pending[0].id, mode: 'existing', chatId: result.archives[0].chatId, kind: 'group',
  })
  assert.equal(existing.status, 200)
  assert.equal((await existing.json()).kind, 'group')
  await settled(bench)
  assert.equal(analyses, 2)
  const classified = await (await req('view', { day: link.day, category: 'chats' })).json()
  assert.equal(classified.items.length, 1)
  assert.equal(classified.items[0].count, 3)
  assert.deepEqual(classified.pendingArchives, [])

  harness.start(session, 2)
  harness.user(session, [...scene, nativeFile])
  harness.assistant(session, 'reused-zip', [textBlock('换一个角度分析。')], 2)
  harness.end(session, 'completed', 2)
  await bench.sessionCapture
  assert.equal(bench.status().sessionRevision, 2)
  assert.equal(bench.status().jobs.length, 2)
})

test('recovers existing generic session imports and lets the user create a marked chat', async t => {
  const bench = await makeWorkbench(t, async () => '{"observations":[]}')
  const archiveId = (await bench.enqueue(native, { filename: '微信.zip', ingress: 'session' })).id
  await settled(bench)
  const generic = bench.store.findChat('微信')
  // Model the old database: original messages existed, but session imports bypassed analysis.
  bench.store.db.exec('PRAGMA user_version = 0')
  const upgraded = new Store(join(bench.inbox.directory, '..'))
  try {
    assert.equal(upgraded.pendingArchives()[0].id, archiveId)
    assert.equal(upgraded.timeline(generic, { offset: 0, query: '' }).items.length, 2)
  } finally { upgraded.close() }

  let completeCalls = 0
  bench.complete = async () => { completeCalls++; return JSON.stringify({ observations: [finding(1)] }) }
  const req = makeRequest(bench)
  const response = await req('assignArchive', {}, { id: archiveId, mode: 'new', name: '王一', kind: 'private' })
  assert.equal(response.status, 200)
  const chat = await response.json()
  await settled(bench)
  assert.equal(completeCalls, 1)
  assert.equal(chat.kind, 'private')
  const view = await (await req('view', { day: '2026-11-13', category: 'chats' })).json()
  assert.deepEqual(view.items.map(item => item.name), ['王一'])
  assert.equal(view.report.stats.groups.related, 1)
  assert.equal((await req('assignArchive', {}, { id: archiveId, mode: 'new', name: '重复' })).status, 400)
})

test('formats a fenced Markdown reply with headings, lists and tables while escaping raw HTML', () => {
  const html = renderMarkdown('```markdown\n## 重点\n\n- **周一前**提交\n\n| 项目 | 负责人 |\n| --- | --- |\n| 清单 | 王一 |\n\n<b>示例</b>\n\n![图示](https://example.com/image)\n```')
  assert.match(html, /<h2>重点<\/h2>/)
  assert.match(html, /<li><strong>周一前<\/strong>提交<\/li>/)
  assert.match(html, /<table>/)
  assert.match(html, /&lt;b&gt;示例&lt;\/b&gt;/)
  assert.match(html, /<p>图示<\/p>/)
  assert.doesNotMatch(html, /<img/)
})

test('ignores ordinary turns, off-turn markers, non-owner prompts and failed replies', async t => {
  const bench = await makeWorkbench(t, () => assert.fail('会话归档无独立模型请求'))
  const nonWechat = zipOf({ 'chat.txt': first })
  const ordinaryFile = fileBlock('other', '普通.zip', nonWechat)
  const harness = sessionHarness(bench, { native, other: nonWechat })
  const session = { id: 's', header: {} }
  const scenarios = [
    { content: [textBlock('你好'), nativeFile] },
    { content: [textBlock(`引用的标记\n${WECHAT_SCENE_MARKER}`), nativeFile] },
    { content: scene },
    { content: [...scene, { type: 'image' }] },
    { content: [...scene, nativeFile], source: { kind: 'user', principal: { kind: 'guest' } } },
    { content: [...scene, nativeFile], source: { kind: 'plugin' } },
    { content: [...scene, nativeFile], mixed: true },
    { content: [...scene, nativeFile], kind: 'aborted' },
    { content: [...scene, nativeFile], kind: 'max-tokens' },
    { content: [...scene, nativeFile], callsTool: true },
  ]
  for (const [offset, { content, source, mixed, kind, callsTool }] of scenarios.entries()) {
    const turn = offset + 1
    harness.start(session, turn)
    harness.user(session, content, source)
    if (mixed) harness.user(session, [textBlock('我还在问另外一件事')])
    harness.assistant(session, `reply-${turn}`, [textBlock('原样回复'), ...(callsTool ? [{ type: 'tool-call' }] : [])], turn)
    harness.end(session, kind, turn)
  }
  const invalid = scenarios.length + 1
  harness.start(session, invalid)
  harness.user(session, [...scene, nativeFile, ordinaryFile])
  harness.assistant(session, 'bad-zip', [textBlock('普通 ZIP 的分析')], invalid)
  harness.end(session, 'completed', invalid)
  await bench.sessionCapture
  assert.equal(harness.reads, 2)
  assert.equal(bench.status().sessionRevision, 0)
  assert.equal(bench.status().jobs.length, 0)
  assert.match(bench.status().sessionError, /未识别到/)
})

test('reads native ZIPs with BOM, Chinese entry names, multiline text and attachment entries', async () => {
  const result = await readArchive(native)
  assert.equal(result.path, '聊天记录.txt')
  assert.deepEqual(result.records[0], {
    seq: 1, day: '2026-11-13', time: '10:02', sender: '王一', text: '能否周一前给一份上线清单？\n包含价格和测试条件。',
  })
  assert.equal(result.records[1].text, '可以，周一前先发草稿。')
  await assert.rejects(() => readArchive(zipOf({ '说明.txt': '普通文本' })), /未识别到/)
  await assert.rejects(() => readArchive(zipOf({ '聊天记录.txt': entry('小王', '08:00', '日期无效', '2026年2月30日') })), /时间格式/)
  await assert.rejects(() => readArchive(native.subarray(0, -10)), /损坏/)
})

test('adapts DSH output without a tool list and normalizes credential errors', async () => {
  const model = { provider: 'profile-route', model: 'profile-model' }
  let observed
  const ctx = {
    agentDefaultModel: { currentSelection: () => model },
    llm: { async *stream(request) {
      observed = request
      yield { type: 'reasoning-delta', text: 'not output' }
      yield { type: 'text-delta', text: '{"observations":' }
      yield { type: 'text-delta', text: '[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  assert.equal(await createComplete(ctx)('system instruction', 'chat data', new AbortController().signal), '{"observations":[]}')
  assert.equal(observed.provider, model.provider)
  assert.equal(observed.model, model.model)
  assert.equal(observed.tools, undefined)
  assert.equal(observed.messages[0].content[0].text, 'chat data')
  ctx.llm.stream = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } } } }
  await assert.rejects(() => createComplete(ctx)('system', 'data', new AbortController().signal), /凭据/)
})

test('uploads, grounds findings in source records, deduplicates, persists flags and exports verbatim ZIP', async t => {
  let analyzed = 0
  const bench = await makeWorkbench(t, async (_system, input) => {
    analyzed++
    const data = JSON.parse(input)
    assert.deepEqual(data.aliases, ['我'])
    return JSON.stringify({ observations: [finding(data.messages.find(row => row.new).seq)] })
  })
  bench.saveSettings({ ...defaultSettings, aliases: ['我'], daily: { enabled: false, time: '08:30' } })
  const req = makeRequest(bench)
  const response = await req('upload', { name: '群聊.zip', chat: '研发讨论群', kind: 'group' }, native)
  assert.equal(response.status, 202)
  const uploaded = await response.json()
  assert.equal(uploaded.duplicate, false)
  await settled(bench)
  assert.equal(bench.status().jobs[0].status, 'done')
  const page = await (await req('view', { day: '2026-11-13', kind: 'group' })).json()
  assert.deepEqual([page.report.stats.messages, page.report.stats.self, page.items.length], [2, 1, 2])
  assert.equal(page.report.generatedAt, undefined)
  const id = page.items.find(item => item.category === 'related').id
  const detail = await (await req('observation', { id })).json()
  assert.equal(detail.sources[0].sender, '王一')
  assert.equal(detail.sources[0].text, '能否周一前给一份上线清单？\n包含价格和测试条件。')
  assert.equal(detail.sources[0].transcript, '聊天记录.txt')
  assert.equal(detail.sources[0].archiveId, uploaded.id)
  assert.equal((await (await req('view', { day: '2026-01-01', q: '王一' })).json()).items[0].id, id)
  assert.equal((await (await req('view', { kind: 'private' })).json()).items.length, 0)
  assert.equal((await (await req('view', { category: 'followup' })).json()).items.length, 1)
  await req('mark', {}, { id, field: 'saved', value: true })
  await req('mark', {}, { id, field: 'done', value: true })
  assert.equal((await (await req('view', { category: 'saved', status: 'done' })).json()).items[0].id, id)
  assert.equal((await (await req('view', { category: 'followup' })).json()).items.length, 0)
  const timeline = await (await req('chat', { id: detail.chatId, anchor: detail.sources[0].id })).json()
  assert.equal(timeline.items.length, 2)
  const archive = await req('download', { id: uploaded.id })
  assert.deepEqual(Buffer.from(await archive.arrayBuffer()), native)
  const report = await (await req('report', {}, { period: 'weekly', day: '2026-11-13' })).json()
  assert.equal(report.start, '2026-11-09')
  assert.ok(report.generatedAt)
  assert.equal((await (await req('upload', { name: '副本.zip' }, native)).json()).duplicate, true)
  await req('chat', {}, { id: detail.chatId, name: '研发客户交流群', kind: 'group' })
  const overlapping = zipOf({ '聊天记录.txt': second + entry('王一', '10:04', '补充：需要验收条件。') })
  await req('upload', { name: '后续.zip', chat: '研发讨论群' }, overlapping)
  await settled(bench)
  assert.equal(analyzed, 2)
  assert.equal(bench.store.counts('2026-11-13', '2026-11-13').messages, 3)
  assert.equal(bench.store.counts('2026-11-13', '2026-11-13').allChats, 1)
  assert.equal((await (await req('observation', { id })).json()).chat, '研发客户交流群')
  const tooLarge = new Request('http://localhost/api/liaojian/upload?name=big.zip', {
    method: 'POST', headers: { 'content-length': String(MAX_ZIP_BYTES + 1), 'content-type': 'application/octet-stream' },
  })
  assert.equal((await workbenchRoute(bench)(tooLarge)).status, 400)
})

test('a model failure preserves the source and is retryable with validated citations', async t => {
  let attempt = 0
  const bench = await makeWorkbench(t, async () => {
    attempt++
    return JSON.stringify({ observations: [finding(attempt === 1 ? 999 : 1)] })
  })
  const req = makeRequest(bench)
  const uploaded = await (await req('upload', { name: '待办.zip' }, native)).json()
  await settled(bench)
  assert.equal(bench.status().jobs[0].status, 'failed')
  assert.match(bench.status().jobs[0].error, /原话/)
  assert.equal(bench.store.dates()[0].count, 2)
  assert.equal((await req('retry', {}, { id: uploaded.id })).status, 200)
  await settled(bench)
  assert.equal(bench.status().jobs[0].status, 'done')
  assert.equal(bench.store.report('daily', '2026-11-13').stats.observations, 1)
})

test('packs long messages into bounded model requests without silently dropping the tail', async t => {
  const parts = []
  const bench = await makeWorkbench(t, async (_system, input) => {
    assert.ok(Buffer.byteLength(input) < 39_000)
    for (const message of JSON.parse(input).messages) if (message.new) parts.push(message)
    return '{"observations":[]}'
  })
  const text = '中文🙂'.repeat(4000) + '最后的安排确认'
  await bench.enqueue(zipOf({ '聊天记录.txt': entry('成员', '09:45', text) }), { filename: '长文本.zip', ingress: 'upload' })
  await settled(bench)
  assert.equal(bench.status().jobs[0].status, 'done')
  assert.equal(parts.map(part => part.text).join(''), text)
  assert.ok(parts.every(part => part.seq === 1))
})

test('ingests WeChatBridge folder output with its note metadata and respects analysis scope', async t => {
  let calls = 0
  const bench = await makeWorkbench(t, async () => { calls++; return '{"observations":[]}' })
  const root = join(bench.inbox.directory, '微信流')
  const attachments = join(root, '附件')
  await mkdir(attachments, { recursive: true })
  await writeFile(join(root, '客户群.md'), '---\nsource: WeChat\nchat: "人工客户群"\narchive: "附件/归档.zip"\n---\n')
  const file = join(attachments, '归档.zip')
  await writeFile(file, native)
  const old = new Date(Date.now() - 5000)
  await utimes(file, old, old)
  bench.saveSettings({ ...defaultSettings, scope: ['另一个群'] })
  await bench.check()
  await settled(bench)
  assert.equal(calls, 0)
  assert.equal(bench.status().jobs[0].chat, '人工客户群')
  assert.equal(bench.status().jobs[0].ingress, 'inbox')
  assert.match(bench.status().jobs[0].progress, /分析范围外/)
  assert.equal(bench.store.dates()[0].count, 2)
})

test('uses configured China time and publishes the previous calendar week', () => {
  assert.deepEqual(dueReports(defaultSettings, new Date('2026-11-16T00:29:00Z')), [
    ['daily', '2026-11-14'], ['weekly', '2026-11-02'],
  ])
  assert.deepEqual(dueReports(defaultSettings, new Date('2026-11-16T01:00:00Z')), [
    ['daily', '2026-11-15'], ['weekly', '2026-11-09'],
  ])
})
