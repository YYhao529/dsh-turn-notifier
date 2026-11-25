// Session logs are written as a series of concatenated zstd frames, one batch of
// JSONL records per frame. Node's zstd support stops after the first frame of a
// concatenated stream, so the log has to be walked frame by frame: each pass
// feeds the decompressor from the current offset and reports how many input
// bytes that frame consumed. This module is the single copy of that loop; the
// probe and the replay both use it.
import { createZstdDecompress } from 'node:zlib'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOG_NAME = 'session.v4.jsonl.zstd'

const decompressFrame = (slice) =>
  new Promise((resolve) => {
    const decompressor = createZstdDecompress()
    const chunks = []
    decompressor.on('data', (chunk) => chunks.push(chunk))
    // A live session's last frame can be cut in half; keep whatever decoded.
    decompressor.on('error', () => resolve({ output: Buffer.concat(chunks), consumed: 0 }))
    decompressor.on('end', () =>
      resolve({ output: Buffer.concat(chunks), consumed: decompressor.bytesWritten }),
    )
    decompressor.end(slice)
  })

/** Decode every frame of a concatenated zstd buffer. */
export async function decompressFrames(buffer) {
  const chunks = []
  let position = 0
  let frames = 0
  while (position < buffer.length - 4) {
    const { output, consumed } = await decompressFrame(buffer.subarray(position))
    if (output.length > 0) chunks.push(output)
    if (consumed <= 0) break
    frames += 1
    position += consumed
  }
  // Nothing decoded out of a non-empty file means it is not a zstd log; say so
  // instead of returning an empty string that reads like "no events".
  if (frames === 0 && buffer.length > 0) throw new Error('不是有效的 zstd 日志')
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse a decoded log into records, skipping any partial trailing line. */
export function parseRecords(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {}
  }
  return records
}

/**
 * Newest session log below `~/.dsh/sessions`, so the dev tools can be run
 * without hunting for a path. Each session directory is named `session-<id>`.
 */
export function findLatestSessionLog(root = join(homedir(), '.dsh', 'sessions')) {
  const found = []
  const list = (directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const workspace of list(root)) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    for (const session of list(workspacePath)) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue
      const path = join(workspacePath, session.name, LOG_NAME)
      try {
        found.push({ path, mtimeMs: statSync(path).mtimeMs })
      } catch {}
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found[0]?.path
}
