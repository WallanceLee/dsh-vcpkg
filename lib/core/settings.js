/**
 * The machine-local settings file this plugin owns: `<dshHome>/vcpkg.json`.
 *
 * A pinned vcpkg tree and a pinned proxy describe one machine rather than one
 * deployment, so they live beside the other Harness-home state (`memory.json`,
 * `settings.yaml`) instead of in `cordis.patch.yml`. The file is optional.
 * Every reader tolerates its absence, and an unparseable file becomes a warning
 * instead of a throw, so a broken settings file cannot take the diagnostic
 * tools down with it.
 *
 * @module dsh-vcpkg/core/settings
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { messageOf } from './runner.js'

/** Recognized keys; anything else in the file is preserved verbatim on write. */
export const SETTINGS_KEYS = ['vcpkgRoot', 'proxy', 'noProxy', 'proxyCandidates', 'triplet']

/**
 * Resolve the DeepSeek Harness home the same way the runtime does: `DSH_HOME`
 * when it is set and non-empty, else `~/.dsh`.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} the absolute Harness home.
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME
  const selected = configured !== undefined && configured.trim().length > 0
    ? configured
    : join(homedir(), '.dsh')
  return resolve(selected)
}

/**
 * Absolute path of this plugin's settings file.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} the absolute settings path.
 */
export function settingsPath(env = process.env) {
  return join(resolveDshHome(env), 'vcpkg.json')
}

/**
 * Read the settings file.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {Promise<{ path: string, values: Record<string, unknown>, exists: boolean, warning?: string }>}
 *   the parsed settings; `values` is empty when the file is absent or unreadable.
 */
export async function readSettings(env = process.env) {
  const path = settingsPath(env)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { path, values: {}, exists: false }
    return { path, values: {}, exists: true, warning: `cannot read ${path}: ${messageOf(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { path, values: {}, exists: true, warning: `cannot parse ${path}: ${messageOf(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path, values: {}, exists: true, warning: `${path} must hold a JSON object` }
  }
  return { path, values: parsed, exists: true }
}

/**
 * Merge `patch` into the settings file with an atomic replace. A `null` value
 * deletes the key, so `clear` does not leave an empty string behind that later
 * readers have to special-case.
 * @param {Record<string, unknown>} patch - keys to set; `null` deletes.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {Promise<{ path: string, values: Record<string, unknown>, changed: string[] }>}
 *   the persisted settings and the keys that changed.
 */
export async function writeSettings(patch, env = process.env) {
  const current = await readSettings(env)
  const values = { ...current.values }
  const changed = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      if (key in values) {
        delete values[key]
        changed.push(key)
      }
      continue
    }
    if (JSON.stringify(values[key]) === JSON.stringify(value)) continue
    values[key] = value
    changed.push(key)
  }
  if (changed.length === 0) return { path: current.path, values, changed }
  const path = current.path
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return { path, values, changed }
}
