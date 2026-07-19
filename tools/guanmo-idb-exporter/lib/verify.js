/**
 * verify.js — 最小验证：读取 IndexedDB store 数量
 *
 * 使用 Playwright 启动临时 Chromium（副本），读取 guanmo-db 的核心 store 统计，
 * 确认未触发升级或写入。
 */

import { chromium } from 'playwright';
import { detectUserDataDir, isGuanmoRunning, isProfileLocked } from './detect.js';
import { snapshotDir, diffSnapshots } from './snapshot.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 需要读取的 store（跳过 chunks/embeddings/embedding_jobs）
const TARGET_STORES = ['documents', 'chat_sessions', 'chat_messages', 'memories', 'settings'];

/**
 * IndexedDB 注入脚本：不传版本号打开数据库，如果触发 onupgradeneeded 则立即终止
 */
function createVerifyScript() {
  return `
    (async () => {
      const targetStores = ${JSON.stringify(TARGET_STORES)};
      const result = { _upgradeTriggered: false, _aborted: false };

      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('guanmo-db');

          req.onupgradeneeded = () => {
            result._upgradeTriggered = true;
            // 立即关闭数据库，禁止创建或升级
            try { req.result.close(); } catch {}
            reject(new Error('ABORT_UPGRADE: onupgradeneeded triggered'));
          };

          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(new Error('IndexedDB open failed'));
        });

        // 数据库打开成功，记录信息
        result._version = db.version;
        result._storeNames = Array.from(db.objectStoreNames);

        // 统计每个 store 的数量
        for (const storeName of targetStores) {
          try {
            if (!db.objectStoreNames.contains(storeName)) {
              result[storeName] = -2; // store 不存在
              continue;
            }
            const count = await new Promise((resolve, reject) => {
              const tx = db.transaction(storeName, 'readonly');
              const req = tx.objectStore(storeName).count();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(new Error('count failed'));
            });
            result[storeName] = count;
          } catch (err) {
            result[storeName] = -1;
          }
        }

        db.close();
      } catch (err) {
        if (err.message.includes('ABORT_UPGRADE')) {
          result._aborted = true;
        } else {
          result._error = err.message;
        }
      }

      return result;
    })()
  `;
}

/**
 * 最小验证
 * @param {object} args 命令行参数
 */
export async function verifyIdb(args) {
  console.log('📋 guanmo-idb-export — 最小验证\n');

  // 1. 检查进程
  if (isGuanmoRunning()) {
    console.error('❌ 观墨正在运行，请先退出观墨后再执行验证。');
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanmo-verify-'));
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
        body: '<!DOCTYPE html><html><head><title>verify</title></head><body></body></html>',
      });
    });

    console.log('   导航到 http://tauri.localhost ...');
    await page.goto('http://tauri.localhost', { waitUntil: 'domcontentloaded', timeout: 15000 });

    // 7. 执行验证脚本
    console.log('   读取 IndexedDB stores...\n');
    const results = await page.evaluate(createVerifyScript());

    // 8. 检查原始 IndexedDB 是否被修改
    const snapAfter = await snapshotDir(srcIndexedDb);
    const srcDiff = diffSnapshots(snapBefore, snapAfter);
    if (srcDiff.changed) {
      console.error('❌ 原始 IndexedDB 目录在验证过程中被修改！');
      console.error(`   变化: ${srcDiff.detail}`);
      process.exit(1);
    }
    console.log('✅ 原始 IndexedDB 未被修改');

    // 9. 输出结果
    console.log('═'.repeat(50));
    console.log('  验证结果');
    console.log('═'.repeat(50));

    if (results._aborted) {
      console.log('  ⚠️  onupgradeneeded 被触发，已立即终止');
      console.log('  这表明原始 IndexedDB 中没有 guanmo-db 数据');
    } else if (results._error) {
      console.log(`  ❌ 错误: ${results._error}`);
    } else {
      console.log(`  数据库版本:     ${results._version}`);
      console.log(`  所有 stores:    ${results._storeNames?.join(', ') || '(无)'}`);
      console.log(`  onupgradeneeded: 否 ✅`);
      console.log('');
      console.log('  核心 Store 统计:');
      for (const store of TARGET_STORES) {
        const count = results[store];
        if (count === -2) {
          console.log(`    ${store.padEnd(20)} 不存在`);
        } else if (count === -1) {
          console.log(`    ${store.padEnd(20)} 读取失败 ⚠️`);
        } else {
          console.log(`    ${store.padEnd(20)} ${count} 条记录`);
        }
      }
    }
    console.log('═'.repeat(50));

    const hasData = TARGET_STORES.some(s => results[s] > 0);
    if (hasData && !results._aborted) {
      console.log('\n✅ 验证成功: 检测到有效数据，可以执行 export 命令。');
    } else if (results._aborted) {
      console.log('\n⚠️  数据库为空或不存在，无法导出。');
    } else {
      console.log('\n⚠️  未检测到数据。');
    }

  } catch (err) {
    console.error(`\n❌ 验证失败: ${err.message}`);
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
