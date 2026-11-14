import { deflateRawSync, crc32 } from 'node:zlib'

// Native WeChat exports can use UTF-8 entry names with the UTF-8 flag cleared.
export function zipOf(entries) {
  const files = []
  const directory = []
  let offset = 0
  for (const [path, content] of Object.entries(entries)) {
    const filename = Buffer.from(path)
    const plain = Buffer.from(content)
    const compressed = deflateRawSync(plain)
    const crc = crc32(plain)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(plain.length, 22)
    local.writeUInt16LE(filename.length, 26)
    files.push(local, filename, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(plain.length, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, filename)
    offset += local.length + filename.length + compressed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(directory.length / 2, 8)
  end.writeUInt16LE(directory.length / 2, 10)
  end.writeUInt32LE(Buffer.concat(directory).length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, ...directory, end])
}

export function entry(sender, time, body, date = '2026年11月13日') {
  return `·${sender}\r\n${date} ${time}\r\n${body}\r\n\r\n`
}
