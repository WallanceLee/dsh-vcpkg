/**
 * The vcpkg installed-package database.
 *
 * `vcpkg list` is a thin reader over `<install-root>/vcpkg/status`, a Debian
 * control file. Reading the file directly is faster, does not need a
 * bootstrapped `vcpkg` binary, and still works when `VCPKG_ROOT` points at the
 * wrong tree, which is when an inventory question tends to come up.
 *
 * Record shape:
 *
 *     Package: basisu
 *     Version: 2.50
 *     Architecture: arm64-osx
 *     Abi: 7ffac6d2…
 *     Depends: vcpkg-cmake, vcpkg-cmake-config, zstd
 *     Description: Basis Universal is a supercompressed GPU texture …
 *     Feature: astc
 *     Status: install ok installed
 *
 * @module dsh-vcpkg/core/status-db
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { messageOf } from './runner.js'

/** Cap one description so a full inventory stays inside a model-friendly budget. */
const DESCRIPTION_LIMIT = 240

/**
 * Where the installed database lives for one install root.
 * @param {string} installRoot - the directory holding `vcpkg/` and the triplet directories.
 * @returns {string} the absolute status file path.
 */
export function statusFilePath(installRoot) {
  return join(installRoot, 'vcpkg', 'status')
}

/**
 * Parse the status database.
 *
 * One port contributes more than one record: a base record carrying `Version`,
 * and one record per enabled feature carrying `Feature:` and no version. They
 * are merged by package name here, because every caller wants "what is
 * installed and with which features" and nobody wants two rows named `gdal`.
 * @param {string} text - the file contents.
 * @returns {object[]} one merged record per installed package, sorted by name.
 */
export function parseStatusDb(text) {
  /** @type {Map<string, object>} */
  const byName = new Map()

  /**
   * Fetch or create the record for one package name.
   * @param {string} name - the package name.
   * @returns {object} the mutable record.
   */
  function recordFor(name) {
    let record = byName.get(name)
    if (record === undefined) {
      record = {
        name,
        version: '',
        baseVersion: '',
        portVersion: 0,
        architecture: '',
        abi: null,
        description: null,
        defaultFeatures: [],
        depends: [],
        features: [],
        featureDescriptions: {},
      }
      byName.set(name, record)
    }
    return record
  }

  for (const block of text.split(/\n[ \t]*\n/)) {
    if (block.trim().length === 0) continue
    const fields = new Map()
    /** @type {string[]} */
    const featureLines = []
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/.exec(line)
      if (match === null) continue
      if (match[1] === 'Feature') {
        const feature = match[2].trim()
        if (feature.length > 0) featureLines.push(feature)
        continue
      }
      // A repeated key keeps its first value; Debian control has no repeats here.
      if (!fields.has(match[1])) fields.set(match[1], match[2].trim())
    }

    const name = fields.get('Package')
    if (typeof name !== 'string' || name.length === 0) continue
    // The status field is `<want> <flag> <status>`; only the exact status word
    // `installed` counts. A substring test would also accept `not-installed`,
    // which is how a purge leaves its record behind.
    const status = (fields.get('Status') ?? '').trim().split(/\s+/)
    if (status[status.length - 1] !== 'installed') continue

    const record = recordFor(name)
    const description = fields.get('Description') ?? null

    if (featureLines.length > 0) {
      for (const feature of featureLines) {
        if (!record.features.includes(feature)) record.features.push(feature)
        if (description !== null) record.featureDescriptions[feature] = description.slice(0, DESCRIPTION_LIMIT)
      }
      continue
    }

    const baseVersion = fields.get('Version') ?? ''
    const portVersion = Number.parseInt(fields.get('Port-Version') ?? '0', 10)
    record.baseVersion = baseVersion
    record.portVersion = Number.isInteger(portVersion) && portVersion > 0 ? portVersion : 0
    // Match `vcpkg list`'s own rendering of a port version.
    record.version = record.portVersion > 0 ? `${baseVersion}#${record.portVersion}` : baseVersion
    record.architecture = fields.get('Architecture') ?? ''
    record.abi = fields.get('Abi') ?? null
    record.description = description === null ? null : description.slice(0, DESCRIPTION_LIMIT)
    record.defaultFeatures = (fields.get('Default-Features') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    record.depends = (fields.get('Depends') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  const packages = [...byName.values()]
  for (const record of packages) record.features.sort((left, right) => left.localeCompare(right))
  packages.sort((left, right) => left.name.localeCompare(right.name))
  return packages
}

/**
 * Read the installed database for one install root.
 * @param {string} installRoot - the directory holding `vcpkg/`.
 * @returns {Promise<{ ok: true, path: string, packages: object[] } | { ok: false, path: string, error: string }>}
 *   the inventory.
 */
export async function readInstalledPackages(installRoot) {
  const path = statusFilePath(installRoot)
  if (!existsSync(path)) {
    return { ok: false, path, error: `no installed-package database at ${path}` }
  }
  try {
    return { ok: true, path, packages: parseStatusDb(await readFile(path, 'utf8')) }
  } catch (error) {
    return { ok: false, path, error: `cannot read ${path}: ${messageOf(error)}` }
  }
}

/**
 * Install roots worth checking for a project, most specific first.
 * @param {object} options - the inputs.
 * @param {string} projectDir - the call's anchor directory.
 * @param {string | null} [manifestRoot] - the directory holding `vcpkg.json`.
 * @param {string | null} [outDir] - a Cargo/CMake build output directory to prefer.
 * @returns {string[]} absolute candidate install roots, deduped.
 */
export function candidateInstallRoots({ projectDir, manifestRoot = null, outDir = null }) {
  const roots = []
  const push = (path) => {
    if (path === null || roots.includes(path)) return
    roots.push(path)
  }
  if (outDir !== null) push(join(outDir, 'build', 'vcpkg_installed'))
  if (outDir !== null) push(join(outDir, 'vcpkg_installed'))
  if (manifestRoot !== null) push(join(manifestRoot, 'vcpkg_installed'))
  push(join(projectDir, 'vcpkg_installed'))
  push(join(projectDir, 'crates', 'native', 'vcpkg_installed'))
  push(join(projectDir, 'build', 'cmake_build', 'vcpkg_installed'))
  push(join(projectDir, 'crates', 'native', 'build', 'cmake_build', 'vcpkg_installed'))
  return roots
}

/**
 * Pick the install root that actually has a database.
 * @param {object} options - the inputs.
 * @param {string[]} options.candidates - ordered candidate roots.
 * @param {string | null} [options.explicit] - a caller-named root.
 * @returns {Promise<{ installRoot: string | null, checked: { path: string, hasDatabase: boolean }[] }>}
 *   the selection and everything that was checked.
 */
export async function selectInstallRoot({ candidates, explicit = null }) {
  const ordered = explicit === null ? candidates : [explicit, ...candidates]
  const checked = ordered.map((path) => ({ path, hasDatabase: existsSync(statusFilePath(path)) }))
  const chosen = checked.find((entry) => entry.hasDatabase) ?? null
  return { installRoot: chosen?.path ?? explicit ?? null, checked }
}
