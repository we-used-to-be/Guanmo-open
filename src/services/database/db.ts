/**
 * Database service for 观墨.
 * Tauri: uses tauri-plugin-sql (SQLite).
 * Web: no database (read-only document viewing).
 */

import { isTauri } from '@/hooks/useTauri'
import { markStartupPoint } from '@/services/startupPerformance'
import {
  CURRENT_DB_SCHEMA_VERSION,
  DB_LEGACY_BACKFILL_STATEMENTS,
  DB_MIGRATIONS,
  DB_NAME,
  DB_POST_MIGRATION_STATEMENTS,
  DB_SCHEMA,
  splitDatabaseSchemaStatements,
} from './schema'

// --- Database abstraction ---

interface DBAdapter {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

type SchemaDatabase = Pick<DBAdapter, 'execute' | 'select'>

async function readSchemaVersion(database: SchemaDatabase): Promise<number> {
  const rows = await database.select<{ user_version: number }>('PRAGMA user_version')
  return Number(rows[0]?.user_version ?? 0)
}

async function hasApplicationSchema(database: SchemaDatabase): Promise<boolean> {
  const rows = await database.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents' LIMIT 1",
  )
  return rows.length > 0
}

async function hasColumn(database: SchemaDatabase, table: string, column: string): Promise<boolean> {
  const rows = await database.select<{ name: string }>(`PRAGMA table_info(${table})`)
  return rows.some((row) => row.name === column)
}

async function executeLatestSchema(database: SchemaDatabase, indexesOnly = false): Promise<void> {
  for (const statement of splitDatabaseSchemaStatements(DB_SCHEMA)) {
    const isIndex = /^CREATE INDEX\b/i.test(statement)
    if (isIndex !== indexesOnly) continue
    await database.execute(statement)
  }
}

/**
 * Version 0 is either a new empty database or an older GuanMo database.
 * New databases receive the latest schema directly. Older databases perform
 * the compatibility probes and historical backfill once, then advance the
 * durable SQLite user_version gate.
 */
export async function initializeDatabaseSchema(database: SchemaDatabase): Promise<void> {
  const version = await readSchemaVersion(database)
  if (version > CURRENT_DB_SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${version} 高于当前支持版本 ${CURRENT_DB_SCHEMA_VERSION}`)
  }
  if (version === CURRENT_DB_SCHEMA_VERSION) return

  const existingSchema = await hasApplicationSchema(database)
  await executeLatestSchema(database)

  if (existingSchema) {
    for (const migration of DB_MIGRATIONS) {
      if (await hasColumn(database, migration.table, migration.column)) continue
      await database.execute(migration.sql)
    }
    for (const statement of DB_LEGACY_BACKFILL_STATEMENTS) {
      await database.execute(statement)
    }
  }

  await executeLatestSchema(database, true)
  for (const statement of DB_POST_MIGRATION_STATEMENTS) {
    await database.execute(statement)
  }

  await database.execute(`PRAGMA user_version = ${CURRENT_DB_SCHEMA_VERSION}`)
}

// --- Tauri SQLite adapter ---

class TauriSQLiteAdapter implements DBAdapter {
  private db: any = null

  async init(): Promise<void> {
    markStartupPoint('database-init-start')
    const Database = (await import('@tauri-apps/plugin-sql')).default
    markStartupPoint('database-plugin-loaded')
    this.db = await Database.load(`sqlite:${DB_NAME}`)
    markStartupPoint('database-connection-opened')
    await this.db.execute('PRAGMA foreign_keys = ON')
    await initializeDatabaseSchema(this.db)
    markStartupPoint('database-schema-gate-complete')
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
    if (!this.db) throw new Error('Database not initialized')
    const startedAt = performance.now()
    try {
      const result = await this.db.execute(sql, params)
      const durationMs = performance.now() - startedAt
      if (durationMs >= 200) void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
        recordDiagnostic('database.query_slow', 'slow', durationMs)).catch(() => undefined)
      return result
    } catch (error) {
      void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
        recordDiagnostic('database.query_failed', 'error', performance.now() - startedAt)).catch(() => undefined)
      throw error
    }
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.db) throw new Error('Database not initialized')
    const startedAt = performance.now()
    try {
      const result = await this.db.select(sql, params) as T[]
      const durationMs = performance.now() - startedAt
      if (durationMs >= 200) void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
        recordDiagnostic('database.query_slow', 'slow', durationMs)).catch(() => undefined)
      return result
    } catch (error) {
      void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
        recordDiagnostic('database.query_failed', 'error', performance.now() - startedAt)).catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    this.db = null
  }
}

// --- Module state ---

let db: DBAdapter | null = null

// --- Runtime state ---

type DatabaseStatus = 'idle' | 'initializing' | 'ready' | 'error'

interface DatabaseRuntimeState {
  status: DatabaseStatus
  error?: string
}

let runtimeState: DatabaseRuntimeState = { status: 'idle' }
const runtimeListeners = new Set<(state: DatabaseRuntimeState) => void>()

function setRuntimeState(next: DatabaseRuntimeState) {
  runtimeState = next
  for (const listener of runtimeListeners) {
    try { listener(runtimeState) } catch { /* swallow */ }
  }
}

export function getDatabaseRuntimeState(): DatabaseRuntimeState {
  return runtimeState
}

export function subscribeDatabaseRuntimeState(
  listener: (state: DatabaseRuntimeState) => void,
): () => void {
  runtimeListeners.add(listener)
  return () => { runtimeListeners.delete(listener) }
}

/**
 * Get database adapter for maintenance tasks (legacy detection etc.).
 * Returns the adapter if initialized, otherwise throws.
 */
export function getDatabaseForMaintenance(): DBAdapter {
  if (!db) throw new Error('Database not initialized. Cannot perform maintenance.')
  return db
}

export async function initDatabase(): Promise<void> {
  setRuntimeState({ status: 'initializing' })

  if (!isTauri()) {
    const error = 'Web 端不支持数据库能力'
    setRuntimeState({ status: 'error', error })
    throw new Error(error)
  }

  try {
    const adapter = new TauriSQLiteAdapter()
    await adapter.init()
    db = adapter
    console.log('[DB] Tauri SQLite initialized')
    setRuntimeState({ status: 'ready' })
  } catch (err) {
    void import('@/services/productionDiagnostics').then(({ recordDiagnostic }) =>
      recordDiagnostic('database.init_failed', 'error')).catch(() => undefined)
    const message = err instanceof Error ? err.message : String(err)
    db = null
    setRuntimeState({ status: 'error', error: message })
    throw new Error(`无法初始化 SQLite 数据库：${message}`)
  }
}

export function getDatabase(): DBAdapter {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close()
    db = null
  }
}

/**
 * Check if database is initialized.
 */
export function isDatabaseReady(): boolean {
  return db !== null
}
