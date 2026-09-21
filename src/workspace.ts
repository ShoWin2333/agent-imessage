import { access, constants, stat } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_PHOTON_PROJECT_NAME } from './constants.js'
import { PluginError } from './errors.js'
import { unwrapCopiedPath } from './path-shape.js'

/** Photon project names allowed in settings and provisioning. */
const PHOTON_PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Trim and validate a Photon project name; empty input becomes the default. */
export function normalizePhotonProjectName(input: string | undefined): string {
  const value = input?.trim() ?? ''
  if (value.length === 0) return DEFAULT_PHOTON_PROJECT_NAME
  if (!PHOTON_PROJECT_NAME_PATTERN.test(value)) {
    throw new PluginError(
      'invalid-project-name',
      'Photon project names must start with a letter or digit and use only letters, digits, ".", "_", or "-" (max 64 characters).',
    )
  }
  return value
}

/**
 * Resolve the workspace directory used for iMessage sessions.
 * An empty/undefined override falls back to `process.cwd()`.
 */
export async function resolveWorkspaceCwd(input: string | undefined, fallback = process.cwd()): Promise<string> {
  const raw = unwrapCopiedPath(input ?? '')
  if (raw.length === 0) return path.resolve(fallback)
  if (!path.isAbsolute(raw)) {
    throw new PluginError(
      'invalid-workspace',
      'Workspace path must be an absolute directory path.',
    )
  }
  const resolved = path.resolve(raw)
  try {
    await access(resolved, constants.R_OK)
    const info = await stat(resolved)
    if (!info.isDirectory()) {
      throw new PluginError('invalid-workspace', 'Workspace path must be an existing directory.')
    }
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError('invalid-workspace', 'Workspace path must be an existing readable directory.')
  }
  return resolved
}
