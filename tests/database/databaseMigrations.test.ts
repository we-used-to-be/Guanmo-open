import { describe, expect, it } from 'vitest'
import { initializeDatabaseSchema } from '@/services/database/db'
import {
  CURRENT_DB_SCHEMA_VERSION,
  DB_LEGACY_BACKFILL_STATEMENTS,
  DB_MIGRATIONS,
  DB_POST_MIGRATION_STATEMENTS,
} from '@/services/database/schema'

class FakeSchemaDatabase {
  userVersion: number
  existingSchema: boolean
  columns = new Map<string, Set<string>>()
  executed: string[] = []
  selected: string[] = []

  constructor(options: { userVersion?: number; existingSchema?: boolean; missing?: string[] } = {}) {
    this.userVersion = options.userVersion ?? 0
    this.existingSchema = options.existingSchema ?? false
    for (const migration of DB_MIGRATIONS) {
      const set = this.columns.get(migration.table) ?? new Set<string>()
      if (!options.missing?.includes(`${migration.table}.${migration.column}`)) set.add(migration.column)
      this.columns.set(migration.table, set)
    }
  }

  async select<T>(sql: string): Promise<T[]> {
    this.selected.push(sql)
    if (sql === 'PRAGMA user_version') return [{ user_version: this.userVersion }] as T[]
    if (sql.includes('sqlite_master')) return (this.existingSchema ? [{ name: 'documents' }] : []) as T[]
    const table = sql.match(/PRAGMA table_info\(([^)]+)\)/)?.[1]
    if (table) return [...(this.columns.get(table) ?? [])].map((name) => ({ name })) as T[]
    throw new Error(`Unexpected select: ${sql}`)
  }

  async execute(sql: string): Promise<{ rowsAffected: number }> {
    this.executed.push(sql)
    const version = sql.match(/^PRAGMA user_version = (\d+)$/)?.[1]
    if (version) this.userVersion = Number(version)
    const alter = DB_MIGRATIONS.find((migration) => migration.sql === sql)
    if (alter) {
      const set = this.columns.get(alter.table) ?? new Set<string>()
      set.add(alter.column)
      this.columns.set(alter.table, set)
    }
    return { rowsAffected: 0 }
  }

  async close(): Promise<void> {}
}

describe('database schema versioning', () => {
  it('creates a new database at the latest version without historical probes or backfill', async () => {
    const database = new FakeSchemaDatabase()

    await initializeDatabaseSchema(database)

    expect(database.userVersion).toBe(CURRENT_DB_SCHEMA_VERSION)
    expect(database.selected.some((sql) => sql.startsWith('PRAGMA table_info'))).toBe(false)
    expect(database.executed).not.toContain(DB_LEGACY_BACKFILL_STATEMENTS[0])
  })

  it('upgrades an unversioned legacy database once and applies only missing columns', async () => {
    const missing = ['chat_messages.parent_id', 'chunks.heading']
    const database = new FakeSchemaDatabase({ existingSchema: true, missing })

    await initializeDatabaseSchema(database)

    expect(database.userVersion).toBe(CURRENT_DB_SCHEMA_VERSION)
    expect(database.executed).toContain(DB_MIGRATIONS.find((item) => item.column === 'parent_id')?.sql)
    expect(database.executed).toContain(DB_MIGRATIONS.find((item) => item.column === 'heading')?.sql)
    expect(database.executed.filter((sql) => DB_MIGRATIONS.some((item) => item.sql === sql))).toHaveLength(2)
    expect(database.executed).toContain(DB_LEGACY_BACKFILL_STATEMENTS[0])
    const parentMigrationIndex = database.executed.indexOf(
      DB_MIGRATIONS.find((item) => item.column === 'parent_id')!.sql,
    )
    const parentIndexIndex = database.executed.findIndex((sql) => sql.includes('idx_chat_messages_parent_id'))
    expect(parentMigrationIndex).toBeLessThan(parentIndexIndex)
  })

  it('does no schema traversal or historical backfill after the version gate is current', async () => {
    const database = new FakeSchemaDatabase({
      userVersion: CURRENT_DB_SCHEMA_VERSION,
      existingSchema: true,
    })

    await initializeDatabaseSchema(database)

    expect(database.selected).toEqual(['PRAGMA user_version'])
    expect(database.executed).toEqual([])
  })

  it('upgrades version 2 by creating and rebuilding the derived FTS index before advancing the version', async () => {
    const database = new FakeSchemaDatabase({ userVersion: 2, existingSchema: true })

    await initializeDatabaseSchema(database)

    const createIndex = database.executed.indexOf(DB_POST_MIGRATION_STATEMENTS[1])
    const rebuild = database.executed.indexOf(DB_POST_MIGRATION_STATEMENTS.at(-1)!)
    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(rebuild).toBeGreaterThan(createIndex)
    expect(database.executed.at(-1)).toBe(`PRAGMA user_version = ${CURRENT_DB_SCHEMA_VERSION}`)
  })

  it('keeps version 2 when the FTS rebuild fails so the upgrade can retry', async () => {
    const database = new FakeSchemaDatabase({ userVersion: 2, existingSchema: true })
    const originalExecute = database.execute.bind(database)
    database.execute = async (sql: string) => {
      if (sql === DB_POST_MIGRATION_STATEMENTS.at(-1)) throw new Error('FTS rebuild failed')
      return originalExecute(sql)
    }

    await expect(initializeDatabaseSchema(database)).rejects.toThrow('FTS rebuild failed')
    expect(database.userVersion).toBe(2)
  })

  it('does not advance user_version when a legacy migration fails', async () => {
    const database = new FakeSchemaDatabase({ existingSchema: true })
    const originalExecute = database.execute.bind(database)
    database.execute = async (sql: string) => {
      if (sql === DB_LEGACY_BACKFILL_STATEMENTS[0]) throw new Error('backfill failed')
      return originalExecute(sql)
    }

    await expect(initializeDatabaseSchema(database)).rejects.toThrow('backfill failed')
    expect(database.userVersion).toBe(0)
  })
})
