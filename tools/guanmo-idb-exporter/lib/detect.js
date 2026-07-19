/**
 * detect.js — 定位观墨 WebView2 User Data 目录
 *
 * WebView2 在 Tauri 中的数据路径：
 *   %LOCALAPPDATA%/<identifier>/EBWebView/
 *
 * 观墨 identifier: com.guanmo.app
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const IDENTIFIERS = [
  'com.guanmo.app',
  'com.guanmo.app-dev',
  'Guanmo',
  '观墨',
];

const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');

/**
 * 自动检测 WebView2 User Data 目录
 * @returns {Promise<string|null>} EBWebView 目录路径
 */
export async function detectUserDataDir() {
  console.log('🔍 正在搜索观墨 WebView2 User Data 目录...\n');

  for (const id of IDENTIFIERS) {
    const ebDir = path.join(LOCAL_APP_DATA, id, 'EBWebView');
    if (fs.existsSync(ebDir)) {
      console.log(`   找到: ${ebDir}`);
      const defaultDir = path.join(ebDir, 'Default');
      if (fs.existsSync(defaultDir)) {
        console.log(`   Profile: ${defaultDir}`);
        return ebDir;
      }
      console.log(`   ⚠️  未找到 Default profile 目录`);
    }
  }

  // 尝试模糊搜索
  console.log('   精确匹配未找到，尝试模糊搜索...');
  try {
    const candidates = fs.readdirSync(LOCAL_APP_DATA).filter(name => {
      const lower = name.toLowerCase();
      return lower.includes('guanmo') || lower.includes('guan-mo');
    });

    for (const candidate of candidates) {
      const ebDir = path.join(LOCAL_APP_DATA, candidate, 'EBWebView');
      if (fs.existsSync(ebDir)) {
        console.log(`   模糊匹配: ${ebDir}`);
        return ebDir;
      }
    }
  } catch {
    // 忽略读取错误
  }

  return null;
}

/**
 * 验证并返回 EBWebView 目录路径
 * @param {string} dirPath
 * @returns {string|null}
 */
export function validateUserDataDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    console.error(`❌ 目录不存在: ${dirPath}`);
    return null;
  }

  // 检查是否是 EBWebView 目录
  const defaultDir = path.join(dirPath, 'Default');
  const localState = path.join(dirPath, 'Local State');

  if (fs.existsSync(defaultDir) || fs.existsSync(localState)) {
    return dirPath;
  }

  // 可能用户传入了 EBWebView 的父目录
  const ebSubdir = path.join(dirPath, 'EBWebView');
  if (fs.existsSync(ebSubdir)) {
    return ebSubdir;
  }

  console.error(`❌ 未在 ${dirPath} 中找到 WebView2 Profile 数据`);
  return null;
}

/**
 * 检查观墨进程是否正在运行
 * @returns {boolean}
 */
export function isGuanmoRunning() {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq guanmo.exe" /NH', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    return output.includes('guanmo.exe');
  } catch {
    return false;
  }
}

/**
 * 检查 WebView2 profile 是否被锁定
 * @param {string} ebDir EBWebView 目录
 * @returns {boolean} 是否被锁定
 */
export function isProfileLocked(ebDir) {
  const lockfile = path.join(ebDir, 'lockfile');
  if (!fs.existsSync(lockfile)) return false;

  // lockfile 存在不一定代表被锁定（WebView2 有时会残留 lockfile）
  // 检查文件大小和修改时间
  try {
    const stat = fs.statSync(lockfile);
    // 如果 lockfile 超过 5 分钟未更新，可能是残留的
    const age = Date.now() - stat.mtimeMs;
    if (age > 5 * 60 * 1000) {
      console.log('   ⚠️  lockfile 存在但已超过 5 分钟，可能是残留文件');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
