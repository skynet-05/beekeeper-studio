import { promises as fs } from 'fs'
import { In } from 'typeorm'
import { SavedConnection } from '@/common/appdb/models/saved_connection'
import { LocalWorkspace } from '@/common/interfaces/IWorkspace'
import {
  ApplyImportInput,
  ImportResult,
  ImportRow,
  applyImport,
  loadLocalPortable,
  readConnectionFileHeader,
  serializeConnections,
  toPortable,
} from '@/lib/connectionTransfer'
import { buildPreview } from '@/lib/connectionTransfer/plan'
import { parseConnectionContents } from '@/lib/connectionTransfer/parse'
import rawLog from '@bksLogger'

const log = rawLog.scope('connectionTransfer')

export interface LocalConnectionSummary {
  id: number
  name: string
  connectionType: string | null
}

export interface InspectResult {
  needsPassphrase: boolean
  encrypted: boolean
  rows: ImportRow[]
  localCount: number
}

export interface IConnectionTransferHandlers {
  'connectionTransfer/listLocal': () => Promise<LocalConnectionSummary[]>
  'connectionTransfer/export': (args: { ids: number[], filePath: string, passphrase?: string | null }) => Promise<{ count: number }>
  'connectionTransfer/inspect': (args: { filePath: string, passphrase?: string | null }) => Promise<InspectResult>
  'connectionTransfer/apply': (args: {
    filePath: string
    passphrase?: string | null
    mode: 'add' | 'replace'
    importIndexes?: number[]
  }) => Promise<ImportResult>
}

export const ConnectionTransferHandlers: IConnectionTransferHandlers = {
  'connectionTransfer/listLocal': async function(): Promise<LocalConnectionSummary[]> {
    const rows = await SavedConnection.find({
      where: { workspaceId: LocalWorkspace.id },
      order: { position: 'ASC', name: 'ASC' },
    })
    return rows.map((row) => ({
      id: row.id as number,
      name: row.name,
      connectionType: row.connectionType,
    }))
  },

  'connectionTransfer/export': async function({ ids, filePath, passphrase }): Promise<{ count: number }> {
    const target = requireFilePath(filePath)
    const selected = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id)) : []
    if (selected.length === 0) throw new Error('No connections selected.')
    const rows = await SavedConnection.find({
      where: { id: In(selected), workspaceId: LocalWorkspace.id },
    })
    rows.sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name) || ((a.id ?? 0) - (b.id ?? 0)))
    if (rows.length === 0) throw new Error('No connections selected.')
    const contents = await serializeConnections(rows.map((row) => toPortable(row)), passphrase)
    await fs.writeFile(target, contents, { encoding: 'utf8' })
    try {
      await fs.chmod(target, 0o600)
    } catch {
      // Some platforms ignore or reject unix modes. The file is already written.
    }
    log.info(`Exported ${rows.length} connections`)
    return { count: rows.length }
  },

  'connectionTransfer/inspect': async function({ filePath, passphrase }): Promise<InspectResult> {
    const contents = await readConnectionFile(filePath)
    const header = readConnectionFileHeader(contents)
    if (header.encrypted && (typeof passphrase !== 'string' || passphrase.length === 0)) {
      return { needsPassphrase: true, encrypted: true, rows: [], localCount: 0 }
    }
    const connections = await parseConnectionContents(contents, passphrase)
    const existing = await loadLocalPortable()
    return {
      needsPassphrase: false,
      encrypted: header.encrypted,
      rows: buildPreview(connections, existing),
      localCount: existing.length,
    }
  },

  'connectionTransfer/apply': async function({ filePath, passphrase, mode, importIndexes }): Promise<ImportResult> {
    if (mode !== 'add' && mode !== 'replace') throw new Error('Unknown import mode.')
    const contents = await readConnectionFile(filePath)
    const input: ApplyImportInput = {
      contents,
      passphrase,
      mode,
      importIndexes: Array.isArray(importIndexes) ? importIndexes : [],
    }
    const result = await applyImport(input)
    log.info(`Imported ${result.imported}, skipped ${result.skipped}, already exists ${result.alreadyExists}`)
    return result
  },
}

async function readConnectionFile(filePath: unknown): Promise<string> {
  const target = requireFilePath(filePath)
  const stat = await fs.stat(target)
  if (!stat.isFile()) throw new Error('Not a file.')
  return fs.readFile(target, { encoding: 'utf8' })
}

function requireFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('A file path is required.')
  }
  return filePath
}
