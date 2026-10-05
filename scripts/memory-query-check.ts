import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildMemoryEmbeddingQuery, buildMemoryQuery } from '../src/services/database/memoryQuery'
import { DB_POST_MIGRATION_STATEMENTS } from '../src/services/database/schema'

const globalQuery = buildMemoryQuery({
  statuses: ['active'],
  scopeType: 'global',
  categories: ['preference', 'instruction'],
  includeEmbedding: false,
})
assert.doesNotMatch(globalQuery.sql, /SELECT \*/)
assert.doesNotMatch(globalQuery.sql, /(?:,|SELECT )\s*embedding(?:,|\s+FROM)/)
assert.match(globalQuery.sql, /category IN \(\$1, \$2\)/)
assert.match(globalQuery.sql, /status IN \(\$3\)/)
assert.match(globalQuery.sql, /COALESCE\(scope_type, 'global'\) = 'global'/)
assert.deepEqual(globalQuery.params, ['preference', 'instruction', 'active'])

const projectQuery = buildMemoryQuery({
  statuses: ['active'],
  scopeType: 'project',
  scopeKey: 'd:/react/guanmo-open',
  includeEmbedding: false,
})
assert.match(projectQuery.sql, /scope_type = 'project' AND scope_key = \$2/)
assert.deepEqual(projectQuery.params, ['active', 'd:/react/guanmo-open'])

const legacyQuery = buildMemoryQuery({ includeEmbedding: true })
assert.match(legacyQuery.sql, /, embedding FROM memories/)
assert.deepEqual(legacyQuery.params, [])

const emptyCategories = buildMemoryQuery({ categories: [] })
assert.match(emptyCategories.sql, /WHERE 1 = 0/)

const embeddingQuery = buildMemoryEmbeddingQuery(['a', 'b'])
assert.ok(embeddingQuery)
assert.equal(embeddingQuery.sql, 'SELECT id, embedding, embedding_model, content_hash FROM memories WHERE id IN ($1, $2)')
assert.deepEqual(embeddingQuery.params, ['a', 'b'])
assert.equal(buildMemoryEmbeddingQuery([]), null)

assert.ok(DB_POST_MIGRATION_STATEMENTS.some((sql) => sql.includes('idx_memories_retrieval')))
const dbSource = readFileSync('src/services/database/db.ts', 'utf8')
const schemaInitializer = dbSource.slice(dbSource.indexOf('export async function initializeDatabaseSchema('), dbSource.indexOf('// --- Tauri SQLite adapter ---'))
assert.match(schemaInitializer, /for \(const migration of DB_MIGRATIONS\)[\s\S]*await database\.execute\(migration\.sql\)[\s\S]*await executeLatestSchema\(database, true\)[\s\S]*for \(const statement of DB_POST_MIGRATION_STATEMENTS\)[\s\S]*await database\.execute\(statement\)/, '兼容索引必须在旧列迁移完成后创建')
assert.match(dbSource, /await initializeDatabaseSchema\(this\.db\)/, '数据库 adapter 必须执行版本化 schema 初始化')

const persistence = readFileSync('src/services/database/persistence.ts', 'utf8')
const memoryService = readFileSync('src/services/memory/memoryService.ts', 'utf8')
assert.doesNotMatch(persistence, /SELECT \* FROM memories/, '记忆查询不得 SELECT *')
assert.match(memoryService, /loadMemories\(\{[\s\S]*statuses: \['active'\][\s\S]*scopeType[\s\S]*categories/, '检索过滤必须下推 SQLite')
assert.match(memoryService, /scopeKey: options\.scopeType === 'project' \? requestedScopeKey : null/, '项目路径必须规范化后再传入 SQLite')
assert.match(memoryService, /loadMemoryEmbeddings\(candidates\.map/, '只允许为候选集加载 embedding')

console.log('memory query checks passed')
