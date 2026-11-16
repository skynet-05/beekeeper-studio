import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { EntityManager } from 'typeorm'
import { TestOrmConnection } from '@tests/lib/TestOrmConnection'
import { SavedConnection } from '@/common/appdb/models/saved_connection'
import { ConnectionFolder } from '@/common/appdb/models/ConnectionFolder'
import { ConnectionTransferHandlers } from '@/handlers/connectionTransferHandlers'
import {
  applyImport,
  buildPreview,
  canExportConnections,
  formatDeletedCount,
  formatExportNotice,
  formatImportCounts,
  parseConnectionContents,
  readConnectionFileHeader,
  serializeConnections,
  toPortable,
} from '@/lib/connectionTransfer'
import { PortableConnection } from '@/lib/connectionTransfer/portable'

const KEY_SENTINEL = 'BEGIN-PRIVATE-KEY-SENTINEL-do-not-export'

function server(overrides: PortableConnection = {}): PortableConnection {
  return {
    name: 'Prod',
    connectionType: 'postgresql',
    host: 'db.internal',
    port: 5432,
    defaultDatabase: 'app',
    username: 'alice',
    ...overrides,
  }
}

async function seed(overrides: PortableConnection = {}) {
  const conn = new SavedConnection()
  const fields = server(overrides)
  if (fields.connectionType) conn.connectionType = fields.connectionType
  Object.assign(conn, fields)
  if (fields.connectionType) conn.connectionType = fields.connectionType
  if (fields.port !== undefined) conn.port = fields.port
  await conn.save()
  return conn
}

