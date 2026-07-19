/**
 * merge-sqlite.js — 将导出的 JSON 数据合并到 SQLite 数据库
 *
 * 流程：
 * 1. 读取导出的 JSON 和当前 SQLite
 * 2. 备份正式 SQLite
 * 3. 使用 SQLite Backup API 创建输出文件
 * 4. 合并数据到输出副本
 * 5. 执行完整性校验
 * 6. 生成合并报告
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

// 需要处理的 store（跳过 chunks、embeddings、embedding_jobs）
const MERGE_STORES = ['documents', 'chat_sessions', 'chat_messages', 'memories', 'settings'];

// JSON 字段到 SQLite 列的映射
const COLUMN_MAP = {
  documents: {
    id: 'id',
    file_path: 'file_path',
    title: 'title',
    content: 'content',
    content_hash: 'content_hash',
    last_modified: 'last_modified',
    created_at: 'created_at',
  },
  chat_sessions: {
    id: 'id',
    title: 'title',
    created_at: 'created_at',
    updated_at: 'updated_at',
  },
  chat_messages: {
    id: 'id',
    session_id: 'session_id',
    parent_id: 'parent_id',
    role: 'role',
    content: 'content',
    metadata: 'metadata',
    created_at: 'created_at',
  },
  memories: {
    id: 'id',
    content: 'content',
    category: 'category',
    source: 'source',
    locked: 'locked',
    status: 'status',
    scope_type: 'scope_type',
    scope_key: 'scope_key',
    subject: 'subject',
    fact_key: 'fact_key',
    fact_value: 'fact_value',
    confidence: 'confidence',
    evidence: 'evidence',
    supersedes_id: 'supersedes_id',
    embedding: 'embedding',
    embedding_model: 'embedding_model',
    content_hash: 'content_hash',
    created_at: 'created_at',
    updated_at: 'updated_at',
  },
  settings: {
    key: 'key',
    value: 'value',
    updated_at: 'updated_at',
  },
};

// memories 业务核心字段（用于比较）
const MEMORY_CORE_FIELDS = ['content', 'category', 'source', 'locked', 'status'];

// documents 业务核心字段（用于比较，只比较 title 和 content）
const DOCUMENT_CORE_FIELDS = ['title', 'content'];

/**
 * 合并 JSON 数据到 SQLite
 * @param {object} args 命令行参数
 */
