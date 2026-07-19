/**
 * Lightweight legacy IndexedDB detector.
 * Checks once whether old IndexedDB data exists and persists the result.
 */

import { getDatabaseForMaintenance } from './db'

const LEGACY_DATABASE_NAME = 'guanmo-db'
const DETECTION_ID = 1

export interface LegacyDetectionResult {
  legacyDetected: boolean
  userNoticed: boolean
  detectedAt: number | null
  noticedAt: number | null
  detectedCounts: LegacyStoreCounts | null
}

export interface LegacyStoreCounts {
  documents: number
  chat_sessions: number
  chat_messages: number
  memories: number
}

/**
 * Check if legacy IndexedDB exists and has data.
 * Returns null if IndexedDB API is not available (e.g., in web context).
 */
async function inspectLegacyIndexedDB(): Promise<LegacyStoreCounts | null> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) {
    return null
  }

  try {
    const databases = await indexedDB.databases()
    const hasLegacy = databases.some((db) => db.name === LEGACY_DATABASE_NAME)
    if (!hasLegacy) {
      return { documents: 0, chat_sessions: 0, chat_messages: 0, memories: 0 }
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DATABASE_NAME)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const counts: LegacyStoreCounts = {
          documents: 0,
          chat_sessions: 0,
          chat_messages: 0,
          memories: 0,
        }

        const storeNames = ['documents', 'chat_sessions', 'chat_messages', 'memories'] as const
        let completed = 0

        for (const storeName of storeNames) {
          if (!db.objectStoreNames.contains(storeName)) {
            completed++
            if (completed === storeNames.length) {
              db.close()
              resolve(counts)
            }
            continue
          }

          const tx = db.transaction(storeName, 'readonly')
          const store = tx.objectStore(storeName)
          const countReq = store.count()

          countReq.onsuccess = () => {
            counts[storeName] = countReq.result
            completed++
            if (completed === storeNames.length) {
              db.close()
              resolve(counts)
            }
          }

          countReq.onerror = () => {
            completed++
            if (completed === storeNames.length) {
              db.close()
              resolve(counts)
            }
          }
        }
      }
      request.onblocked = () => reject(new Error('IndexedDB blocked'))
    })
  } catch {
    return null
  }
}

/**
 * Get current detection state from SQLite.
 */
export async function getLegacyDetectionState(): Promise<LegacyDetectionResult | null> {
  try {
    const db = getDatabaseForMaintenance()
    const rows = await db.select<{
      legacy_detected: number
      user_noticed: number
      detected_at: number | null
      noticed_at: number | null
      detected_counts: string | null
    }>('SELECT * FROM legacy_idb_detection WHERE id = $1', [DETECTION_ID])

    if (rows.length === 0) {
      return null
    }

    const row = rows[0]
    return {
      legacyDetected: row.legacy_detected === 1,
      userNoticed: row.user_noticed === 1,
      detectedAt: row.detected_at,
      noticedAt: row.noticed_at,
      detectedCounts: row.detected_counts ? JSON.parse(row.detected_counts) : null,
    }
  } catch {
    return null
  }
}

/**
 * Persist detection result to SQLite.
 */
async function persistDetectionResult(
  legacyDetected: boolean,
  counts: LegacyStoreCounts | null,
): Promise<void> {
  const db = getDatabaseForMaintenance()
  const now = Date.now()

  await db.execute(
    `INSERT INTO legacy_idb_detection (id, legacy_detected, user_noticed, detected_at, detected_counts, updated_at)
     VALUES ($1, $2, 0, $3, $4, $5)
     ON CONFLICT(id) DO UPDATE SET
       legacy_detected = $2,
       detected_at = $3,
       detected_counts = $4,
       updated_at = $5`,
    [
      DETECTION_ID,
      legacyDetected ? 1 : 0,
      now,
      counts ? JSON.stringify(counts) : null,
      now,
    ],
  )
}

/**
 * Mark that user has been noticed about legacy data.
 */
export async function markLegacyDetected(): Promise<void> {
  const db = getDatabaseForMaintenance()
  const now = Date.now()

  await db.execute(
    `UPDATE legacy_idb_detection
     SET user_noticed = 1, noticed_at = $1, updated_at = $1
     WHERE id = $2`,
    [now, DETECTION_ID],
  )
}

/**
 * Run legacy detection once.
 * If already detected, returns cached result.
 * Otherwise, inspects IndexedDB and persists result.
 */
export async function detectLegacyData(): Promise<LegacyDetectionResult> {
  // Check if already detected
  const existing = await getLegacyDetectionState()
  if (existing) {
    return existing
  }

  // Inspect IndexedDB
  const counts = await inspectLegacyIndexedDB()
  const legacyDetected = counts
    ? (counts.documents + counts.chat_sessions + counts.chat_messages + counts.memories) > 0
    : false

  // Persist result
  await persistDetectionResult(legacyDetected, counts)

  return {
    legacyDetected,
    userNoticed: false,
    detectedAt: Date.now(),
    noticedAt: null,
    detectedCounts: counts,
  }
}

/**
 * Get SQLite data counts for comparison.
 */
export async function getSqliteStoreCounts(): Promise<LegacyStoreCounts> {
  const db = getDatabaseForMaintenance()

  const [documents, chatSessions, chatMessages, memories] = await Promise.all([
    db.select<{ count: number }>('SELECT COUNT(*) AS count FROM documents'),
    db.select<{ count: number }>('SELECT COUNT(*) AS count FROM chat_sessions'),
    db.select<{ count: number }>('SELECT COUNT(*) AS count FROM chat_messages'),
    db.select<{ count: number }>('SELECT COUNT(*) AS count FROM memories'),
  ])

  return {
    documents: documents[0]?.count ?? 0,
    chat_sessions: chatSessions[0]?.count ?? 0,
    chat_messages: chatMessages[0]?.count ?? 0,
    memories: memories[0]?.count ?? 0,
  }
}

/**
 * Get legacy IndexedDB file path (Windows).
 */
export function getLegacyIndexedDBPath(): string {
  // IndexedDB is stored in browser profile, typically at:
  // %LOCALAPPDATA%/Microsoft/Edge/User Data/Default/IndexedDB/
  // or %LOCALAPPDATA%/Google/Chrome/User Data/Default/IndexedDB/
  // We return a general hint for the user.
  return '%LOCALAPPDATA%\\<Browser>\\User Data\\Default\\IndexedDB\\'
}

/**
 * Get SQLite database path hint.
 */
export function getSqliteDatabasePath(): string {
  // Tauri app data directory
  return '%APPDATA%\\com.guanmo.app\\guanmo.db'
}
