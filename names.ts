import fs from 'fs'

/**
 * Display names, deliberately kept out of the sing-box configuration.
 *
 * sing-box needs a UUID to authenticate a device and a tag to reference a
 * tunnel — neither has to be readable. Keeping the human-readable name here
 * instead means a rename writes this file and nothing else: the service
 * configuration is not rewritten, not revalidated, not restarted, and no
 * connection is dropped for what is a cosmetic change.
 *
 * Keys are the stable identifiers — a device UUID, or `wg:<id>` for a tunnel,
 * neither of which changes for the life of the thing it names. Losing this
 * file costs labels and nothing else: every device and tunnel keeps working.
 */
export type Names = Record<string, string>

export function readNames(file: string): Names {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    // Missing or unreadable is not an error: names are a convenience, and
    // starting with none is better than refusing to start at all.
    return {}
  }
}

export function writeNames(file: string, names: Names): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(names, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}
