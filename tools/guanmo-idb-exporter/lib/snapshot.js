/**
 * snapshot.js — 目录快照与完整性校验
 *
 * 记录目录的文件大小、修改时间和 SHA-256，
 * 用于验证导出前后源数据未被修改。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 递归计算目录的快照
 * @param {string} dir 目录路径
 * @returns {{ fileCount: number, totalSize: number, files: Record<string, { size: number, mtime: number, sha256: string }> }}
 */
export async function snapshotDir(dir) {
  const snapshot = { fileCount: 0, totalSize: 0, files: {} };

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(dir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath);
        const sha256 = crypto.createHash('sha256').update(content).digest('hex');

        snapshot.files[relativePath] = {
          size: stat.size,
          mtime: stat.mtimeMs,
          sha256,
        };
        snapshot.fileCount++;
        snapshot.totalSize += stat.size;
      }
    }
  }

  walk(dir);
  return snapshot;
}

/**
 * 比较两个快照
 * @param {{ fileCount: number, totalSize: number, files: Record<string, { size: number, mtime: number, sha256: string }> }} before
 * @param {{ fileCount: number, totalSize: number, files: Record<string, { size: number, mtime: number, sha256: string }> }} after
 * @returns {{ changed: boolean, detail: string }}
 */
export function diffSnapshots(before, after) {
  const issues = [];

  // 检查文件数量
  if (before.fileCount !== after.fileCount) {
    issues.push(`文件数量变化: ${before.fileCount} → ${after.fileCount}`);
  }

  // 检查总大小
  if (before.totalSize !== after.totalSize) {
    issues.push(`总大小变化: ${before.totalSize} → ${after.totalSize} 字节`);
  }

  // 检查每个文件
  for (const [file, beforeInfo] of Object.entries(before.files)) {
    const afterInfo = after.files[file];
    if (!afterInfo) {
      issues.push(`文件被删除: ${file}`);
      continue;
    }
    if (beforeInfo.sha256 !== afterInfo.sha256) {
      issues.push(`文件内容变化: ${file}`);
    }
  }

  // 检查新增文件
  for (const file of Object.keys(after.files)) {
    if (!before.files[file]) {
      issues.push(`新增文件: ${file}`);
    }
  }

  return {
    changed: issues.length > 0,
    detail: issues.join('; ') || '无变化',
  };
}
