import {
  CONNECTION_FILE_FORMAT,
  CONNECTION_FILE_VERSION,
  EncryptedConnections,
  decryptConnections,
  encryptConnections,
} from './crypto'
import { NotConnectionFileError, UnsupportedVersionError, WrongPassphraseError } from './errors'
import {
  PortableConnection,
  camelCaseKeysDeep,
  canonicalConnectionType,
  toPortable,
} from './portable'

export interface ConnectionFileHeader {
  encrypted: boolean
}

export async function serializeConnections(connections: PortableConnection[], passphrase?: string | null): Promise<string> {
  const body = connections.map((connection) => toPortable(connection))
  const encrypted = typeof passphrase === 'string' && passphrase.length > 0
  const envelope = {
    format: CONNECTION_FILE_FORMAT,
    version: CONNECTION_FILE_VERSION,
    encrypted,
    connections: encrypted ? await encryptConnections(body, passphrase) : body,
  }
  return `${JSON.stringify(envelope, null, 2)}\n`
}

export function readConnectionFileHeader(contents: string): ConnectionFileHeader {
  const parsed = parseJson(contents)
  if (isEnvelope(parsed)) {
    assertSupportedEnvelope(parsed)
    return { encrypted: parsed.encrypted === true }
  }
  if (!looksLikeConnectionFile(parsed)) throw new NotConnectionFileError()
  return { encrypted: false }
}

export async function parseConnectionContents(contents: string, passphrase?: string | null): Promise<PortableConnection[]> {
  const parsed = parseJson(contents)
  if (isEnvelope(parsed)) {
    assertSupportedEnvelope(parsed)
    if (parsed.encrypted === true) {
      if (typeof passphrase !== 'string' || passphrase.length === 0) {
        throw new WrongPassphraseError()
      }
      const decrypted = await decryptConnections(parsed.connections, passphrase)
      if (!Array.isArray(decrypted)) throw new NotConnectionFileError()
      return decrypted.map(normalizeIncoming)
    }
    if (!Array.isArray(parsed.connections)) throw new NotConnectionFileError()
    return parsed.connections.map(normalizeIncoming)
  }
  if (Array.isArray(parsed)) {
    if (!parsed.some(looksLikeConnection)) throw new NotConnectionFileError()
    return parsed.map(normalizeIncoming)
  }
  if (looksLikeConnection(parsed)) return [normalizeIncoming(parsed)]
  throw new NotConnectionFileError()
}

function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents.replace(/^\uFEFF/, ''))
  } catch {
    throw new NotConnectionFileError()
  }
}

interface Envelope {
  format: string
  version: unknown
  encrypted: unknown
  connections: unknown
}

function isEnvelope(value: unknown): value is Envelope {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Envelope).format === CONNECTION_FILE_FORMAT
}

function assertSupportedEnvelope(envelope: Envelope): void {
  if (envelope.version !== CONNECTION_FILE_VERSION) throw new UnsupportedVersionError()
  if (typeof envelope.encrypted !== 'boolean') throw new NotConnectionFileError()
  if (envelope.encrypted === true && !isEncryptedBlob(envelope.connections)) {
    throw new NotConnectionFileError()
  }
}

function isEncryptedBlob(value: unknown): value is EncryptedConnections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return ['salt', 'iv', 'tag', 'data'].every((key) => typeof record[key] === 'string' && record[key] !== '')
}

function looksLikeConnectionFile(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(looksLikeConnection)
  return looksLikeConnection(value)
}

function looksLikeConnection(value: unknown): boolean {
  const normalized = camelCaseKeysDeep(value)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return false
  return typeof (normalized as PortableConnection).connectionType === 'string'
    && (normalized as PortableConnection).connectionType.trim() !== ''
}

function normalizeIncoming(value: unknown): PortableConnection {
  const camel = camelCaseKeysDeep(value)
  if (!camel || typeof camel !== 'object' || Array.isArray(camel)) return {}
  const connection = camel as PortableConnection
  const type = canonicalConnectionType(connection.connectionType)
  if (type) connection.connectionType = type
  if (connection.port != null && connection.port !== '') {
    const numeric = Number(connection.port)
    if (Number.isFinite(numeric)) connection.port = numeric
  }
  return connection
}
