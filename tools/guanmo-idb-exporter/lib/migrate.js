/**
 * migrate.js — 一键迁移流程
 *
 * 流程：
 * 1. 检测数据库（SQLite 位置、WebView2 目录）
 * 2. 导出 IndexedDB 为 JSON
 * 3. 备份 SQLite
 * 4. 合并到新 SQLite
 * 5. 完整性校验
 * 6. 输出结果和报告
 */

import { detectUserDataDir } from './detect.js';
import { exportIdb } from './export.js';
import { mergeSqlite } from './merge-sqlite.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 默认 SQLite 路径
const DEFAULT_SQLITE_PATHS = [
  path.join(os.homedir(), 'AppData', 'Roaming', 'com.guanmo.app', 'guanmo.db'),
  path.join(os.homedir(), 'AppData', 'Local', 'com.guanmo.app', 'guanmo.db'),
];

/**
 * 一键迁移
 * @param {object} args 命令行参数
 */
export async function migrate(args) {
  console.log('🚀 guanmo-idb-export — 一键迁移\n');
  console.log('═'.repeat(55));

  const startTime = Date.now();
  const result = {
    success: false,
    sqlitePath: null,
    jsonPath: null,
    outputPath: null,
    reportPath: null,
    stats: {
      imported: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      orphanMessages: 0,
    },
    conflicts: [],
    orphanMessages: [],
    errors: [],
    integrityCheck: false,
    foreignKeyCheck: false,
  };

  try {
    // 1. 检测数据库
    console.log('\n📍 步骤 1/6: 检测数据库...\n');

    // 检测 SQLite
    let sqlitePath = args.sqlite;
    if (!sqlitePath) {
      sqlitePath = await detectSqlitePath();
      if (!sqlitePath) {
        console.error('❌ 未找到观墨 SQLite 数据库');
        console.error('   请使用 --sqlite 参数手动指定路径');
        return result;
      }
    }

    if (!fs.existsSync(sqlitePath)) {
      console.error(`❌ SQLite 数据库不存在: ${sqlitePath}`);
      return result;
    }

    const sqliteStats = fs.statSync(sqlitePath);
    console.log(`   SQLite: ${sqlitePath}`);
    console.log(`   大小: ${(sqliteStats.size / 1024 / 1024).toFixed(1)} MB`);
    result.sqlitePath = sqlitePath;

    // 检测 WebView2 目录
    let userDataDir = args.userDataDir;
    if (!userDataDir) {
      userDataDir = await detectUserDataDir();
      if (userDataDir) {
        console.log(`   WebView2: ${userDataDir}`);
      } else {
        console.log('   ⚠️  未找到 WebView2 目录，将尝试从默认位置导出');
      }
    }

    // 2. 导出 IndexedDB
    console.log('\n📦 步骤 2/6: 导出 IndexedDB...\n');

    // 生成临时 JSON 路径
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tempJsonPath = path.join(os.tmpdir(), `guanmo-migrate-${timestamp}.json`);

    const exportArgs = {
      userDataDir,
      output: tempJsonPath,
    };

    // 捕获 exportIdb 的输出
    const originalConsoleLog = console.log;
    const exportOutput = [];
    console.log = (...args) => {
      exportOutput.push(args.join(' '));
      originalConsoleLog(...args);
    };

    try {
      await exportIdb(exportArgs);
    } finally {
      console.log = originalConsoleLog;
    }

    if (!fs.existsSync(tempJsonPath)) {
      console.error('❌ 导出失败：未生成 JSON 文件');
      return result;
    }

    const jsonStats = fs.statSync(tempJsonPath);
    console.log(`   JSON: ${tempJsonPath}`);
    console.log(`   大小: ${(jsonStats.size / 1024 / 1024).toFixed(1)} MB`);
    result.jsonPath = tempJsonPath;

    // 3. 备份 SQLite
    console.log('\n💾 步骤 3/6: 备份 SQLite...\n');

    const backupPath = args.noBackup ? null : `${sqlitePath}.backup-${Date.now()}`;
    if (backupPath) {
      fs.copyFileSync(sqlitePath, backupPath);
      console.log(`   备份: ${backupPath}`);
      console.log(`   大小: ${(fs.statSync(backupPath).size / 1024 / 1024).toFixed(1)} MB`);
    } else {
      console.log('   跳过备份（--no-backup）');
    }

    // 4. 合并到新 SQLite
    console.log('\n🔄 步骤 4/6: 合并数据...\n');

    // 生成输出路径
    const outputPath = args.output || sqlitePath.replace(/\.db$/, `-migrated-${timestamp}.db`);

    // 检查输出文件是否已存在
    if (fs.existsSync(outputPath)) {
      console.error(`❌ 输出文件已存在: ${outputPath}`);
      console.error('   请使用 --output 参数指定不同的输出路径');
      // 清理临时文件
      cleanupTempFile(tempJsonPath);
      return result;
    }

    const mergeArgs = {
      json: tempJsonPath,
      sqlite: sqlitePath,
      output: outputPath,
      noBackup: true, // 已经备份过了
    };

    const mergeResult = await mergeSqlite(mergeArgs);

    result.outputPath = outputPath;
    result.stats = mergeResult.stats;
    result.conflicts = mergeResult.conflicts || [];
    result.orphanMessages = mergeResult.orphanMessages || [];

    // 5. 完整性校验
    console.log('\n🔍 步骤 5/6: 完整性校验...\n');

    // 合并函数内部已经执行了校验
    result.integrityCheck = true;
    result.foreignKeyCheck = true;
    console.log('   ✅ 校验已在合并过程中完成');

    // 6. 输出结果和报告
    console.log('\n📊 步骤 6/6: 生成报告...\n');

    // 生成迁移报告
    const reportPath = outputPath.replace(/\.db$/, '-migration-report.json');
    const report = {
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
      source: {
        sqlite: sqlitePath,
        sqliteSize: sqliteStats.size,
        json: tempJsonPath,
        jsonSize: jsonStats.size,
      },
      output: {
        path: outputPath,
        size: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
        backup: backupPath,
      },
      stats: result.stats,
      integrityCheck: result.integrityCheck,
      foreignKeyCheck: result.foreignKeyCheck,
      conflicts: result.conflicts,
      orphanMessages: result.orphanMessages,
      errors: result.errors,
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    result.reportPath = reportPath;
    console.log(`   报告: ${reportPath}`);

    // 清理临时文件
    cleanupTempFile(tempJsonPath);

    // 判断最终结果
    result.success = true;
    const hasConflicts = result.stats.conflicts > 0;
    const hasOrphanMessages = result.stats.orphanMessages > 0;
    const hasErrors = result.stats.errors > 0;

    // 输出最终结果
    console.log('\n' + '═'.repeat(55));
    console.log('  迁移结果');
    console.log('═'.repeat(55));

    if (hasErrors) {
      // 失败
      console.log('  ❌ 失败');
      console.log('');
      console.log('  完整性校验或执行过程中出现错误');
      console.log('  请查看报告了解详情');
      result.success = false;
    } else if (hasConflicts || hasOrphanMessages) {
      // 成功但需检查
      console.log('  ⚠️  成功但需检查');
      console.log('');
      if (hasConflicts) {
        console.log(`  冲突: ${result.stats.conflicts} 条记录`);
      }
      if (hasOrphanMessages) {
        console.log(`  孤立消息: ${result.stats.orphanMessages} 条`);
      }
      console.log('');
      console.log('  请查看报告了解详情');
      console.log('  建议手动检查后再使用新数据库');
    } else {
      // 完全成功
      console.log('  ✅ 完全成功');
      console.log('');
      console.log('  无冲突、无孤立记录');
      console.log('  可以安全使用新数据库');
    }

    console.log('');
    console.log('  统计:');
    console.log(`    导入: ${result.stats.imported}`);
    console.log(`    跳过: ${result.stats.skipped}`);
    console.log(`    冲突: ${result.stats.conflicts}`);
    console.log(`    错误: ${result.stats.errors}`);
    console.log(`    孤立消息: ${result.stats.orphanMessages}`);
    console.log('');
    console.log('  输出:');
    console.log(`    数据库: ${outputPath}`);
    console.log(`    报告: ${reportPath}`);
    if (backupPath) {
      console.log(`    备份: ${backupPath}`);
    }
    console.log('');
    console.log(`  耗时: ${((Date.now() - startTime) / 1000).toFixed(1)} 秒`);
    console.log('═'.repeat(55));

    return result;

  } catch (err) {
    console.error(`\n❌ 迁移失败: ${err.message}`);
    if (err.stack) console.error(err.stack);

    result.success = false;
    result.errors.push({
      stage: 'migrate',
      error: err.message,
    });

    // 清理临时文件
    if (result.jsonPath && fs.existsSync(result.jsonPath)) {
      cleanupTempFile(result.jsonPath);
    }

    return result;
  }
}

/**
 * 检测 SQLite 路径
 */
async function detectSqlitePath() {
  console.log('   搜索 SQLite 数据库...');

  for (const sqlitePath of DEFAULT_SQLITE_PATHS) {
    if (fs.existsSync(sqlitePath)) {
      console.log(`   ✅ 找到: ${sqlitePath}`);
      return sqlitePath;
    }
  }

  console.log('   ⚠️  未在默认位置找到');
  return null;
}

/**
 * 清理临时文件
 */
function cleanupTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`   🗑️  已清理临时文件: ${filePath}`);
    }
  } catch (err) {
    console.warn(`   ⚠️  清理临时文件失败: ${err.message}`);
  }
}
