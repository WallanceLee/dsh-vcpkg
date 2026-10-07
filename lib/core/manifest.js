/**
 * Reading `vcpkg.json` and reconciling it with what is actually installed.
 *
 * The reconciliation is the point. "My build fails because a port is missing"
 * and "the manifest declares twenty ports and the install root has none" are
 * the same question asked at different sizes, and both are answered by diffing
 * the declared dependency list against the installed status database rather
 * than by reading either one alone.
 *
 * @module dsh-vcpkg/core/manifest
 */

import { readFile } from 'node:fs/promises'

import { messageOf } from './runner.js'

/** Top-level keys this module understands; anything else is reported, not dropped. */
const KNOWN_KEYS = new Set([
  '$schema', 'name', 'version', 'version-string', 'version-semver', 'version-date',
  'builtin-baseline', 'dependencies', 'features', 'overrides', 'vcpkg-configuration',
  'description', 'homepage', 'documentation', 'license', 'maintainers', 'supports',
])

/** The four mutually exclusive version declaration keys, in priority order. */
const VERSION_KEYS = ['version', 'version-semver', 'version-date', 'version-string']

/**
 * Normalize one dependency entry to one shape.
 *
 * A manifest entry is either a bare port name or an object; the object form
 * carries the feature selection, which is exactly what the installed status
 * database records per package, so both sides of the diff can be compared.
 * @param {unknown} entry - the raw entry from `dependencies`.
 * @returns {{ name: string, features: string[], defaultFeatures: boolean, host: boolean, platform: string | null } | null}
 *   the normalized entry, or null when it is not a dependency.
 */
export function normalizeDependency(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim()
    return name.length === 0 ? null : { name, features: [], defaultFeatures: true, host: false, platform: null }
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name.length === 0) return null
  return {
    name,
    features: Array.isArray(entry.features) ? entry.features.filter((f) => typeof f === 'string') : [],
    defaultFeatures: entry['default-features'] !== false,
    host: entry.host === true,
    platform: typeof entry.platform === 'string' ? entry.platform : null,
  }
}

/**
 * Normalize a parsed `vcpkg.json` into the shape the tools report.
 * @param {object} parsed - the parsed JSON object.
 * @param {string} path - the manifest path, for reporting.
 * @returns {object} the normalized manifest.
 */
export function normalizeManifest(parsed, path) {
  const versionKey = VERSION_KEYS.find((key) => typeof parsed[key] === 'string')
  const dependencies = []
  for (const entry of Array.isArray(parsed.dependencies) ? parsed.dependencies : []) {
    const normalized = normalizeDependency(entry)
    if (normalized !== null) dependencies.push(normalized)
  }
  const overrides = (Array.isArray(parsed.overrides) ? parsed.overrides : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string')
    .map((entry) => ({
      name: entry.name,
      version: entry.version ?? entry['version-semver'] ?? entry['version-date'] ?? entry['version-string'] ?? null,
      portVersion: entry['port-version'] ?? 0,
    }))
  const features = {}
  if (parsed.features !== null && typeof parsed.features === 'object' && !Array.isArray(parsed.features)) {
    for (const [key, value] of Object.entries(parsed.features)) {
      const list = []
      for (const entry of Array.isArray(value?.dependencies) ? value.dependencies : []) {
        const normalized = normalizeDependency(entry)
        if (normalized !== null) list.push(normalized.name)
      }
      features[key] = { description: typeof value?.description === 'string' ? value.description : null, dependencies: list }
    }
  }
  return {
    path,
    name: typeof parsed.name === 'string' ? parsed.name : null,
    version: versionKey === undefined ? null : parsed[versionKey],
    versionKey: versionKey ?? null,
    builtinBaseline: typeof parsed['builtin-baseline'] === 'string' ? parsed['builtin-baseline'] : null,
    dependencies,
    overrides,
    features,
    vcpkgConfiguration: parsed['vcpkg-configuration'] ?? null,
    description: typeof parsed.description === 'string' ? parsed.description : null,
    unknownKeys: Object.keys(parsed).filter((key) => !KNOWN_KEYS.has(key)),
  }
}

/**
 * Read and normalize a `vcpkg.json`.
 * @param {string} path - the manifest path.
 * @returns {Promise<{ ok: true, manifest: object } | { ok: false, error: string }>} the read result.
 */
export async function readManifest(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return { ok: false, error: `cannot read ${path}: ${messageOf(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(stripJsonComments(text))
  } catch (error) {
    return { ok: false, error: `cannot parse ${path}: ${messageOf(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `${path} must hold a JSON object` }
  }
  return { ok: true, manifest: normalizeManifest(parsed, path) }
}

/**
 * Remove the comment forms vcpkg's manifest parser tolerates, so a manifest
 * that `vcpkg install` accepts does not fail this reader.
 * @param {string} text - the raw manifest text.
 * @returns {string} the text with comments blanked out.
 */
export function stripJsonComments(text) {
  let output = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        output += char
      }
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      output += char
      if (char === '\\') {
        output += next ?? ''
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && next === '/') {
      inLineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }
    output += char
  }
  return output
}

