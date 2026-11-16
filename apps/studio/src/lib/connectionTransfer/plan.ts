import {
  PortableConnection,
  displayName,
  identityKey,
  rejectionReason,
} from './portable'

export interface ImportRow {
  index: number
  name: string
  broken: boolean
  conflict: boolean
  matches: string[]
}

export interface ImportResult {
  imported: number
  skipped: number
  alreadyExists: number
  skippedNames: string[]
  missingKeyNames: string[]
}

export function buildPreview(incoming: PortableConnection[], existing: PortableConnection[]): ImportRow[] {
  const existingByKey = new Map<string, string[]>()
  for (const connection of existing) {
    const key = identityKey(connection)
    if (!key) continue
    const names = existingByKey.get(key) ?? []
    names.push(displayName(connection))
    existingByKey.set(key, names)
  }

  const earlierByKey = new Map<string, string>()
  return incoming.map((connection, index) => {
    const broken = rejectionReason(connection) !== null
    const name = displayName(connection)
    const key = identityKey(connection)
    const matches: string[] = []
    if (key) {
      matches.push(...(existingByKey.get(key) ?? []))
      const earlier = earlierByKey.get(key)
      if (earlier) matches.push(earlier)
      if (!earlierByKey.has(key)) earlierByKey.set(key, name)
    }
    const unique = [...new Set(matches)]
    return {
      index,
      name,
      broken,
      conflict: !broken && unique.length > 0,
      matches: broken ? [] : unique,
    }
  })
}

export function canExportConnections(selectedCount: number, passphrase: string, confirm: string): boolean {
  return selectedCount > 0 && passphrase === confirm
}

export function formatExportNotice(count: number): string {
  return count === 1 ? 'Exported 1 connection' : `Exported ${count} connections`
}

export function formatDeletedCount(count: number): string {
  const noun = count === 1 ? 'saved connection' : 'saved connections'
  return `${count} ${noun} will be deleted.`
}

export function formatImportCounts(result: Pick<ImportResult, 'imported' | 'skipped' | 'alreadyExists'>): string {
  return `Imported ${result.imported}, skipped ${result.skipped}, already exists ${result.alreadyExists}.`
}