describe('connection transfer file format', () => {
  it('writes a plaintext envelope and keeps secrets out of the key file contents', async () => {
    const keyPath = path.join(os.tmpdir(), `bks-key-${Date.now()}`)
    await fs.writeFile(keyPath, KEY_SENTINEL, 'utf8')
    const connection = server({
      password: 'db-secret',
      url: 'postgresql://alice:db-secret@db.internal:5432/app',
      options: { connectionMethod: 'connectionString', connectionString: 'postgresql://alice:db-secret@db.internal/app' },
      azureAuthOptions: { clientSecret: 'azure-secret', tenantId: 'tenant-secret' },
      iamAuthOptions: { secretAccessKey: 'iam-secret', accessKeyId: 'AKIA', profiles: ['default', 'dev'] },
      libsqlOptions: { mode: 'url', authToken: 'libsql-secret' },
      surrealDbOptions: { token: 'surreal-secret', namespace: 'ns' },
      sshEnabled: true,
      sshMode: 'keyfile',
      sshKeyfile: keyPath,
      sshKeyfilePassword: 'key-pass',
      sshBastionHost: 'jump',
      sshBastionMode: 'userpass',
      sshBastionPassword: 'jump-secret',
      ssl: true,
      sslKeyFile: '/certs/client.key',
      labelColor: 'red',
      position: 4,
      id: 99,
      workspaceId: 8,
      authId: 3,
      connectionFolderId: 11,
      version: 6,
      createdAt: new Date('2020-01-01'),
      updatedAt: new Date('2020-01-02'),
      teamRead: true,
      userSpecificCredentials: true,
    } as PortableConnection)

    const contents = await serializeConnections([connection], '')
    const parsed = JSON.parse(contents)

    expect(parsed).toMatchObject({
      format: 'beekeeper-connections',
      version: 1,
      encrypted: false,
    })
    expect(parsed.connections).toHaveLength(1)
    const saved = parsed.connections[0]
    expect(saved.password).toBe('db-secret')
    expect(saved.url).toContain('db-secret')
    expect(saved.options.connectionString).toContain('db-secret')
    expect(saved.azureAuthOptions.clientSecret).toBe('azure-secret')
    expect(saved.iamAuthOptions.secretAccessKey).toBe('iam-secret')
    expect(saved.iamAuthOptions.profiles).toEqual(['default', 'dev'])
    expect(saved.libsqlOptions.authToken).toBe('libsql-secret')
    expect(saved.surrealDbOptions.token).toBe('surreal-secret')
    expect(saved.sshKeyfile).toBe(keyPath)
    expect(saved.sshKeyfilePassword).toBe('key-pass')
    expect(saved.sshBastionPassword).toBe('jump-secret')
    expect(saved.sslKeyFile).toBe('/certs/client.key')
    expect(saved.labelColor).toBe('red')
    expect(saved.position).toBe(4)
    expect(saved.id).toBeUndefined()
    expect(saved.workspaceId).toBeUndefined()
    expect(saved.authId).toBeUndefined()
    expect(saved.connectionFolderId).toBeUndefined()
    expect(saved.version).toBeUndefined()
    expect(saved.createdAt).toBeUndefined()
    expect(saved.updatedAt).toBeUndefined()
    expect(saved.teamRead).toBeUndefined()
    expect(saved.userSpecificCredentials).toBeUndefined()
    expect(contents).not.toContain(KEY_SENTINEL)
    await fs.rm(keyPath, { force: true })
  })

  it('encrypts with a passphrase and does not store the passphrase or plaintext secrets', async () => {
    const contents = await serializeConnections([server({ password: 'db-secret' })], 'correct horse')
    const parsed = JSON.parse(contents)

    expect(parsed.encrypted).toBe(true)
    expect(parsed.connections.kdf).toBe('scrypt')
    expect(parsed.connections.cipher).toBe('aes-256-gcm')
    expect(typeof parsed.connections.salt).toBe('string')
    expect(typeof parsed.connections.iv).toBe('string')
    expect(contents).not.toContain('correct horse')
    expect(contents).not.toContain('db-secret')

    const decrypted = await parseConnectionContents(contents, 'correct horse')
    expect(decrypted[0].password).toBe('db-secret')
    expect(readConnectionFileHeader(contents)).toEqual({ encrypted: true })
  })

  it('rejects a wrong passphrase and a tampered ciphertext', async () => {
    const contents = await serializeConnections([server()], 'correct horse')
    await expect(parseConnectionContents(contents, 'nope')).rejects.toThrow('Wrong passphrase.')

    const tampered = JSON.parse(contents)
    tampered.connections.data = Buffer.from('nope').toString('base64')
    await expect(parseConnectionContents(JSON.stringify(tampered), 'correct horse')).rejects.toThrow('Wrong passphrase.')
  })

  it('imports older plaintext connection JSON, including snake_case and aliases', async () => {
    const single = JSON.stringify({
      name: 'Legacy',
      connection_type: 'postgres',
      default_database: 'app',
      host: 'db.internal',
      port: '5433',
      ssh_keyfile: '/keys/id_rsa',
      iam_auth_options: { secret_access_key: 'iam-secret', profiles: ['default', 'dev'] },
      id: 4,
      connection_folder_id: 9,
      workspace_id: 2,
      auth_id: 6,
    })
    const [connection] = await parseConnectionContents(single)
    expect(connection.connectionType).toBe('postgresql')
    expect(connection.port).toBe(5433)
    expect(connection.sshKeyfile).toBe('/keys/id_rsa')
    expect(connection.iamAuthOptions.profiles).toEqual(['default', 'dev'])
    expect(connection.iamAuthOptions.secretAccessKey).toBe('iam-secret')

    const listed = await parseConnectionContents(JSON.stringify([
      { name: 'One', connectionType: 'mysql', host: 'localhost', port: 3306, defaultDatabase: 'one' },
      { name: 'Two', connectionType: 'mysql', host: 'localhost', port: 3306, defaultDatabase: 'two' },
    ]))
    expect(listed.map((row) => row.name)).toEqual(['One', 'Two'])
  })

  it('rejects a file that is not connection JSON', async () => {
    await expect(parseConnectionContents('{"title":"query","text":"select 1"}')).rejects.toThrow('File is not connection JSON.')
    await expect(parseConnectionContents('not json')).rejects.toThrow('File is not connection JSON.')
    await expect(parseConnectionContents('[]')).rejects.toThrow('File is not connection JSON.')
    await expect(parseConnectionContents(JSON.stringify({
      format: 'beekeeper-connections',
      version: 2,
      encrypted: false,
      connections: [],
    }))).rejects.toThrow('Unsupported connection file version.')
  })

  it('matches server connections on type, host, port, and database, and file databases on path', () => {
    const existing = [
      server({ name: 'Alpha' }),
      server({ name: 'Beta' }),
      { name: 'Local', connectionType: 'sqlite', defaultDatabase: path.join(os.homedir(), 'data.db') },
    ]
    const incoming = [
      server({ name: 'Renamed' }),
      server({ name: 'Other port', port: 5433 }),
      { name: 'Home', connectionType: 'sqlite', defaultDatabase: '~/data.db' },
      { name: 'Other file', connectionType: 'sqlite', defaultDatabase: '/tmp/other.db' },
      { name: 'Not sqlite', connectionType: 'postgresql', host: 'localhost', port: 5432, defaultDatabase: '~/data.db' },
    ]
    const rows = buildPreview(incoming, existing)

    expect(rows[0].conflict).toBe(true)
    expect(rows[0].matches).toEqual(['Alpha', 'Beta'])
    expect(rows[1].conflict).toBe(false)
    expect(rows[2].conflict).toBe(true)
    expect(rows[2].matches).toEqual(['Local'])
    expect(rows[3].conflict).toBe(false)
    expect(rows[4].conflict).toBe(false)
  })

  it('warns a later duplicate in the same file against the earlier one', () => {
    const rows = buildPreview([
      server({ name: 'First' }),
      server({ name: 'Second' }),
    ], [])
    expect(rows[0].conflict).toBe(false)
    expect(rows[1].conflict).toBe(true)
    expect(rows[1].matches).toEqual(['First'])
  })

  it('names a broken connection and still previews the rest', () => {
    const rows = buildPreview([
      server(),
      { name: 'Broken', connectionType: 'not-a-database' },
      { connectionType: 'sqlite' },
    ], [])
    expect(rows[1].broken).toBe(true)
    expect(rows[1].name).toBe('Broken')
    expect(rows[2].broken).toBe(true)
    expect(rows[2].name).toBe('Unnamed connection')
    expect(rows[0].broken).toBe(false)
  })

  it('requires a checked connection and matching passphrases before export', () => {
    expect(canExportConnections(0, '', '')).toBe(false)
    expect(canExportConnections(1, '', '')).toBe(true)
    expect(canExportConnections(1, 'secret', 'secret')).toBe(true)
    expect(canExportConnections(1, 'secret', 'other')).toBe(false)
    expect(formatExportNotice(1)).toBe('Exported 1 connection')
    expect(formatExportNotice(2)).toBe('Exported 2 connections')
    expect(formatDeletedCount(1)).toBe('1 saved connection will be deleted.')
    expect(formatDeletedCount(3)).toBe('3 saved connections will be deleted.')
    expect(formatImportCounts({ imported: 2, skipped: 1, alreadyExists: 0 })).toBe('Imported 2, skipped 1, already exists 0.')
  })
})

