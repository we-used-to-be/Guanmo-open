#!/usr/bin/env node

/**
 * guanmo-idb-export — 观墨旧版 IndexedDB 导出工具
 *
 * 通过临时 Chromium（兼容 WebView2）读取 guanmo-db IndexedDB，
 * 全程只读，导出为 JSON。
 *
 * 用法：
 *   node index.js detect                       自动定位 WebView2 User Data 目录
 *   node index.js detect --user-data-dir "..." 手动指定目录
 *   node index.js export                       自动定位并导出
 *   node index.js export --user-data-dir "..." 手动指定目录
 *   node index.js export --output "..."        指定输出路径
 *   node index.js verify                       最小验证：读取 store 数量
 */

import { detectUserDataDir, validateUserDataDir } from './lib/detect.js';
import { exportIdb } from './lib/export.js';
import { verifyIdb } from './lib/verify.js';
import { mergeSqlite } from './lib/merge-sqlite.js';
import { migrate } from './lib/migrate.js';

function printUsage() {
  console.log(`
guanmo-idb-export — 观墨数据迁移工具

用法：
  node index.js migrate [options]              一键迁移（推荐）
  node index.js detect [options]               自动定位 WebView2 User Data 目录
  node index.js verify [options]               最小验证：读取 store 数量
  node index.js export [options]               完整导出为 JSON
  node index.js merge-sqlite [options]         合并 JSON 到 SQLite

选项（migrate）：
  --sqlite <path>          指定 SQLite 数据库路径（默认: 自动检测）
  --user-data-dir <path>   指定 WebView2 User Data 目录（默认: 自动检测）
  --output <path>          输出文件路径（默认: <sqlite>-migrated-<timestamp>.db）

选项（detect/verify/export）：
  --user-data-dir <path>   手动指定 WebView2 User Data 目录
  --output <path>          指定导出文件路径（默认: ./guanmo-idb-export-<timestamp>.json）
  --batch-size <n>         分批读取大小（默认: 500）

选项（merge-sqlite）：
  --json <path>            导出的 JSON 文件路径（必填）
  --sqlite <path>          当前 SQLite 数据库路径（必填）
  --output <path>          输出文件路径（默认: <sqlite>-merged-<timestamp>.db）
  --no-backup              不备份原始 SQLite（仅限高级用法）

通用选项：
  --help                   显示帮助信息

示例：
  node index.js migrate
  node index.js migrate --output ./my-migrated.db
  node index.js detect
  node index.js export --output ./my-export.json
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--user-data-dir' && argv[i + 1]) {
      args.userDataDir = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      args.output = argv[++i];
    } else if (arg === '--batch-size' && argv[i + 1]) {
      args.batchSize = parseInt(argv[++i], 10);
    } else if (arg === '--json' && argv[i + 1]) {
      args.json = argv[++i];
    } else if (arg === '--sqlite' && argv[i + 1]) {
      args.sqlite = argv[++i];
    } else if (arg === '--no-backup') {
      args.noBackup = true;
    } else {
      args.command = arg;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.command) {
    printUsage();
    process.exit(0);
  }

  try {
    switch (args.command) {
      case 'detect': {
        const dir = args.userDataDir
          ? validateUserDataDir(args.userDataDir)
          : await detectUserDataDir();
        if (dir) {
          console.log(`\n✅ WebView2 User Data 目录:\n   ${dir}`);
        } else {
          console.log('\n❌ 未找到 WebView2 User Data 目录');
          process.exit(1);
        }
        break;
      }

      case 'verify': {
        await verifyIdb(args);
        break;
      }

      case 'export': {
        await exportIdb(args);
        break;
      }

      case 'merge-sqlite': {
        await mergeSqlite(args);
        break;
      }

      case 'migrate': {
        await migrate(args);
        break;
      }

      default:
        console.error(`未知命令: ${args.command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ 错误: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
