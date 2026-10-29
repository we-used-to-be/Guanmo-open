export interface MemoryQueryFilters {
  ids?: readonly string[]
  category?: string
  categories?: readonly string[]
  statuses?: readonly string[]
  scopeType?: 'global' | 'project'
  scopeKey?: string | null
  includeGlobalForProject?: boolean
  includeEmbedding?: boolean
  limit?: number
  offset?: number
}

export interface SqlQuery {
  sql: string
  params: unknown[]
}

const MEMORY_COLUMNS = [
  'id', 'content', 'category', 'source', 'locked', 'status',
  'scope_type', 'scope_key', 'subject', 'fact_key', 'fact_value',
  'confidence', 'evidence', 'supersedes_id', 'embedding_model',
  'content_hash', 'created_at', 'updated_at',
]

function buildMemoryConditions(filters: MemoryQueryFilters): {
  conditions: string[]
  params: unknown[]
} {
  const params: unknown[] = []
  const conditions: string[] = []
  const addValues = (column: string, values: readonly string[]) => {
    if (values.length === 0) {
      conditions.push('1 = 0')
      return
    }
    const placeholders = values.map((value) => {
      params.push(value)
      return `$${params.length}`
    })
    conditions.push(`${column} IN (${placeholders.join(', ')})`)
  }

  if (filters.category) {
    params.push(filters.category)
    conditions.push(`category = $${params.length}`)
  } else if (filters.categories) {
    addValues('category', filters.categories)
  }
  if (filters.statuses) addValues('status', filters.statuses)
  if (filters.ids) addValues('id', filters.ids)

  if (filters.scopeType === 'global') {
    conditions.push("COALESCE(scope_type, 'global') = 'global'")
  } else if (filters.scopeType === 'project') {
    params.push(filters.scopeKey || '')
    const projectCondition = `scope_type = 'project' AND scope_key = $${params.length}`
    conditions.push(filters.includeGlobalForProject === false
      ? `(${projectCondition})`
      : `(
      COALESCE(scope_type, 'global') = 'global'
      OR (${projectCondition})
    )`)
  }

  return { conditions, params }
}

function buildWhereClause(conditions: readonly string[]): string {
  return conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
}

function normalizeLimit(limit: number): number {
  return Math.min(200, Math.max(1, Math.trunc(limit)))
}

function normalizeOffset(offset: number | undefined): number {
  return offset !== undefined && Number.isFinite(offset)
    ? Math.max(0, Math.trunc(offset))
    : 0
}

export function buildMemoryQuery(filters: MemoryQueryFilters = {}): SqlQuery {
  const { conditions, params } = buildMemoryConditions(filters)
  const columns = filters.includeEmbedding
    ? [...MEMORY_COLUMNS, 'embedding']
    : MEMORY_COLUMNS
  const where = buildWhereClause(conditions)
  let pagination = ''
  if (filters.limit !== undefined && Number.isFinite(filters.limit)) {
    params.push(normalizeLimit(filters.limit))
    const limitPlaceholder = `$${params.length}`
    params.push(normalizeOffset(filters.offset))
    pagination = ` LIMIT ${limitPlaceholder} OFFSET $${params.length}`
  }
  return {
    sql: `SELECT ${columns.join(', ')} FROM memories${where} ORDER BY updated_at DESC, id ASC${pagination}`,
    params,
  }
}

export function buildMemoryCountQuery(filters: MemoryQueryFilters = {}): SqlQuery {
  const { conditions, params } = buildMemoryConditions(filters)
  return {
    sql: `SELECT COUNT(*) AS total FROM memories${buildWhereClause(conditions)}`,
    params,
  }
}

export function buildMemoryEmbeddingQuery(ids: readonly string[]): SqlQuery | null {
  if (ids.length === 0) return null
  return {
    sql: `SELECT id, embedding, embedding_model, content_hash FROM memories WHERE id IN (${ids.map((_, index) => `$${index + 1}`).join(', ')})`,
    params: [...ids],
  }
}
