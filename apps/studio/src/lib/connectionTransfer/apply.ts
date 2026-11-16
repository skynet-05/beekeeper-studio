import { promises as fs } from 'fs'
import { constants as fsConstants } from 'fs'
import { validate } from 'class-validator'
import _ from 'lodash'
import { SavedConnection } from '@/common/appdb/models/saved_connection'
import { LocalWorkspace } from '@/common/interfaces/IWorkspace'
import { SshMode } from '@/common/interfaces/IConnection'
import { resolveHomePathToAbsolute } from '@/handlers/utils'
import { parseConnectionContents } from './parse'
import { ImportResult, buildPreview } from './plan'
import {
  EXPORTED_FIELDS,
  ExportedField,
  PortableConnection,
  displayName,
  keyAndCertPaths,
  rejectionReason,
  toPortable,
} from './portable'

const OBJECT_FIELDS = new Set<ExportedField>([
  'options',
  'redshiftOptions',
  'cassandraOptions',
  'bigQueryOptions',
  'azureAuthOptions',
  'iamAuthOptions',
  'libsqlOptions',
  'sqlAnywhereOptions',
  'surrealDbOptions',
  'dynamoDbOptions',
  'snowflakeOptions',
  'sqlServerOptions',
])

const SECRET_FIELDS: ExportedField[] = [
  'password',
  'sshPassword',
  'sshKeyfilePassword',
  'sshBastionPassword',
  'sshBastionKeyfilePassword',
]

export interface ApplyImportInput {
  contents: string
  passphrase?: string | null
  mode: 'add' | 'replace'
  importIndexes: number[]
}

export async function pathExists(filePath: string): Promise<boolean> {
  const resolved = filePath.startsWith('~/') ? resolveHomePathToAbsolute(filePath) : filePath
  try {
    await fs.access(resolved, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export function toSavedConnection(source: PortableConnection): SavedConnection {
  const entity = new SavedConnection()
  if (source.connectionType) entity.connectionType = source.connectionType
  for (const field of EXPORTED_FIELDS) {
    if (field === 'connectionType' || field === 'sshMode') continue
    const value = source[field]
    if (value === undefined) continue
    if (value === null && OBJECT_FIELDS.has(field)) continue
    assignField(entity, field, _.cloneDeep(value))
  }
  // sshMode's setter clears secrets that do not belong to the mode. Set it
  // after the key and password fields so a keyfile or userpass secret survives,
  // and so agent mode still drops a stale key.
  if (typeof source.sshMode === 'string') entity.sshMode = source.sshMode as SshMode
  if (hasColumnSecret(source)) entity.rememberPassword = true
  entity.id = null
  entity.workspaceId = LocalWorkspace.id
  entity.connectionFolderId = null
  entity.authId = null
  return entity
}

export async function loadLocalPortable(): Promise<PortableConnection[]> {
  const rows = await SavedConnection.find({
    where: { workspaceId: LocalWorkspace.id },
    order: { position: 'ASC', name: 'ASC' },
  })
  return rows.map((row) => toPortable(row))
}

export async function applyImport(
  input: ApplyImportInput,
  exists: (filePath: string) => Promise<boolean> = pathExists,
): Promise<ImportResult> {
  const connections = await parseConnectionContents(input.contents, input.passphrase)
  const importIndexes = new Set(
    (input.importIndexes ?? []).filter((index) => Number.isInteger(index)),
  )

  const prepared: Array<{ index: number, entity: SavedConnection | null, connection: PortableConnection }> = []
  for (let index = 0; index < connections.length; index++) {
    const connection = connections[index]
    prepared.push({
      index,
      connection,
      entity: await prepareEntity(connection),
    })
  }

  const skippedNames: string[] = []
  const missingKeyNames: string[] = []
  let imported = 0
  let alreadyExists = 0

  const manager = SavedConnection.getRepository().manager
  await manager.transaction(async (em) => {
    const current = await em.find(SavedConnection, { where: { workspaceId: LocalWorkspace.id } })
    const preview = input.mode === 'replace'
      ? null
      : buildPreview(connections, current.map((row) => toPortable(row)))

    if (input.mode === 'replace') {
      if (current.length) await em.remove(current)
    }

    for (const row of prepared) {
      if (!row.entity) {
        skippedNames.push(displayName(row.connection))
        continue
      }
      if (preview) {
        const planned = preview[row.index]
        if (planned.conflict && !importIndexes.has(row.index)) {
          alreadyExists += 1
          continue
        }
      }
      await em.save(row.entity)
      imported += 1
      if (await missingKey(toPortable(row.entity), exists)) {
        missingKeyNames.push(displayName(row.connection))
      }
    }
  })

  return {
    imported,
    skipped: skippedNames.length,
    alreadyExists,
    skippedNames,
    missingKeyNames,
  }
}

async function prepareEntity(connection: PortableConnection): Promise<SavedConnection | null> {
  if (rejectionReason(connection)) return null
  const entity = toSavedConnection(connection)
  const errors = await validate(entity)
  if (errors.length > 0) return null
  return entity
}

async function missingKey(
  connection: PortableConnection,
  exists: (filePath: string) => Promise<boolean>,
): Promise<boolean> {
  for (const filePath of keyAndCertPaths(connection)) {
    if (!(await exists(filePath))) return true
  }
  return false
}

function hasColumnSecret(source: PortableConnection): boolean {
  return SECRET_FIELDS.some((field) => {
    const value = source[field]
    return typeof value === 'string' && value.length > 0
  })
}

function assignField(entity: SavedConnection, field: ExportedField, value: unknown): void {
  (entity as unknown as Record<string, unknown>)[field] = value
}