describe('connection transfer import', () => {
  beforeEach(async () => {
    await TestOrmConnection.connect()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await TestOrmConnection.disconnect()
  })

  it('adds connections, skips a broken one, and leaves an unrelated saved connection in place', async () => {
    await seed({ name: 'Stay', host: 'keep.example', defaultDatabase: 'keep' })
    const contents = JSON.stringify({
      format: 'beekeeper-connections',
      version: 1,
      encrypted: false,
      connections: [
        server({ name: 'New', host: 'new.example', defaultDatabase: 'new' }),
        { name: 'Broken', connectionType: 'sqlite' },
      ],
    })

    const result = await applyImport({ contents, mode: 'add', importIndexes: [] })

    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.skippedNames).toEqual(['Broken'])
    expect(result.alreadyExists).toBe(0)
    const names = (await SavedConnection.find()).map((row) => row.name).sort()
    expect(names).toEqual(['New', 'Stay'])
  })

  it('skips a conflict unless that row is chosen for import, and keeps the imported name', async () => {
    await seed({ name: 'Existing' })
    const contents = await serializeConnections([
      server({ name: 'Imported name' }),
      server({ name: 'Free', host: 'other.example', defaultDatabase: 'other' }),
    ], '')

    const skipped = await applyImport({ contents, mode: 'add', importIndexes: [] })
    expect(skipped.imported).toBe(1)
    expect(skipped.alreadyExists).toBe(1)
    expect((await SavedConnection.find()).map((row) => row.name).sort()).toEqual(['Existing', 'Free'])

    const imported = await applyImport({ contents, mode: 'add', importIndexes: [0] })
    expect(imported.imported).toBe(1)
    expect(imported.alreadyExists).toBe(1)
    const names = (await SavedConnection.find()).map((row) => row.name).sort()
    expect(names).toEqual(['Existing', 'Free', 'Imported name'])
  })

  it('keeps a missing key path and names the connection', async () => {
    const contents = await serializeConnections([
      server({
        name: 'Keyed',
        sshEnabled: true,
        sshMode: 'keyfile',
        sshKeyfile: '/missing/id_rsa',
        sshKeyfilePassword: 'key-pass',
      }),
    ], '')

    const result = await applyImport({
      contents,
      mode: 'add',
      importIndexes: [],
    }, async () => false)

    expect(result.imported).toBe(1)
    expect(result.missingKeyNames).toEqual(['Keyed'])
    const saved = await SavedConnection.findOneBy({ name: 'Keyed' })
    expect(saved.sshKeyfile).toBe('/missing/id_rsa')
    expect(saved.sshKeyfilePassword).toBe('key-pass')
    expect(saved.workspaceId).toBe(-1)
    expect(saved.connectionFolderId).toBeNull()
    expect(saved.authId).toBeNull()
  })

  it('round-trips ssh userpass secrets and strips folder, id, and token cache', async () => {
    const contents = await serializeConnections([
      server({
        name: 'Tunnel',
        password: 'db-secret',
        sshEnabled: true,
        sshMode: 'userpass',
        sshHost: 'bastion',
        sshUsername: 'ec2-user',
        sshPassword: 'ssh-secret',
        sshKeyfile: '/keys/id_rsa',
        sshKeyfilePassword: 'gone',
        id: 44,
        connectionFolderId: 3,
        authId: 8,
        workspaceId: 2,
      } as PortableConnection),
    ], '')

    await applyImport({ contents, mode: 'add', importIndexes: [] })
    const saved = await SavedConnection.findOneBy({ name: 'Tunnel' })
    expect(saved.password).toBe('db-secret')
    expect(toPortable(saved).password).toBe('db-secret')
    expect(toPortable(saved).sshPassword).toBe('ssh-secret')
    expect(saved.sshMode).toBe('userpass')
    expect(saved.sshPassword).toBe('ssh-secret')
    expect(saved.sshKeyfile).toBeNull()
    expect(saved.sshKeyfilePassword).toBeNull()
    expect(saved.id).not.toBe(44)
    expect(saved.connectionFolderId).toBeNull()
    expect(saved.authId).toBeNull()
    expect(saved.workspaceId).toBe(-1)
    expect(toPortable(saved).connectionFolderId).toBeUndefined()
  })

  it('replaces local saved connections and leaves folders alone', async () => {
    const folder = new ConnectionFolder()
    folder.name = 'Keep'
    await folder.save()
    await seed({ name: 'Gone' })
    const contents = await serializeConnections([
      server({ name: 'Replacement', host: 'new.example' }),
    ], '')

    const result = await applyImport({ contents, mode: 'replace', importIndexes: [] })

    expect(result.imported).toBe(1)
    expect((await SavedConnection.find()).map((row) => row.name)).toEqual(['Replacement'])
    expect(await ConnectionFolder.count()).toBe(1)
  })

  it('restores saved connections when replace fails after the delete starts', async () => {
    await seed({ name: 'Keep' })
    const contents = await serializeConnections([
      server({ name: 'New', host: 'other.example', defaultDatabase: 'other' }),
    ], '')
    const manager = SavedConnection.getRepository().manager
    const original = manager.transaction.bind(manager)
    vi.spyOn(manager, 'transaction').mockImplementation(((fn: (em: EntityManager) => Promise<unknown>) => {
      return original(async (em: EntityManager) => {
        const realSave = em.save.bind(em)
        em.save = (async (...args: unknown[]) => {
          if (args[0] instanceof SavedConnection) throw new Error('disk full')
          return realSave(...args as [SavedConnection])
        }) as EntityManager['save']
        return fn(em)
      })
    }) as typeof manager.transaction)

    await expect(applyImport({ contents, mode: 'replace', importIndexes: [] })).rejects.toThrow('disk full')
    expect((await SavedConnection.find()).map((row) => row.name)).toEqual(['Keep'])
  })

  it('changes nothing when the file is not connection JSON or the passphrase is wrong', async () => {
    await seed({ name: 'Stay' })
    const encrypted = await serializeConnections([server({ name: 'Hidden' })], 'secret')

    await expect(applyImport({
      contents: '{"queries":[]}',
      mode: 'replace',
      importIndexes: [],
    })).rejects.toThrow('File is not connection JSON.')
    await expect(applyImport({
      contents: encrypted,
      passphrase: 'nope',
      mode: 'replace',
      importIndexes: [],
    })).rejects.toThrow('Wrong passphrase.')

    expect((await SavedConnection.find()).map((row) => row.name)).toEqual(['Stay'])
  })

  it('does not change saved connections when the export path cannot be written', async () => {
    const saved = await seed({ name: 'Stay', password: 'db-secret' })
    const missingDir = path.join(os.tmpdir(), `bks-export-${Date.now()}`, 'nested')

    await expect(ConnectionTransferHandlers['connectionTransfer/export']({
      ids: [saved.id],
      filePath: path.join(missingDir, 'beekeeper-connections.json'),
      passphrase: '',
    })).rejects.toThrow()

    expect((await SavedConnection.find()).map((row) => row.name)).toEqual(['Stay'])
    expect((await SavedConnection.findOneBy({ name: 'Stay' })).password).toBe('db-secret')
  })
})
