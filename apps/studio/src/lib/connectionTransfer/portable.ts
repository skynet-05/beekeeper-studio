import _ from 'lodash'
import { DatabaseTypes, ConnectionType } from '@/lib/db/types'
import { resolveHomePathToAbsolute } from '@/handlers/utils'

// Same aliases SavedConnection accepts on the connectionType setter.
const CONNECTION_TYPE_ALIASES: Record<string, ConnectionType> = {
  psql: 'postgresql',
  postgres: 'postgresql',
  mssql: 'sqlserver',
}

export const EXPORTED_FIELDS = [
  'name',
  'labelColor',
  'position',
  'connectionType',
  'host',
  'port',
  'socketPath',
  'socketPathEnabled',
  'username',
  'domain',
  'defaultDatabase',
  'url',
  'password',
  'rememberPassword',
  'sshEnabled',
  'sshHost',
  'sshPort',
  'sshKeyfile',
  'sshUsername',
  'sshPassword',
  'sshKeyfilePassword',
  'sshMode',
  'sshBastionHost',
  'sshBastionHostPort',
  'sshBastionMode',
  'sshBastionUsername',
  'sshBastionKeyfile',
  'sshBastionPassword',
  'sshBastionKeyfilePassword',
  'sshKeepaliveInterval',
  'ssl',
  'sslCaFile',
  'sslCertFile',
  'sslKeyFile',
  'sslRejectUnauthorized',
  'readOnlyMode',
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
  'trustServerCertificate',
  'windowsAuthEnabled',
  'sqlServerOptions',
  'serviceName',
] as const

export type ExportedField = typeof EXPORTED_FIELDS[number]

export type PortableConnection = {
  [K in ExportedField]?: any
}

const FILE_DATABASE_TYPES = new Set(['sqlite', 'duckdb'])

export function canonicalConnectionType(value: unknown): ConnectionType | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const mapped = CONNECTION_TYPE_ALIASES[trimmed] || trimmed
  if ((DatabaseTypes as readonly string[]).includes(mapped)) return mapped as ConnectionType
  return null
}

export function camelCaseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelCaseKeysDeep)
  if (!_.isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[_.camelCase(key)] = camelCaseKeysDeep(child)
  }
  return out
}

export function toPortable(source: any): PortableConnection {
  const portable: PortableConnection = {}
  if (!source || typeof source !== 'object') return portable
  for (const field of EXPORTED_FIELDS) {
    const value = readField(source, field)
    if (value !== undefined) portable[field] = _.cloneDeep(value)
  }
  return portable
}

function readField(source: any, field: ExportedField): unknown {
  // The socket getter fills in a default path when the column is empty.
  // Export the stored path so a disabled socket is not persisted as that default.
  if (field === 'socketPath' && Object.prototype.hasOwnProperty.call(source, '_socketPath')) {
    return source._socketPath
  }
  return source[field]
}

export function isFileDatabase(conn: PortableConnection): boolean {
  const type = conn?.connectionType
  if (FILE_DATABASE_TYPES.has(type)) return true
  if (type === 'libsql' && conn.libsqlOptions?.mode === 'file') return true
  if (type === 'sqlanywhere' && conn.sqlAnywhereOptions?.mode === 'file') return true
  return false
}

export function filePathOf(conn: PortableConnection): string {
  if (conn?.connectionType === 'sqlanywhere' && conn.sqlAnywhereOptions?.mode === 'file') {
    return normalizePath(conn.sqlAnywhereOptions?.databaseFile)
  }
  return normalizePath(conn?.defaultDatabase)
}

export function identityKey(conn: PortableConnection): string | null {
  const type = canonicalConnectionType(conn?.connectionType)
  if (!type) return null
  if (isFileDatabase(conn)) {
    const filePath = filePathOf(conn)
    if (!filePath) return null
    return `file\0${type}\0${filePath}`
  }
  return [
    'server',
    type,
    normalizeHost(conn.host),
    normalizePort(conn.port),
    normalizeText(conn.defaultDatabase),
  ].join('\0')
}

export function displayName(conn: { name?: unknown } | null | undefined): string {
  if (typeof conn?.name === 'string' && conn.name.trim()) return conn.name.trim()
  return 'Unnamed connection'
}

export function rejectionReason(conn: PortableConnection): string | null {
  if (!conn || typeof conn !== 'object' || Array.isArray(conn)) return 'Not a connection'
  if (!canonicalConnectionType(conn.connectionType)) return 'Unknown database type'
  if (typeof conn.name !== 'string' || conn.name.trim() === '') return 'Name is required'
  if (isFileDatabase(conn) && !filePathOf(conn)) return 'Database file is required'
  return null
}

export function keyAndCertPaths(conn: PortableConnection): string[] {
  const paths: string[] = []
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) paths.push(value.trim())
  }
  add(conn.sshKeyfile)
  add(conn.sshBastionKeyfile)
  add(conn.sslCaFile)
  add(conn.sslCertFile)
  add(conn.sslKeyFile)
  add(conn.bigQueryOptions?.keyFilename)
  add(conn.sqlServerOptions?.serverCertificate)
  return paths
}

export function normalizePath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('~/')) return resolveHomePathToAbsolute(trimmed)
  return trimmed
}

function normalizeHost(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

function normalizePort(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return String(numeric)
  return String(value).trim()
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}