/**
 * Diff the declared dependencies against the installed status database.
 *
 * Feature selection is compared too: `gdal[iconv]` declares a feature that the
 * status database records per package, so a manifest asking for a feature the
 * installed port was built without is reported as unsatisfied rather than
 * silently passing.
 * @param {object} manifest - a normalized manifest.
 * @param {{ name: string, version: string, features: string[] }[]} installed - status-database records.
 * @returns {object} the reconciliation.
 */
export function reconcile(manifest, installed) {
  const index = new Map(installed.map((record) => [record.name.toLowerCase(), record]))
  const satisfied = []
  const missing = []
  const missingFeatures = []
  for (const dependency of manifest.dependencies) {
    const record = index.get(dependency.name.toLowerCase())
    if (record === undefined) {
      missing.push({ name: dependency.name, features: dependency.features, defaultFeatures: dependency.defaultFeatures, host: dependency.host })
      continue
    }
    const present = new Set(record.features.map((feature) => feature.toLowerCase()))
    const absent = dependency.features.filter((feature) => !present.has(feature.toLowerCase()))
    if (absent.length > 0) {
      missingFeatures.push({ name: dependency.name, installedVersion: record.version, missingFeatures: absent, installedFeatures: record.features })
      continue
    }
    satisfied.push({ name: dependency.name, version: record.version, features: dependency.features })
  }
  return {
    declared: manifest.dependencies.length,
    installedTotal: installed.length,
    satisfied,
    missing,
    missingFeatures,
    complete: missing.length === 0 && missingFeatures.length === 0,
  }
}

/**
 * Render a manifest report as model-facing text.
 * @param {object} report - the manifest report assembled by the tool.
 * @returns {string} the rendered report.
 */
export function renderManifest(report) {
  const lines = []
  const manifest = report.manifest
  lines.push(`manifest: ${manifest.path}`)
  lines.push(`  name: ${manifest.name ?? '<unnamed>'}`)
  if (manifest.version !== null) lines.push(`  version: ${manifest.version} (${manifest.versionKey})`)
  lines.push(`  builtin-baseline: ${manifest.builtinBaseline ?? '<none>'}`)
  lines.push(`  declared dependencies: ${manifest.dependencies.length}`)
  if (manifest.overrides.length > 0) {
    lines.push(`  overrides: ${manifest.overrides.map((entry) => `${entry.name}@${entry.version}`).join(', ')}`)
  }
  if (Object.keys(manifest.features).length > 0) {
    lines.push(`  declared features: ${Object.keys(manifest.features).join(', ')}`)
  }
  if (manifest.unknownKeys.length > 0) lines.push(`  unrecognized keys: ${manifest.unknownKeys.join(', ')}`)

  const reconciliation = report.reconciliation
  if (reconciliation === null) {
    lines.push('installed: unknown (no readable vcpkg status database for this install root)')
    return lines.join('\n')
  }
  lines.push(`installed (${report.installRoot ?? 'unknown root'}, triplet ${report.triplet ?? '?'}): ${reconciliation.installedTotal} packages`)
  lines.push(`  satisfied: ${reconciliation.satisfied.length}/${reconciliation.declared}`)
  if (reconciliation.missing.length > 0) {
    lines.push(`  MISSING (${reconciliation.missing.length}): ${reconciliation.missing.map((entry) => entry.name).join(', ')}`)
  }
  if (reconciliation.missingFeatures.length > 0) {
    for (const entry of reconciliation.missingFeatures) {
      lines.push(`  MISSING FEATURES: ${entry.name} is installed at ${entry.installedVersion} but without ${entry.missingFeatures.join(', ')}`)
    }
  }
  if (reconciliation.complete) lines.push('  every declared dependency and feature is installed')
  return lines.join('\n')
}