export async function mergeSqlite(args) {
  console.log('🔄 guanmo-idb-export — SQLite 合并\n');

  // 1. 验证参数
  const jsonPath = args.json;
  const sqlitePath = args.sqlite;
  const outputPath = args.output;

  if (!jsonPath) {
    console.error('❌ 缺少 --json 参数（导出的 JSON 文件路径）');
    process.exit(1);
  }
  if (!sqlitePath) {
    console.error('❌ 缺少 --sqlite 参数（当前 SQLite 数据库路径）');
    process.exit(1);
  }

  // 读取 JSON
  if (!fs.existsSync(jsonPath)) {
    console.error(`❌ JSON 文件不存在: ${jsonPath}`);
    process.exit(1);
  }
  const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  console.log(`✅ 读取 JSON: ${jsonPath}`);

  // 2. 检查 SQLite
  if (!fs.existsSync(sqlitePath)) {
    console.error(`❌ SQLite 数据库不存在: ${sqlitePath}`);
    process.exit(1);
  }
  console.log(`✅ 读取 SQLite: ${sqlitePath}`);

  // 3. 备份正式 SQLite
  if (!args.noBackup) {
    const backupPath = sqlitePath + `.backup-${Date.now()}`;
    fs.copyFileSync(sqlitePath, backupPath);
    console.log(`✅ 备份 SQLite: ${backupPath}`);
  }

  // 4. 使用 SQLite Backup API 创建输出文件
  const outputDbPath = outputPath || sqlitePath.replace(/\.db$/, `-merged-${Date.now()}.db`);

  // 检查输出文件是否已存在
  if (fs.existsSync(outputDbPath)) {
    console.error(`❌ 输出文件已存在: ${outputDbPath}`);
    console.error('   请使用 --output 指定不同的输出路径，或删除现有文件');
    process.exit(1);
  }

  // 使用 SQLite Backup API 创建副本
  console.log('   使用 SQLite Backup API 创建副本...');
  const sourceDb = new Database(sqlitePath, { readonly: true });

  try {
    // 执行异步备份
    await sourceDb.backup(outputDbPath);
    console.log(`✅ 使用 Backup API 创建输出文件: ${outputDbPath}`);
  } catch (err) {
    console.error(`❌ Backup API 失败: ${err.message}`);
    // 清理失败的输出文件
    if (fs.existsSync(outputDbPath)) {
      fs.unlinkSync(outputDbPath);
    }
    process.exit(1);
  } finally {
    sourceDb.close();
  }

  // 5. 打开输出数据库进行合并
  const db = new Database(outputDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF'); // 合并时暂时关闭外键约束

  const stats = {
    imported: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
    orphanMessages: 0,
  };
  const conflicts = [];
  const errors = [];
  const orphanMessages = []; // 孤立消息记录

  try {
    // 6. 合并各 store
    for (const storeName of MERGE_STORES) {
      console.log(`\n📦 处理 ${storeName}...`);

      const jsonRecords = jsonData[storeName]?.records || [];
      if (jsonRecords.length === 0) {
        console.log(`   跳过（JSON 中无记录）`);
        continue;
      }

      // 获取 SQLite 中的所有 ID 和辅助数据
      const idColumn = storeName === 'settings' ? 'key' : 'id';
      const existingIds = new Set(
        db.prepare(`SELECT ${idColumn} FROM ${storeName}`).all().map(r => r[idColumn])
      );

      // documents: 获取 file_path 到 id 的映射
      const existingFilePathMap = new Map();
      if (storeName === 'documents') {
        db.prepare('SELECT id, file_path FROM documents').all().forEach(r => {
          existingFilePathMap.set(normalizeFilePath(r.file_path), r.id);
        });
      }

      // chat_sessions: 获取所有 session id
      const existingSessionIds = new Set(
        storeName === 'chat_messages'
          ? db.prepare('SELECT id FROM chat_sessions').all().map(r => r.id)
          : []
      );

      const columns = COLUMN_MAP[storeName];
      const colNames = Object.values(columns);
      const placeholders = colNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${storeName} (${colNames.join(', ')}) VALUES (${placeholders})`;

      const insertStmt = db.prepare(insertSql);
      let storeImported = 0;
      let storeSkipped = 0;
      let storeConflicts = 0;

      for (const record of jsonRecords) {
        const id = record.id || record.key; // settings 用 key 作为 id

        if (storeName === 'settings') {
          // settings 以 SQLite 为准，只补不存在的键
          if (existingIds.has(id)) {
            storeSkipped++;
            continue;
          }
        } else {
          // 检查 ID 是否存在
          if (existingIds.has(id)) {
            // 检查内容是否一致
            const existingRow = db.prepare(`SELECT * FROM ${storeName} WHERE ${idColumn} = ?`).get(id);
            const jsonRecord = normalizeRecord(record, storeName);

            // 使用专门的比较函数
            let isEqual;
            if (storeName === 'memories') {
              isEqual = isMemoryContentEqual(existingRow, jsonRecord);
            } else {
              isEqual = isContentEqual(existingRow, jsonRecord, storeName);
            }

            if (isEqual) {
              // 内容一致，跳过
              storeSkipped++;
              continue;
            } else {
              // 内容不同，记录冲突，保留 SQLite 版本
              storeConflicts++;
              conflicts.push({
                store: storeName,
                id,
                sqliteRecord: existingRow,
                jsonRecord: jsonRecord,
              });
              continue;
            }
          }

          // documents 表：检查 file_path 是否已存在（UNIQUE 约束）
          if (storeName === 'documents' && record.file_path) {
            const normalizedPath = normalizeFilePath(record.file_path);
            if (existingFilePathMap.has(normalizedPath)) {
              // file_path 已存在，需要比较核心字段
              const existingDocId = existingFilePathMap.get(normalizedPath);
              const existingDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(existingDocId);
              const normalizedRecord = normalizeRecord(record, storeName);

              if (isDocumentContentEqual(existingDoc, normalizedRecord)) {
                // 内容一致，跳过
                storeSkipped++;
                continue;
              } else {
                // 内容不同，记录冲突
                storeConflicts++;
                conflicts.push({
                  store: storeName,
                  id,
                  existingId: existingDocId,
                  conflictType: 'file_path_duplicate',
                  sqliteRecord: existingDoc,
                  jsonRecord: normalizedRecord,
                });
                continue;
              }
            }
          }

          // chat_messages 表：检查 session_id 是否存在于 chat_sessions
          if (storeName === 'chat_messages' && record.session_id) {
            if (!existingSessionIds.has(record.session_id)) {
              // session_id 不存在，记录孤立消息
              orphanMessages.push({
                id: record.id,
                session_id: record.session_id,
                role: record.role,
                content: record.content?.substring(0, 100), // 截断内容用于报告
                created_at: record.created_at,
                reason: 'session_id 不存在于 chat_sessions',
              });
              stats.orphanMessages++;
              storeSkipped++;
              continue;
            }
          }
        }

        // 插入新记录（先标准化）
        try {
          const normalizedRecord = normalizeRecord(record, storeName);
          const values = colNames.map(col => {
            const val = normalizedRecord[col];
            return val ?? null;
          });
          insertStmt.run(...values);
          storeImported++;
        } catch (err) {
          storeSkipped++;
          errors.push({
            store: storeName,
            id,
            error: err.message,
          });
          console.error(`   ❌ 插入失败 ${id}: ${err.message}`);
        }
      }

      stats.imported += storeImported;
      stats.skipped += storeSkipped;
      stats.conflicts += storeConflicts;

      console.log(`   ✅ 导入: ${storeImported}, 跳过: ${storeSkipped}, 冲突: ${storeConflicts}`);
    }

    // 7. 执行完整性校验
    console.log('\n🔍 执行完整性校验...');

    // PRAGMA integrity_check
    const integrityResult = db.pragma('integrity_check', { simple: true });
    if (integrityResult !== 'ok') {
      console.error(`❌ 完整性校验失败: ${integrityResult}`);
      stats.errors++;
    } else {
      console.log('   ✅ PRAGMA integrity_check: ok');
    }

    // PRAGMA foreign_key_check
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (fkViolations.length > 0) {
      console.error(`❌ 外键约束违规: ${fkViolations.length} 条`);
      stats.errors++;
    } else {
      console.log('   ✅ PRAGMA foreign_key_check: ok');
    }

    // 数量校验
    console.log('\n📊 数量统计:');
    for (const storeName of MERGE_STORES) {
      const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${storeName}`).get().cnt;
      const jsonCount = jsonData[storeName]?.records?.length || 0;
      console.log(`   ${storeName}: SQLite=${count}, JSON=${jsonCount}`);
    }

    // 会话消息关系校验
    console.log('\n🔗 会话消息关系校验:');
    const dbOrphanMessages = db.prepare(`
      SELECT cm.id, cm.session_id
      FROM chat_messages cm
      LEFT JOIN chat_sessions cs ON cm.session_id = cs.id
      WHERE cs.id IS NULL
    `).all();
    if (dbOrphanMessages.length > 0) {
      console.log(`   ⚠️  数据库中存在 ${dbOrphanMessages.length} 条孤立消息（来自原始数据库）`);
    } else {
      console.log('   ✅ 数据库中所有消息都有对应的会话');
    }

    // 显示本次合并跳过的孤立消息
    if (orphanMessages.length > 0) {
      console.log(`   ⚠️  本次合并跳过 ${orphanMessages.length} 条孤立消息（session_id 不存在）`);
    }

    // 8. 生成报告
    const reportPath = outputDbPath.replace(/\.db$/, '-report.json');
    const report = {
      timestamp: new Date().toISOString(),
      stats,
      conflicts,
      errors,
      orphanMessages,
      databaseOrphanMessages: dbOrphanMessages,
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n📝 合并报告: ${reportPath}`);

  } finally {
    db.close();
  }

  // 9. 输出最终统计
  console.log('\n' + '═'.repeat(55));
  console.log('  合并完成');
  console.log('═'.repeat(55));
  console.log(`  导入数:    ${stats.imported}`);
  console.log(`  跳过数:    ${stats.skipped}`);
  console.log(`  冲突数:    ${stats.conflicts}`);
  console.log(`  错误数:    ${stats.errors}`);
  console.log(`  孤立消息:  ${stats.orphanMessages} 条`);
  console.log('');
  console.log(`  输出文件: ${outputDbPath}`);
  console.log('═'.repeat(55));

  return { stats, outputPath: outputDbPath };
}

/**
 * 规范化文件路径（统一使用正斜杠，移除末尾斜杠）
 */
function normalizeFilePath(filePath) {
  if (!filePath) return '';
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 标准化记录，统一字段名和格式
 */
function normalizeRecord(record, storeName) {
  const normalized = { ...record };

  // 处理 JSON 中可能使用下划线命名的字段
  if (storeName === 'chat_messages') {
    // JSON 可能使用 parent_id 或 parentId
    if (normalized.parentId !== undefined && normalized.parent_id === undefined) {
      normalized.parent_id = normalized.parentId;
    }
  }

  if (storeName === 'memories') {
    // 处理 locked 字段
    if (typeof normalized.locked === 'boolean') {
      normalized.locked = normalized.locked ? 1 : 0;
    }
    // 处理 embedding 字段
    if (Array.isArray(normalized.embedding)) {
      normalized.embedding = JSON.stringify(normalized.embedding);
    }
    // 处理 NOT NULL 字段的默认值
    if (!normalized.scope_type) normalized.scope_type = 'global';
    if (!normalized.category) normalized.category = 'general';
    if (!normalized.source) normalized.source = 'auto_extracted';
    if (!normalized.status) normalized.status = 'active';
    if (normalized.confidence === undefined || normalized.confidence === null) {
      normalized.confidence = 1;
    }
  }

  if (storeName === 'documents') {
    // 规范化文件路径
    if (normalized.file_path) {
      normalized.file_path = normalizeFilePath(normalized.file_path);
    }
  }

  return normalized;
}

/**
 * 比较 SQLite 记录和 JSON 记录的内容是否一致（通用比较）
 */
function isContentEqual(sqliteRow, jsonRecord, storeName) {
  if (!sqliteRow) return false;

  const columns = COLUMN_MAP[storeName];

  for (const [jsonKey, sqlCol] of Object.entries(columns)) {
    const sqliteVal = sqliteRow[sqlCol];
    let jsonVal = jsonRecord[jsonKey];

    // 特殊处理 locked 字段
    if (sqlCol === 'locked') {
      const sqliteBool = sqliteVal === 1;
      const jsonBool = jsonVal === true || jsonVal === 1;
      if (sqliteBool !== jsonBool) return false;
      continue;
    }

    // 特殊处理 embedding 字段
    if (sqlCol === 'embedding') {
      const sqliteEmbedding = typeof sqliteVal === 'string' ? sqliteVal : null;
      const jsonEmbedding = Array.isArray(jsonVal) ? JSON.stringify(jsonVal) : jsonVal;
      if (sqliteEmbedding !== jsonEmbedding) return false;
      continue;
    }

    // 其他字段直接比较
    if (String(sqliteVal ?? '') !== String(jsonVal ?? '')) {
      return false;
    }
  }

  return true;
}

/**
 * 比较 memories 的业务核心字段
 * 忽略自动生成字段（created_at, updated_at）和默认补齐字段
 */
function isMemoryContentEqual(sqliteRow, jsonRecord) {
  if (!sqliteRow) return false;

  for (const field of MEMORY_CORE_FIELDS) {
    const sqliteVal = sqliteRow[field];
    let jsonVal = jsonRecord[field];

    // locked 字段特殊处理
    if (field === 'locked') {
      const sqliteBool = sqliteVal === 1;
      const jsonBool = jsonVal === true || jsonVal === 1;
      if (sqliteBool !== jsonBool) return false;
      continue;
    }

    // 比较时忽略 null、undefined、空字符串
    const normalizedSqlite = sqliteVal ?? null;
    const normalizedJson = jsonVal ?? null;

    if (String(normalizedSqlite) !== String(normalizedJson)) {
      return false;
    }
  }

  return true;
}

/**
 * 比较 documents 的业务核心字段
 * 忽略 created_at 和自动字段
 */
function isDocumentContentEqual(sqliteRow, jsonRecord) {
  if (!sqliteRow) return false;

  for (const field of DOCUMENT_CORE_FIELDS) {
    const sqliteVal = sqliteRow[field];
    let jsonVal = jsonRecord[field];

    // file_path 特殊处理：规范化后比较
    if (field === 'file_path') {
      const normalizedSqlite = normalizeFilePath(sqliteVal);
      const normalizedJson = normalizeFilePath(jsonVal);
      if (normalizedSqlite !== normalizedJson) return false;
      continue;
    }

    // 比较时忽略 null、undefined
    const normalizedSqlite = sqliteVal ?? null;
    const normalizedJson = jsonVal ?? null;

    if (String(normalizedSqlite) !== String(normalizedJson)) {
      return false;
    }
  }

  return true;
}
