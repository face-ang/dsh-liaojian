import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_ZIP_BYTES, defaultSettings } from '../shared.js'
import { createComplete } from '../host/analysis.js'
import { readArchive } from '../host/archive.js'
import { workbenchRoute } from '../host/http.js'
import { dueReports } from '../host/store.js'
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

function makeRequest(bench) {
  const route = workbenchRoute(bench)
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
