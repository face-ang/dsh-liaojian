import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_ZIP_BYTES } from '../shared.js'
import { createComplete } from './analysis.js'
import { archiveName, collectBytes, InputError } from './archive.js'
import { workbenchRoute } from './http.js'
import { watchSessionResults } from './session.js'
import { Workbench } from './workbench.js'

export const name = 'liaojian-workbench'
export const inject = ['connection', 'llm', 'agentDefaultModel', 'commands', 'attachments', 'sessions', 'sessionQuery']

function command(ctx, workbench) {
  return ctx.commands.register({
    name: 'liaojian',
    description: '将微信流 ZIP 导入聊笺工作台',
    input: { hint: '[会话名称] · 附上微信原始 ZIP', attachments: true },
    recordInput: false,
    async handler({ rawInput, attachments, signal }) {
      const principal = ctx.get('invocation')?.peer.principal
      if (principal && principal.kind !== 'owner') return { kind: 'error', text: '只有工作台所有者可以导入。' }
      if (!attachments.length) return { kind: 'error', text: '请附上微信流投递的 ZIP，再发送 /liaojian。' }
      let files
      try {
        files = attachments.map(block => {
          if (block.type !== 'file') throw new InputError('请选择聊天记录的 ZIP 附件。')
          if (block.attachment.bytes > MAX_ZIP_BYTES) throw new InputError('单个 ZIP 最多 100 MB，可在微信流中分批转发。')
          return { attachment: block.attachment, filename: archiveName(block.attachment.name) }
        })
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
      let added = 0
      let duplicates = 0
      const failures = []
      for (const { filename, attachment } of files) {
        try {
          const bytes = await collectBytes(ctx.attachments.readFileStream(attachment, signal), MAX_ZIP_BYTES, signal)
          const result = await workbench.enqueue(bytes, { filename, name: rawInput, ingress: 'command' })
          if (result.duplicate) duplicates++
          else added++
        } catch (error) {
          signal.throwIfAborted()
          failures.push(`${filename}：${error instanceof InputError ? error.message : '导入失败'}`)
        }
      }
      const count = `已接收 ${added} 个 ZIP${duplicates ? `，跳过 ${duplicates} 个重复 ZIP` : ''}。`
      return failures.length
        ? { kind: 'error', text: `${count}\n${failures.join('\n')}` }
        : { kind: 'success', text: `${count}在侧栏打开「聊笺」查看分析结果。` }
    },
  })
}

export async function apply(ctx) {
  const home = ctx.get('dshHomePath')
  const directory = home ? home('liaojian') : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'liaojian')
  const workbench = new Workbench(directory, createComplete(ctx))
  const stop = await workbench.start()
  ctx.effect(() => stop, 'liaojian: storage and scheduler')
  const recover = watchSessionResults(ctx, workbench)
  const fetch = workbenchRoute(workbench, recover)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/liaojian', methods: ['GET', 'POST'], requestBody: 'buffered', fetch,
  }), 'liaojian: workbench API')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/liaojian/upload', methods: ['POST'], requestBody: 'streaming', fetch,
  }), 'liaojian: ZIP intake')
  ctx.effect(() => command(ctx, workbench), 'liaojian: import command')
}
