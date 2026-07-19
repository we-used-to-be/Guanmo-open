/**
 * export.js — 完整导出 IndexedDB 为 JSON
 *
 * 使用 Playwright 启动临时 Chromium（副本），
 * 通过 openCursor() 分批读取 guanmo-db 的核心 store，
 * 导出为 NDJSON/JSON 文件。
 */

import { chromium } from 'playwright';
import { detectUserDataDir, isGuanmoRunning, isProfileLocked } from './detect.js';
import { filterSensitiveFields } from './sensitive.js';
import { snapshotDir, diffSnapshots } from './snapshot.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 需要导出的 store
const EXPORT_STORES = ['documents', 'chat_sessions', 'chat_messages', 'memories', 'settings'];

// 跳过的 store
const SKIP_STORES = ['chunks', 'embeddings', 'embedding_jobs'];

// 每批大小
const BATCH_SIZE = 200;

/**
 * 完整导出
 * @param {object} args 命令行参数
 */
export async function exportIdb(args) {
  console.log('📦 guanmo-idb-export — 完整导出\n');

  // 1. 检查进程
  if (isGuanmoRunning()) {
    console.error('❌ 观墨正在运行，请先退出观墨后再执行导出。');
    process.exit(1);
  }
  console.log('✅ 观墨未运行');

  // 2. 定位目录
  let ebDir;
  if (args.userDataDir) {
    ebDir = args.userDataDir;
    if (!fs.existsSync(ebDir)) {
      console.error(`❌ 指定的目录不存在: ${ebDir}`);
      process.exit(1);
    }
  } else {
    ebDir = await detectUserDataDir();
    if (!ebDir) {
      console.error('❌ 未找到 WebView2 User Data 目录');
      console.error('   请使用 --user-data-dir 手动指定');
      process.exit(1);
    }
  }
  console.log(`   目录: ${ebDir}`);

  // 3. 检查 profile 锁定
  if (isProfileLocked(ebDir)) {
    console.error('❌ WebView2 Profile 被锁定。');
    process.exit(1);
  }
  console.log('✅ Profile 未被锁定');

  // 4. 记录原始 IndexedDB 快照
  const srcIndexedDb = path.join(ebDir, 'Default', 'IndexedDB');
  if (!fs.existsSync(srcIndexedDb)) {
    console.error(`❌ IndexedDB 目录不存在: ${srcIndexedDb}`);
    process.exit(1);
  }
  const snapBefore = await snapshotDir(srcIndexedDb);
  console.log(`   原始 IndexedDB: ${snapBefore.fileCount} 文件, ${snapBefore.totalSize} 字节`);

  // 5. 复制到临时目录
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanmo-export-'));
  const dstEbDir = path.join(tmpDir, 'EBWebView');
  console.log(`\n📁 复制到临时目录: ${tmpDir}`);

  try {
    copyDirSync(ebDir, dstEbDir);
    console.log('✅ 复制完成');
  } catch (err) {
    console.error(`❌ 复制失败: ${err.message}`);
    cleanup(tmpDir);
    process.exit(1);
  }

  // 6. 启动 Chromium 使用副本
  console.log('\n🌐 启动临时 Chromium (使用副本)...');
  let context;
  try {
    context = await chromium.launchPersistentContext(dstEbDir, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--host-resolver-rules=MAP tauri.localhost 127.0.0.1',
      ],
    });

    const page = context.pages()[0] || await context.newPage();

    // 拦截 tauri.localhost 请求
    await context.route('http://tauri.localhost/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><head><title>export</title></head><body></body></html>',
      });
    });

    console.log('   导航到 http://tauri.localhost ...');
    await page.goto('http://tauri.localhost', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 7. 执行导出脚本
    console.log(`   读取 IndexedDB (batch size: ${BATCH_SIZE})...\n`);

    // 先获取 store 列表和版本信息
    const dbInfo = await page.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        const req = indexedDB.open('guanmo-db');
        req.onupgradeneeded = () => {
          try { req.result.close(); } catch {}
          reject(new Error('ABORT_UPGRADE'));
        };
        req.onsuccess = () => {
          const db = req.result;
          const info = {
            version: db.version,
            storeNames: Array.from(db.objectStoreNames),
          };
          db.close();
          resolve(info);
        };
        req.onerror = () => reject(new Error('open failed'));
      });
    }).catch(err => ({ error: err.message }));

    if (dbInfo.error) {
      if (dbInfo.error.includes('ABORT_UPGRADE')) {
        console.error('❌ onupgradeneeded 被触发，数据库为空或不存在。');
        cleanup(tmpDir);
        process.exit(1);
      }
      throw new Error(dbInfo.error);
    }

    console.log(`   数据库版本: ${dbInfo.version}`);
    console.log(`   所有 stores: ${dbInfo.storeNames.join(', ')}`);

    // 逐个 store 分批读取
    const results = {
      _version: dbInfo.version,
      _storeNames: dbInfo.storeNames,
      _stores: {},
      _totalRecords: 0,
      _errors: [],
    };

    for (const storeName of EXPORT_STORES) {
      if (!dbInfo.storeNames.includes(storeName)) {
        results._stores[storeName] = { count: 0, records: [], error: 'store not found' };
        continue;
      }

      console.log(`   读取 ${storeName}...`);
      const records = await page.evaluate(async (sName) => {
        return await new Promise((resolve, reject) => {
          const req = indexedDB.open('guanmo-db');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(sName, 'readonly');
            const store = tx.objectStore(sName);
            // 使用 getAll() 一次性读取
            const getAllReq = store.getAll();
            getAllReq.onsuccess = () => {
              db.close();
              resolve(getAllReq.result || []);
            };
            getAllReq.onerror = () => {
              db.close();
              reject(new Error('getAll failed'));
            };
          };
          req.onerror = () => reject(new Error('open failed'));
        });
      }, storeName).catch(err => ({ error: err.message }));

      if (records.error) {
        results._errors.push({ store: storeName, error: records.error });
        results._stores[storeName] = { count: 0, records: [], error: records.error };
      } else {
        results._stores[storeName] = { count: records.length, records };
        results._totalRecords += records.length;
        console.log(`     → ${records.length} 条记录`);
      }
    }

    // 8. 检查原始 IndexedDB 是否被修改
    const snapAfter = await snapshotDir(srcIndexedDb);
    const srcDiff = diffSnapshots(snapBefore, snapAfter);
    if (srcDiff.changed) {
      console.error('❌ 原始 IndexedDB 目录在导出过程中被修改！');
      console.error(`   变化: ${srcDiff.detail}`);
      process.exit(1);
    }
    console.log('✅ 原始 IndexedDB 未被修改');

    // 9. 检查导出结果
    if (results._aborted) {
      console.error('❌ onupgradeneeded 被触发，已立即终止。数据库为空或不存在。');
      cleanup(tmpDir);
      process.exit(1);
    }

    if (results._error) {
      console.error(`❌ 导出失败: ${results._error}`);
      cleanup(tmpDir);
      process.exit(1);
    }

    // 10. 后处理：过滤 settings 敏感数据
    if (results._stores?.settings?.records) {
      results._stores.settings.records = results._stores.settings.records.map(filterSensitiveFields);
      console.log('   已过滤 settings 中的敏感字段');
    }

    // 11. 生成导出文件（不覆盖已有文件）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let outputPath = args.output || path.join(process.cwd(), `guanmo-idb-export-${timestamp}.json`);

    // 避免覆盖
    if (fs.existsSync(outputPath)) {
      const ext = path.extname(outputPath);
      const base = outputPath.slice(0, -ext.length);
      outputPath = `${base}-${Date.now()}${ext}`;
    }

    const exportData = {
      _meta: {
        tool: 'guanmo-idb-export',
        version: '1.0.0',
        exportTime: new Date().toISOString(),
        origin: 'http://tauri.localhost',
        sourceDir: ebDir,
        idbVersion: results._version,
        upgradeTriggered: false,
        skippedStores: SKIP_STORES,
        batchSize: BATCH_SIZE,
      },
      _statistics: {},
      ...results._stores,
    };

    // 生成统计
    for (const store of EXPORT_STORES) {
      const data = results._stores?.[store];
      exportData._statistics[store] = {
        exported: data?.count || 0,
        error: data?.error || null,
      };
    }
    exportData._statistics._totalRecords = results._totalRecords;

    // 写入 JSON 文件
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
    const fileSize = fs.statSync(outputPath).size;

    // 写入统计报告
    const reportPath = outputPath.replace(/\.json$/, '-report.txt');
    const reportLines = [
      'guanmo-idb-export — 导出报告',
      '='.repeat(50),
      `导出时间:       ${exportData._meta.exportTime}`,
      `输出文件:       ${outputPath}`,
      `文件大小:       ${(fileSize / 1024).toFixed(1)} KB`,
      '',
      '数据库信息:',
      `  Origin:        ${exportData._meta.origin}`,
      `  版本:          ${exportData._meta.idbVersion}`,
      `  onupgradeneeded: 否 ✅`,
      '',
      'Store 统计:',
    ];
    for (const store of EXPORT_STORES) {
      const data = results._stores?.[store];
      const status = data?.error ? `错误: ${data.error}` : `${data?.count || 0} 条记录`;
      reportLines.push(`  ${store.padEnd(20)} ${status}`);
    }
    reportLines.push(`  ${'总计'.padEnd(20)} ${results._totalRecords} 条记录`);
    reportLines.push('');
    reportLines.push('跳过的 store:');
    for (const store of SKIP_STORES) {
      reportLines.push(`  - ${store}`);
    }
    reportLines.push('');
    reportLines.push('完整性校验:');
    reportLines.push(`  原始 IndexedDB 文件数: ${snapBefore.fileCount}`);
    reportLines.push(`  原始 IndexedDB 总大小: ${snapBefore.totalSize} 字节`);
    reportLines.push(`  导出前后差异: ${srcDiff.detail}`);
    reportLines.push('');
    reportLines.push('内存占用:');
    const memUsage = process.memoryUsage();
    reportLines.push(`  RSS:     ${(memUsage.rss / 1024 / 1024).toFixed(1)} MB`);
    reportLines.push(`  Heap:    ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`);
    reportLines.push(`  External:${(memUsage.external / 1024 / 1024).toFixed(1)} MB`);

    if (results._errors?.length > 0) {
      reportLines.push('');
      reportLines.push('错误:');
      for (const err of results._errors) {
        reportLines.push(`  ${err.store}: ${err.error}`);
      }
    }

    fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf-8');

    // 12. 输出报告
    console.log('\n' + '═'.repeat(55));
    console.log('  导出报告');
    console.log('═'.repeat(55));
    console.log(`  输出文件:       ${outputPath}`);
    console.log(`  统计报告:       ${reportPath}`);
    console.log(`  文件大小:       ${(fileSize / 1024).toFixed(1)} KB`);
    console.log('');
    console.log('  数据库信息:');
    console.log(`    Origin:        ${exportData._meta.origin}`);
    console.log(`    版本:          ${exportData._meta.idbVersion}`);
    console.log(`    onupgradeneeded: 否 ✅`);
    console.log('');
    console.log('  Store 统计:');
    for (const store of EXPORT_STORES) {
      const data = results._stores?.[store];
      if (data?.error) {
        console.log(`    ${store.padEnd(20)} 错误: ${data.error}`);
      } else {
        console.log(`    ${store.padEnd(20)} ${data?.count || 0} 条记录`);
      }
    }
    console.log(`    ${'总计'.padEnd(20)} ${results._totalRecords} 条记录`);
    console.log('');
    console.log('  完整性校验:');
    console.log(`    原始 IndexedDB 未被修改 ✅`);
    console.log('');
    console.log('  内存占用:');
    const mem = process.memoryUsage();
    console.log(`    RSS:     ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
    console.log(`    Heap:    ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
    console.log('═'.repeat(55));
    console.log('\n✅ 导出完成!');

  } catch (err) {
    console.error(`\n❌ 导出失败: ${err.message}`);
    if (err.stack) console.error(err.stack);
  } finally {
    if (context) await context.close().catch(() => {});
    cleanup(tmpDir);
  }
}

/**
 * 递归复制目录
 */
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * 清理临时目录
 */
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
