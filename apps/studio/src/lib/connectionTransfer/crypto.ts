import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'crypto'
import { promisify } from 'util'
import { NotConnectionFileError, WrongPassphraseError, UnsupportedVersionError } from './errors'

const scryptAsync = promisify(scrypt)

// Version 1 of the connection file. Changing these breaks existing files.
const SCRYPT_COST = 16384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const IV_LENGTH = 12

export const CONNECTION_FILE_FORMAT = 'beekeeper-connections'
export const CONNECTION_FILE_VERSION = 1

export interface EncryptedConnections {
  kdf: 'scrypt'
  cipher: 'aes-256-gcm'
  salt: string
  iv: string
  tag: string
  data: string
}

export async function encryptConnections(connections: unknown[], passphrase: string): Promise<EncryptedConnections> {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(connections), 'utf8')
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

export async function decryptConnections(blob: unknown, passphrase: string): Promise<unknown> {
  const encoded = readBlob(blob)
  const salt = Buffer.from(encoded.salt, 'base64')
  const iv = Buffer.from(encoded.iv, 'base64')
  const tag = Buffer.from(encoded.tag, 'base64')
  const data = Buffer.from(encoded.data, 'base64')
  const key = await deriveKey(passphrase, salt)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new NotConnectionFileError()
    throw new WrongPassphraseError()
  }
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(passphrase, salt, KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  }) as Promise<Buffer>
}

function readBlob(blob: unknown): EncryptedConnections {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    throw new NotConnectionFileError()
  }
  const record = blob as Record<string, unknown>
  if (record.kdf && record.kdf !== 'scrypt') throw new UnsupportedVersionError()
  if (record.cipher && record.cipher !== 'aes-256-gcm') throw new UnsupportedVersionError()
  for (const key of ['salt', 'iv', 'tag', 'data'] as const) {
    if (typeof record[key] !== 'string' || record[key] === '') {
      throw new NotConnectionFileError()
    }
  }
  return record as unknown as EncryptedConnections
}
