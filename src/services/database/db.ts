/**
 * Database service for 观墨.
 * Tauri: uses tauri-plugin-sql (SQLite).
 * Web: no database (read-only document viewing).
 */

import { isTauri } from '@/hooks/useTauri'
import { DB_SCHEMA, DB_MIGRATIONS, DB_NAME, DB_POST_MIGRATION_STATEMENTS } from './schema'

// --- Database abstraction ---

interface DBAdapter {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

// --- Tauri SQLite adapter ---

class TauriSQLiteAdapter implements DBAdapter {
  private db: any = null

  async init(): Promise<void> {
    const Database = (await import('@tauri-apps/plugin-sql')).default
    this.db = await Database.load(`sqlite:${DB_NAME}`)
    await this.db.execute('PRAGMA foreign_keys = ON')
    // Run base schema first, then explicit column migrations.
    const statements = DB_SCHEMA.split(';').filter((s) => s.trim())
    for (const stmt of statements) {
      await this.db.execute(stmt)
    }
    await this.runMigrations()
    for (const statement of DB_POST_MIGRATION_STATEMENTS) {
      await this.db.execute(statement)
    }
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_chat_messages_parent_id ON chat_messages(parent_id)')
  }

  private async hasColumn(table: string, column: string): Promise<boolean> {
    const rows = await this.db.select(`PRAGMA table_info(${table})`) as Array<{ name: string }>
    return rows.some((row) => row.name === column)
  }

  private async runMigrations(): Promise<void> {
    for (const migration of DB_MIGRATIONS) {
      if (await this.hasColumn(migration.table, migration.column)) continue
      await this.db.execute(migration.sql)
    }
    await this.db.execute(`
      WITH ordered_messages AS (
        SELECT
          id,
          role,
          LAG(id) OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC) AS previous_id,
          LAG(role) OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC) AS previous_role
        FROM chat_messages
      )
      UPDATE chat_messages
      SET parent_id = (
        SELECT previous_id FROM ordered_messages WHERE ordered_messages.id = chat_messages.id
      )
      WHERE role = 'assistant'
        AND parent_id IS NULL
        AND id IN (
          SELECT id FROM ordered_messages WHERE role = 'assistant' AND previous_role = 'user'
        )
    `)
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.execute(sql, params)
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.select(sql, params) as Promise<T[]>
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
