import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { join, posix, relative, sep, win32 } from 'node:path'
import { MAX_ZIP_BYTES, wechatBridgePath } from '../shared.js'
import { collectBytes, InputError } from './archive.js'

const METADATA_LIMIT = 256 * 1024
export class UnavailableWechatDelivery extends InputError {
  constructor() {
    super('无法在 DSH 主机核对微信流投递记录。请重新发送，或把原始 ZIP 作为 DSH 附件上传。')
  }
}
const invalidSource = () => new UnavailableWechatDelivery()
const isAbsolute = (path, platform) => platform === 'win32'
  ? win32.isAbsolute(path) && win32.parse(path).root.length > 1
  : posix.isAbsolute(path)

export function wechatBridgeReady(env = process.env, platform = process.platform) {
  const configured = env.LIAOJIAN_WECHAT_READY_DIR
  if (configured) return isAbsolute(configured, platform) ? configured : ''
  const appData = env.LOCALAPPDATA
  return platform === 'win32' && appData && isAbsolute(appData, platform)
    ? win32.join(appData, 'WeChatBridge', 'Inbox', 'Ready') : ''
}

export async function wechatBridgeArchive(ready, reference, signal) {
  if (!ready || !isAbsolute(ready, process.platform) || !isAbsolute(reference, process.platform) || !wechatBridgePath(reference)) {
    throw invalidSource()
  }
  const parts = relative(ready, reference).split(sep)
  if (parts.length !== 3 || parts[1].toLowerCase() !== 'files' || parts.some(part => !part || part === '..')) {
    throw invalidSource()
  }
  const [batchId, , filename] = parts
  try {
    const root = await realpath(ready)
    const directory = join(root, batchId)
    if (relative(directory, await realpath(directory))) throw invalidSource()
    const readMetadata = async name => {
      const path = join(directory, name)
      const info = await lstat(path)
      const resolved = await realpath(path)
      if (!info.isFile() || info.size > METADATA_LIMIT || relative(path, resolved)) throw invalidSource()
      return JSON.parse((await collectBytes(createReadStream(resolved, { signal }), METADATA_LIMIT, signal)).toString('utf8'))
    }
    const [manifest, state] = await Promise.all([readMetadata('manifest.json'), readMetadata('state.json')])
    if (manifest.schemaVersion !== 1 || manifest.batchId?.toLowerCase() !== batchId.toLowerCase() ||
        state.schemaVersion !== 1 || state.action !== 'deepSeekHarness' || state.outcome?.kind !== 'delivered') throw invalidSource()
    const item = manifest.items.find(item => item.relativePath?.replaceAll('\\', '/').toLowerCase() === `files/${filename}`.toLowerCase())
    if (!item || !Number.isSafeInteger(item.byteCount) || item.byteCount <= 0) throw invalidSource()
    if (item.byteCount > MAX_ZIP_BYTES) throw new InputError('单个 ZIP 最多 100 MB，可在微信流中分批转发。')
    const files = join(directory, 'files')
    if (relative(files, await realpath(files))) throw invalidSource()
    const path = join(files, filename)
    const info = await lstat(path)
    const resolved = await realpath(path)
    if (!info.isFile() || info.size !== item.byteCount || relative(path, resolved)) throw invalidSource()
    return {
      name: item.displayName || filename,
      chatName: state.chatName,
      batchId: batchId.toLowerCase(),
      stream: createReadStream(resolved, { signal }),
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof InputError) throw error
    throw invalidSource()
  }
}
