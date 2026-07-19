/**
 * Database service for 观墨.
 * Tauri: uses tauri-plugin-sql (SQLite).
 * Web: no database (read-only document viewing).
 */

import { isTauri } from '@/hooks/useTauri'
import { DB_SCHEMA, DB_MIGRATIONS, DB_NAME } from './schema'

// --- Database abstraction ---

interface DBAdapter {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

// --- Tauri SQLite adapter ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// --- IndexedDB adapter (web fallback) ---

class IndexedDBAdapter implements DBAdapter {
  private dbName = 'guanmo-db'
  private version = 1
  private idb: IDBDatabase | null = null

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version)
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        // Create object stores matching our SQL tables
        const tables = ['documents', 'chunks', 'embeddings', 'embedding_jobs', 'chat_sessions', 'chat_messages', 'memories', 'settings']
        for (const table of tables) {
          if (!db.objectStoreNames.contains(table)) {
            db.createObjectStore(table, { keyPath: table === 'chunks' || table === 'embeddings' ? undefined : 'id' })
          }
        }
      }
      request.onsuccess = (event) => {
        this.idb = (event.target as IDBOpenDBRequest).result
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
  }

  private getStoreKey(table: string, record: Record<string, unknown>): IDBValidKey | undefined {
    const key = table === 'embeddings'
      ? record.chunk_id
      : table === 'settings'
        ? record.key
        : record.id
    return typeof key === 'string' || typeof key === 'number' ? key : undefined
  }

  private splitSqlList(value: string): string[] {
    const parts: string[] = []
    let current = ''
    let depth = 0
    let quote: string | null = null

    for (let i = 0; i < value.length; i += 1) {
      const char = value[i]
      if (quote) {
        current += char
        if (char === quote) quote = null
        continue
      }
      if (char === '\'' || char === '"') {
        quote = char
        current += char
        continue
      }
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      if (char === ',' && depth === 0) {
        parts.push(current.trim())
        current = ''
        continue
      }
      current += char
    }

    if (current.trim()) parts.push(current.trim())
    return parts
  }

  private extractValuesClause(sql: string): string[] {
    const valuesIndex = sql.search(/\bVALUES\s*\(/i)
    if (valuesIndex < 0) return []
    const start = sql.indexOf('(', valuesIndex)
    if (start < 0) return []

    let depth = 0
    let quote: string | null = null
    for (let i = start; i < sql.length; i += 1) {
      const char = sql[i]
      if (quote) {
        if (char === quote) quote = null
        continue
      }
      if (char === '\'' || char === '"') {
        quote = char
        continue
      }
      if (char === '(') depth += 1
      if (char === ')') {
        depth -= 1
        if (depth === 0) return this.splitSqlList(sql.slice(start + 1, i))
      }
    }
    return []
  }

  private evaluateInsertExpression(
    expression: string,
    params: unknown[],
    existing?: Record<string, unknown>
  ): unknown {
    const paramMatch = expression.match(/^\$(\d+)$/)
    if (paramMatch) return params[parseInt(paramMatch[1]) - 1]

    const stringMatch = expression.match(/^'([^']*)'$/)
    if (stringMatch) return stringMatch[1]

    if (/^NULL$/i.test(expression)) return null
    if (/^unixepoch\(\)$/i.test(expression)) return Math.floor(Date.now() / 1000)

    const coalesceParamMatch = expression.match(/^COALESCE\(\s*\(SELECT\s+(\w+)\s+FROM\s+\w+\s+WHERE\s+\w+\s*=\s*\$\d+\)\s*,\s*\$(\d+)\s*\)$/i)
    if (coalesceParamMatch) {
      const [, column, fallbackParam] = coalesceParamMatch
      return existing?.[column] ?? params[parseInt(fallbackParam) - 1]
    }

    const coalesceUnixMatch = expression.match(/^COALESCE\(\s*\(SELECT\s+(\w+)\s+FROM\s+\w+\s+WHERE\s+\w+\s*=\s*\$\d+\)\s*,\s*unixepoch\(\)\s*\)$/i)
    if (coalesceUnixMatch) {
      return existing?.[coalesceUnixMatch[1]] ?? Math.floor(Date.now() / 1000)
    }

    const coalesceNumberMatch = expression.match(/^COALESCE\(\s*\(SELECT\s+(\w+)\s+FROM\s+\w+\s+WHERE\s+\w+\s*=\s*\$\d+\)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/i)
    if (coalesceNumberMatch) {
      return existing?.[coalesceNumberMatch[1]] ?? Number(coalesceNumberMatch[2])
    }

    return undefined
  }

  async execute(sql: string, _params: unknown[] = []): Promise<{ rowsAffected: number }> {
    // Simple SQL parser for INSERT/UPDATE/DELETE
    const trimmed = sql.trim().toUpperCase()
    if (trimmed.startsWith('CREATE')) return { rowsAffected: 0 }
    if (trimmed.startsWith('INSERT')) return this.handleInsert(sql, _params)
    if (trimmed.startsWith('UPDATE')) return this.handleUpdate(sql, _params)
    if (trimmed.startsWith('DELETE')) return this.handleDelete(sql, _params)
    return { rowsAffected: 0 }
  }

  private handleInsert(sql: string, params: unknown[]): Promise<{ rowsAffected: number }> {
    // Extract table name from INSERT INTO table_name
    const match = sql.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)/i)
    if (!match || !this.idb) return Promise.resolve({ rowsAffected: 0 })
    const table = match[1]
    return new Promise((resolve, reject) => {
      const tx = this.idb!.transaction(table, 'readwrite')
      const store = tx.objectStore(table)
      // Build record from params based on column order
      const columns = sql.match(/\(([^)]+)\)/)?.[1].split(',').map((c) => c.trim())
      if (!columns) { resolve({ rowsAffected: 0 }); return }
      const valueExpressions = this.extractValuesClause(sql)
      const record: Record<string, unknown> = {}
      columns.forEach((col, i) => {
        record[col] = valueExpressions[i]
          ? this.evaluateInsertExpression(valueExpressions[i], params)
          : params[i]
      })
      for (const column of ['created_at', 'updated_at']) {
        if (record[column] === undefined) record[column] = Math.floor(Date.now() / 1000)
      }
      const key = this.getStoreKey(table, record)
      if (store.keyPath === 'id' && record.id === undefined && key !== undefined) {
        record.id = key
      }
      const req = store.keyPath ? store.put(record) : store.put(record, key)
      req.onsuccess = () => resolve({ rowsAffected: 1 })
      req.onerror = () => reject(req.error)
    })
  }

  private handleUpdate(sql: string, params: unknown[]): Promise<{ rowsAffected: number }> {
    const match = sql.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)/i)
    if (!match || !this.idb) return Promise.resolve({ rowsAffected: 0 })
    const [, table, setClause, whereClause] = match

    return new Promise((resolve, reject) => {
      const tx = this.idb!.transaction(table, 'readwrite')
      const store = tx.objectStore(table)
      const getReq = store.getAll()
      getReq.onsuccess = () => {
        const rows = getReq.result as Array<Record<string, unknown>>
        const rowsToUpdate = rows.filter((row) => this.matchesWhere(row, whereClause, params))
        if (rowsToUpdate.length === 0) {
          resolve({ rowsAffected: 0 })
          return
        }

        let remaining = rowsToUpdate.length
        for (const record of rowsToUpdate) {
          const nextRecord = { ...record }
          for (const assignment of this.splitSqlList(setClause)) {
            const assignMatch = assignment.trim().match(/^(\w+)\s*=\s*([\s\S]+)$/i)
            if (!assignMatch) continue
            const [, column, expression] = assignMatch
            nextRecord[column] = this.evaluateUpdateExpression(expression.trim(), params, record)
          }

          const key = this.getStoreKey(table, nextRecord)
          if (store.keyPath === 'id' && nextRecord.id === undefined && key !== undefined) {
            nextRecord.id = key
          }
          const putReq = store.keyPath ? store.put(nextRecord) : store.put(nextRecord, key)
          putReq.onsuccess = () => {
            remaining--
            if (remaining === 0) resolve({ rowsAffected: rowsToUpdate.length })
          }
          putReq.onerror = () => reject(putReq.error)
        }
      }
      getReq.onerror = () => reject(getReq.error)
    })
  }

  private matchesWhere(record: Record<string, unknown>, whereClause: string, params: unknown[]): boolean {
    for (const part of whereClause.split(/\s+AND\s+/i)) {
      const inMatch = part.match(/^\s*(\w+)\s+IN\s*\(([^)]+)\)\s*$/i)
      if (inMatch) {
        const [, column, values] = inMatch
        const expected = values
          .split(',')
          .map((value) => value.trim())
          .map((value) => {
            const paramMatch = value.match(/^\$(\d+)$/)
            if (paramMatch) return params[parseInt(paramMatch[1]) - 1]
            const literalMatch = value.match(/^'([^']*)'$/)
            return literalMatch ? literalMatch[1] : value
          })
        if (!expected.includes(record[column])) return false
        continue
      }

      const paramMatch = part.match(/^\s*(\w+)\s*=\s*\$(\d+)\s*$/i)
      if (paramMatch) {
        const [, column, paramIndex] = paramMatch
        if (record[column] !== params[parseInt(paramIndex) - 1]) return false
        continue
      }

      const literalMatch = part.match(/^\s*(\w+)\s*=\s*'([^']*)'\s*$/i)
      if (literalMatch) {
        const [, column, value] = literalMatch
        if (record[column] !== value) return false
      }
    }
    return true
  }

  private evaluateUpdateExpression(
    expression: string,
    params: unknown[],
    record: Record<string, unknown>
  ): unknown {
    const paramMatch = expression.match(/^\$(\d+)$/)
    if (paramMatch) return params[parseInt(paramMatch[1]) - 1]

    const stringMatch = expression.match(/^'([^']*)'$/)
    if (stringMatch) return stringMatch[1]

    if (/^NULL$/i.test(expression)) return null
    if (/^unixepoch\(\)$/i.test(expression)) return Math.floor(Date.now() / 1000)

    const retryMatch = expression.match(/^retry_count\s*\+\s*CASE\s+WHEN\s+\$(\d+)\s*=\s*'failed'\s+THEN\s+1\s+ELSE\s+0\s+END$/i)
    if (retryMatch) {
      const current = typeof record.retry_count === 'number' ? record.retry_count : 0
      return current + (params[parseInt(retryMatch[1]) - 1] === 'failed' ? 1 : 0)
    }

    return record[expression]
  }

  private handleDelete(sql: string, params: unknown[]): Promise<{ rowsAffected: number }> {
    const match = sql.match(/FROM\s+(\w+)/i)
    if (!match || !this.idb) return Promise.resolve({ rowsAffected: 0 })
    const table = match[1]
    const whereMatch = sql.match(/WHERE\s+([\s\S]+)/i)
    return new Promise((resolve, reject) => {
      const tx = this.idb!.transaction(table, 'readwrite')
      const store = tx.objectStore(table)
      if (!whereMatch) {
        const clearReq = store.clear()
        clearReq.onsuccess = () => resolve({ rowsAffected: 0 })
        clearReq.onerror = () => reject(clearReq.error)
        return
      }

      const req = store.getAll()
      req.onsuccess = () => {
        const rows = req.result as Array<Record<string, unknown>>
        const rowsToDelete = rows.filter((row) => this.matchesWhere(row, whereMatch[1], params))
        if (rowsToDelete.length === 0) {
          resolve({ rowsAffected: 0 })
          return
        }

        let remaining = rowsToDelete.length
        for (const row of rowsToDelete) {
          const key = this.getStoreKey(table, row)
          if (key === undefined) {
            remaining--
            if (remaining === 0) resolve({ rowsAffected: rowsToDelete.length })
            continue
          }
          const deleteReq = store.delete(key)
          deleteReq.onsuccess = () => {
            remaining--
            if (remaining === 0) resolve({ rowsAffected: rowsToDelete.length })
          }
          deleteReq.onerror = () => reject(deleteReq.error)
        }
      }
      req.onerror = () => reject(req.error)
    })
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const match = sql.match(/FROM\s+(\w+)/i)
    if (!match || !this.idb) return []
    const table = match[1]
    return new Promise((resolve, reject) => {
      const tx = this.idb!.transaction(table, 'readonly')
      const store = tx.objectStore(table)
      const req = store.getAll()
      req.onsuccess = () => {
        let results = req.result as T[]
        // Simple WHERE clause support
        const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*\$(\d+)/i)
        if (whereMatch) {
          const col = whereMatch[1]
          const paramIdx = parseInt(whereMatch[2]) - 1
          const val = params[paramIdx]
          results = results.filter((r) => (r as Record<string, unknown>)[col] === val)
        }
        resolve(results)
      }
      req.onerror = () => reject(req.error)
    })
  }

  async close(): Promise<void> {
    this.idb?.close()
    this.idb = null
  }
}

// --- Module state ---

let db: DBAdapter | null = null
let transactionTail: Promise<void> = Promise.resolve()

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

export async function serializeDatabaseTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const previous = transactionTail
  let release!: () => void
  transactionTail = new Promise<void>((resolve) => { release = resolve })
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
  }
}

export async function initDatabase(): Promise<void> {
  setRuntimeState({ status: 'initializing' })

  if (isTauri()) {
    // 桌面端优先使用 SQLite
    try {
      const adapter = new TauriSQLiteAdapter()
      await adapter.init()
      db = adapter
      console.log('[DB] Tauri SQLite initialized')
      setRuntimeState({ status: 'ready' })
      return
    } catch (err) {
      console.warn('[DB] Tauri SQLite failed, falling back to IndexedDB:', err)
    }
  }

  // Web端回退到 IndexedDB
  try {
    const adapter = new IndexedDBAdapter()
    await adapter.init()
    db = adapter
    console.log('[DB] IndexedDB initialized')
    setRuntimeState({ status: 'ready' })
  } catch (err) {
    console.error('[DB] IndexedDB failed:', err)
    const message = err instanceof Error ? err.message : String(err)
    setRuntimeState({ status: 'error', error: message })
    throw new Error('无法初始化数据库')
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
