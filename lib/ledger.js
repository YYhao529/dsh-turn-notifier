/**
 * Persistence for the daily spend ledger.
 *
 * The ledger lives inside the plugin folder (`data/usage.json`) so the plugin
 * stays self-contained: nothing is written to the Harness profile, the user home
 * or a temp directory that may be cleared. Only Beijing dates and integer
 * micro-yuan totals are stored, and the file is replaced atomically so a crash
 * mid-write cannot leave half a JSON document behind.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const FILE_VERSION = 1

/**
 * Read the ledger. A missing, unreadable or malformed file is treated as empty:
 * losing a day total is much better than nagging on every turn with an error.
 *
 * @param {string} filePath
 * @returns {{days: Record<string, number>, version: number}}
 */
export function readLedger(filePath) {
  const empty = { days: {}, version: FILE_VERSION }
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw)
    const days = parsed?.days
    if (!days || typeof days !== 'object') return empty
    return { days, version: Number(parsed.version) || FILE_VERSION }
  } catch {
    return empty
  }
}

/**
 * Replace the ledger file. `days` maps a Beijing date (`2026-11-25`) to spent
 * micro-yuan.
 *
 * @param {string} filePath
 * @param {Record<string, number>} days
 */
export function writeLedger(filePath, days) {
  const body = `${JSON.stringify({ version: FILE_VERSION, days }, undefined, 2)}\n`
  const temporary = `${filePath}.tmp`
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(temporary, body, 'utf8')
  try {
    renameSync(temporary, filePath)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {}
    throw error
  }
}
