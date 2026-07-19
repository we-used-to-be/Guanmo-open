#!/usr/bin/env node

/**
 * 观墨开源版 — 推送前安全校验脚本 (pre-push-check)
 *
 * 使用方式：
 *   node scripts/pre-push-check.mjs              # 默认（当前分支 vs origin/master）
 *   node scripts/pre-push-check.mjs --release    # 发布模式（额外检查版本/tag/描述一致性）
 *
 * 返回码：
 *   0 — 无阻断项（可能有警告）
 *   1 — 存在阻断项（禁止推送）
 *
 * 说明：
 *   - 阻断项 (BLOCK)：必须修复后才能推送
 *   - 警告项 (WARN) ：建议修复，不阻止推送
 *   - 通过项 (PASS) ：检查通过
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import { createHash } from 'crypto';

// ---- 配置 ----

const ROOT = resolve(import.meta.dirname, '..');

/** 高风险文件模式 — 存在且被 tracked 即为阻断 */
const HIGH_RISK_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  'secrets.json',
  'credentials.json',
  'service-account.json',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_ed25519',
];

/** 敏感内容扫描跳过列表 — 已知安全的文件（含存储键名、示例值等） */
const SENSITIVE_SCAN_SKIP = [
  'src/services/secureStorage.ts',   // 仅包含存储键名常量，非真实密钥
];

/** 当匹配行的值部分包含以下模式时，跳过（非真实密钥，仅为键名/路径/标识符） */
const SENSITIVE_VALUE_SAFE_PATTERNS = [
  /^[a-z]+\.[a-zA-Z.]+$/,           // 点分隔标识符如 ai.apiKey
];

/** 高风险内容模式（正则）— 在 tracked 文件中匹配 */
const SENSITIVE_PATTERNS = [
  // API Keys & Tokens
  { pattern: /sk-[A-Za-z0-9]{20,}/g, name: 'OpenAI API Key' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, name: 'Anthropic API Key' },
  { pattern: /AIza[0-9A-Za-z_-]{35}/g, name: 'Google API Key' },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, name: 'GitHub Personal Access Token' },
  { pattern: /ghp_[A-Za-z0-9]{36,}/g, name: 'GitHub Classic Token' },
  { pattern: /gho_[A-Za-z0-9]{36,}/g, name: 'GitHub OAuth Token' },
  { pattern: /ghu_[A-Za-z0-9]{36,}/g, name: 'GitHub User Token' },
  { pattern: /ghs_[A-Za-z0-9]{36,}/g, name: 'GitHub Server Token' },
  { pattern: /ghr_[A-Za-z0-9]{36,}/g, name: 'GitHub Refresh Token' },
  { pattern: /tavily_[A-Za-z0-9]{20,}/g, name: 'Tavily API Key' },
  { pattern: /tauri\s+signing\s+private\s+key/i, name: 'Tauri Signing Key Reference' },
  { pattern: /TAURI_PRIVATE_KEY\s*=\s*['"]?[A-Za-z0-9+/=]{30,}['"]?/g, name: 'Tauri Private Key' },
  { pattern: /TAURI_KEY_PASSWORD\s*=\s*['"][^'"]+['"]/g, name: 'Tauri Key Password' },

  // Passwords & Secrets
  { pattern: /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{6,}['"]/gi, name: 'Hardcoded Password/Secret/Token' },

  // Private Keys in file content
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g, name: 'Private Key Block' },

  // Internal / local IPs
  { pattern: /(?:http:\/\/)?(?:192\.168\.|10\.\d{1,3}\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}/g, name: 'Internal/Private IP Address' },

  // Local absolute paths
  { pattern: /[A-Za-z]:\\Users\\[^\\]+\\/g, name: 'Windows User Path (Absolute)' },
  { pattern: /\/home\/[^/]+\//g, name: 'Linux/Mac User Path (Absolute)' },
];

/** 不应被 tracked 的文件/目录模式 */
const SHOULD_NOT_TRACK = [
  '*.log',
  '*.tmp',
  '*.db',
  '*.sqlite',
  '*.sqlite3',
  'history/',
  'tmp/',
  'dist-portable/',
  '.playwright-cli/',
  'codex-worktrees/',
  'output/',
  'node_modules/',
  'src-tauri/target/',
];

/** 超大文件阈值 (bytes) */
const LARGE_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/** 构建产物模式 */
const BUILD_ARTIFACT_PATTERNS = [
  /\.exe$/i,
  /\.msi$/i,
  /\.dmg$/i,
  /\.AppImage$/i,
  /\.deb$/i,
  /\.rpm$/i,
  /\.bin$/i,
  /\.wasm$/i,
];

// ---- 工具函数 ----

const colors = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m', bold: '\x1b[1m' };

function label(l, c) { return `${colors[c]}[${l}]${colors.reset}`; }
const PASS = label('通过', 'green');
const WARN = label('警告', 'yellow');
const BLOCK = label('阻断', 'red');

const results = { pass: [], warn: [], block: [], commits: [], files: [] };

function add(r, level, msg) { results[r].push({ level, msg }); }
function pass(msg) { add('pass', PASS, msg); }
function warn(msg) { add('warn', WARN, msg); }
function block(msg) { add('block', BLOCK, msg); }

function cmd(c, opts = {}) {
  try {
    return execSync(c, { cwd: ROOT, encoding: 'utf-8', ...opts }).trim();
  } catch (e) {
    return `[ERROR: ${e.message.split('\n')[0]}]`;
  }
}

function git(args) { return cmd(`git ${args}`); }
function gitLines(args) { return git(args).split('\n').filter(Boolean); }

function isTracked(f) {
  try {
    execSync(`git ls-files --error-unmatch "${f}"`, { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function getTrackedFiles() {
  return gitLines('ls-files');
}

// ---- 检查函数 ----

// 1. Git 状态 & 分支
function checkGitStatus() {
  console.log('\n' + colors.bold + '=== 1. Git 状态 & 分支 ===' + colors.reset);

  const branch = git('branch --show-current');
  console.log(`   当前分支: ${branch}`);

  // 检查是否在 main/master 上直接推送
  if (branch === 'master' || branch === 'main') {
    warn(`当前在 ${branch} 分支上，直接推送到主分支有风险`);
  } else {
    pass(`当前在分支 "${branch}"`);
  }

  // 未暂存的变更
  const unstaged = gitLines('diff --name-only');
  if (unstaged.length > 0) {
    warn(`存在 ${unstaged.length} 个未暂存的文件变更:\n     ${unstaged.join('\n     ')}`);
  } else {
    pass('工作区干净，无未暂存变更');
  }

  // 未跟踪的文件
  const untracked = gitLines('ls-files --others --exclude-standard');
  const nonIgnored = untracked.filter(f => !f.startsWith('node_modules/'));
  if (nonIgnored.length > 0) {
    warn(`存在 ${nonIgnored.length} 个未跟踪文件:\n     ${nonIgnored.join('\n     ')}`);
  } else {
    pass('无未跟踪文件');
  }

  return { branch, unstaged, untracked: nonIgnored };
}

// 2. 待推送提交检查
function checkPendingCommits(branch) {
  console.log('\n' + colors.bold + '=== 2. 待推送提交 ===' + colors.reset);

  let remote = 'origin/master';
  try {
    execSync(`git rev-parse --verify ${remote}`, { cwd: ROOT, stdio: 'ignore' });
  } catch {
    remote = 'origin/main';
    try {
      execSync(`git rev-parse --verify ${remote}`, { cwd: ROOT, stdio: 'ignore' });
    } catch {
      warn(`无法找到 origin/master 或 origin/main，将检查所有本地提交`);
      remote = null;
    }
  }

  let pending;
  if (remote) {
    pending = gitLines(`log ${remote}..HEAD --oneline`);
  } else {
    pending = gitLines('log --oneline -10');
  }

  if (pending.length === 0) {
    pass('无待推送提交');
  } else {
    console.log(`   ${pending.length} 个待推送提交:`);
    pending.forEach(c => console.log(`     ${c}`));

    // 检查最近一次提交的时间
    const lastCommitDate = git('log -1 --format=%ci');
    console.log(`   最近提交时间: ${lastCommitDate}`);

    // 检查提交作者
    try {
      const author = cmd('git log -1 --format="%an"');
      console.log(`   作者: ${author}`);
    } catch { /* 非关键信息 */ }

    results.commits = pending;
  }

  return pending;
}

// 3. 敏感文件检查
function checkSensitiveFiles() {
  console.log('\n' + colors.bold + '=== 3. 敏感文件检查 ===' + colors.reset);

  const tracked = getTrackedFiles();
  let found = false;

  for (const pattern of HIGH_RISK_FILES) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\./g, '\\.') + '$');
      for (const f of tracked) {
        if (regex.test(f)) {
          block(`高风险文件被 tracked: ${f}`);
          found = true;
        }
      }
    } else {
      if (existsSync(join(ROOT, pattern)) && isTracked(pattern)) {
        block(`高风险文件被 tracked: ${pattern}`);
        found = true;
      }
    }
  }

  if (!found) pass('未发现高风险文件被 tracked');
}

// 4. 敏感内容扫描
function checkSensitiveContent() {
  console.log('\n' + colors.bold + '=== 4. 敏感内容扫描 ===' + colors.reset);

  const tracked = getTrackedFiles().filter(f => {
    if (!existsSync(join(ROOT, f))) return false;
    try {
      const s = statSync(join(ROOT, f));
      return s.isFile() && s.size < 5 * 1024 * 1024; // skip files > 5MB
    } catch { return false; }
  });

  let issues = 0;
  const extensionsToSkip = new Set(['.exe', '.dll', '.bin', '.wasm', '.png', '.jpg', '.jpeg',
    '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.ogg', '.webm',
    '.zip', '.tar', '.gz', '.7z', '.lock', '.sum']);

  for (const f of tracked) {
    const ext = f.substring(f.lastIndexOf('.')).toLowerCase();
    if (extensionsToSkip.has(ext)) continue;

    // 跳过已知安全的文件（包含存储键名、示例值等）
    if (SENSITIVE_SCAN_SKIP.includes(f)) {
      console.log(`   [跳过] 已知安全文件: ${f}`);
      continue;
    }

    try {
      const content = readFileSync(join(ROOT, f), 'utf-8');
      for (const { pattern, name } of SENSITIVE_PATTERNS) {
        const matches = content.match(pattern);
        if (matches && matches.length > 0) {
          // 跳过已知的示例/测试文件
          if (f.includes('.example') || f.includes('.test.') || f.includes('.spec.') ||
              f.includes('__tests__') || f.includes('node_modules') || f.includes('fixtures') ||
              f.includes('-check.ts') || f.includes('-check.mjs') || f.includes('run-') ||
              (f.includes('src-tauri/src/') && f.includes('test')) ||
              (f.endsWith('.rs') && content.includes('#[cfg(test)]'))) {
            continue;
          }
          // 过滤掉值为已知安全标识符的匹配（如存储键名 'ai.apiKey'）
          const realMatches = matches.filter(m => {
            // 提取引号内的值部分
            const valueMatch = m.match(/['"]([^'"]+)['"]/);
            if (valueMatch) {
              const val = valueMatch[1];
              // 如果值看起来是键名/标识符而非真实密钥，跳过
              if (SENSITIVE_VALUE_SAFE_PATTERNS.some(safePat => safePat.test(val))) {
                return false;
              }
            }
            return true;
          });
          if (realMatches.length === 0) continue;

          block(`在 ${f} 中发现疑似 ${name} (${realMatches.length} 处匹配)`);
          issues++;
        }
      }
    } catch { /* skip unreadable files */ }
  }

  if (issues === 0) pass('未在 tracked 文件中发现敏感内容');
}

// 5. 不应公开的文件检查
function checkUnwantedTrackedFiles() {
  console.log('\n' + colors.bold + '=== 5. 不应公开的文件检查 ===' + colors.reset);

  const tracked = getTrackedFiles();
  let issues = 0;

  for (const pattern of SHOULD_NOT_TRACK) {
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      for (const f of tracked) {
        if (f === dir || f.startsWith(dir + '/')) {
          block(`不应被 tracked 的目录/文件: ${f}`);
          issues++;
        }
      }
    } else if (pattern.includes('*')) {
      const regex = new RegExp(pattern.replace(/\*/g, '[^/]*').replace(/\./g, '\\.'));
      for (const f of tracked) {
        if (regex.test(f)) {
          block(`不应被 tracked 的文件: ${f}`);
          issues++;
        }
      }
    } else {
      if (tracked.includes(pattern)) {
        block(`不应被 tracked 的文件: ${pattern}`);
        issues++;
      }
    }
  }

  if (issues === 0) pass('未发现不应被 tracked 的文件');

  // 额外检查：大文件
  console.log(`   检查大文件 (>${LARGE_FILE_SIZE / 1024 / 1024}MB)...`);
  let largeFiles = 0;
  for (const f of tracked) {
    try {
      const path = join(ROOT, f);
      if (existsSync(path)) {
        const s = statSync(path);
        if (s.isFile() && s.size > LARGE_FILE_SIZE) {
          warn(`大文件被 tracked: ${f} (${(s.size / 1024 / 1024).toFixed(1)}MB)`);
          largeFiles++;
        }
      }
    } catch { /* skip */ }
  }
  if (largeFiles === 0) pass('未发现超大文件');

  // 构建产物检查
  for (const f of tracked) {
    for (const pattern of BUILD_ARTIFACT_PATTERNS) {
      if (pattern.test(f)) {
        warn(`构建产物被 tracked: ${f}`);
        issues++;
      }
    }
  }
}

// 6. 新增依赖与许可证检查
function checkDependencies() {
  console.log('\n' + colors.bold + '=== 6. 依赖与许可证检查 ===' + colors.reset);

  // 检查是否有 package.json 的修改
  const diffFiles = gitLines('diff --name-only HEAD');
  const pkgChanged = diffFiles.includes('package.json');
  const cargoChanged = diffFiles.includes('src-tauri/Cargo.toml');

  if (!pkgChanged && !cargoChanged) {
    pass('package.json 和 Cargo.toml 未变更，跳过依赖检查');
    return;
  }

  // 基本检查 package.json
  if (existsSync(join(ROOT, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
      if (pkg.license) {
        pass(`package.json license: ${pkg.license}`);
      } else {
        warn('package.json 缺少 license 字段');
      }
      if (pkg.private === true) {
        warn('package.json 中 "private": true — 如要发布需修改');
      }
    } catch (e) {
      block(`package.json 解析失败: ${e.message}`);
    }
  }

  if (existsSync(join(ROOT, 'src-tauri', 'Cargo.toml'))) {
    try {
      const cargo = readFileSync(join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf-8');
      if (!cargo.includes('license')) {
        warn('Cargo.toml 缺少 license 字段');
      }
    } catch (e) {
      block(`Cargo.toml 读取失败: ${e.message}`);
    }
  }
}

// 7. 构建 & 代码质量检查
function checkBuildAndQuality() {
  console.log('\n' + colors.bold + '=== 7. 构建 & 代码质量检查 ===' + colors.reset);

  // TypeScript 类型检查
  console.log('   运行 TypeScript 类型检查...');
  try {
    // Use tsc with --noEmit for type checking only
    execSync('npx tsc --noEmit 2>&1', { cwd: ROOT, encoding: 'utf-8', timeout: 120000 });
    pass('TypeScript 类型检查通过');
  } catch (e) {
    const output = e.stdout || e.stderr || e.message;
    const errorLines = output.split('\n').filter(l => l.includes('error TS'));
    if (errorLines.length > 0) {
      block(`TypeScript 类型检查失败 (${errorLines.length} 个错误):\n     ${errorLines.slice(0, 5).join('\n     ')}`);
      if (errorLines.length > 5) console.log(`     ... 以及另外 ${errorLines.length - 5} 个错误`);
    } else {
      warn(`TypeScript 类型检查可能失败:\n     ${output.split('\n').slice(0, 3).join('\n     ')}`);
    }
  }

  // Vite build
  console.log('   运行 Vite 构建...');
  try {
    execSync('npx vite build 2>&1', { cwd: ROOT, encoding: 'utf-8', timeout: 120000 });
    pass('Vite 构建通过');
  } catch (e) {
    const output = e.stdout || e.stderr || e.message;
    if (output.toLowerCase().includes('error')) {
      block(`Vite 构建失败:\n     ${output.split('\n').slice(0, 5).join('\n     ')}`);
    } else {
      warn(`Vite 构建可能有问题:\n     ${output.split('\n').slice(0, 3).join('\n     ')}`);
    }
  }

  // Cargo check
  console.log('   运行 Cargo check...');
  try {
    execSync('cargo check 2>&1', { cwd: join(ROOT, 'src-tauri'), encoding: 'utf-8', timeout: 300000 });
    pass('Cargo check 通过');
  } catch (e) {
    const output = e.stdout || e.stderr || e.message;
    const errorLines = output.split('\n').filter(l => l.includes('error') && !l.includes('warning'));
    if (errorLines.length > 0) {
      block(`Cargo check 失败 (${errorLines.length} 个错误):\n     ${errorLines.slice(0, 5).join('\n     ')}`);
    } else {
      warn(`Cargo check 可能有问题:\n     ${output.split('\n').slice(0, 3).join('\n     ')}`);
    }
  }
}

// 8. 版本 & Tag 一致性检查（仅 --release 模式）
function checkVersionConsistency() {
  console.log('\n' + colors.bold + '=== 8. 版本 & Tag 一致性 ===' + colors.reset);

  let pkgVersion, cargoVersion;

  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    pkgVersion = pkg.version;
  } catch { block('无法读取 package.json 版本号'); return; }

  try {
    const cargoRaw = readFileSync(join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf-8');
    const m = cargoRaw.match(/^version\s*=\s*"([^"]+)"/m);
    cargoVersion = m ? m[1] : null;
  } catch { block('无法读取 Cargo.toml 版本号'); return; }

  console.log(`   package.json 版本: ${pkgVersion}`);
  console.log(`   Cargo.toml 版本 : ${cargoVersion}`);

  if (pkgVersion === cargoVersion) {
    pass(`版本号一致: ${pkgVersion}`);
  } else {
    block(`版本号不一致! package.json=${pkgVersion}, Cargo.toml=${cargoVersion}`);
  }

  // 检查是否已有该版本的 tag
  const existingTags = gitLines('tag -l');
  const expectedTag = `v${pkgVersion}`;
  if (existingTags.includes(expectedTag)) {
    warn(`Tag ${expectedTag} 已存在，推送可能导致冲突`);
  } else {
    pass(`Tag ${expectedTag} 可用（尚未创建）`);
  }

  // 检查是否有 CHANGELOG
  const changelogPaths = ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md', 'RELEASE_NOTES.md'];
  const changelog = changelogPaths.find(p => existsSync(join(ROOT, p)));
  if (changelog) {
    pass(`发现变更日志: ${changelog}`);
  } else {
    warn('未发现 CHANGELOG.md，建议添加发布说明');
  }

  return { pkgVersion, cargoVersion, expectedTag };
}

// ---- 主流程 ----

async function main() {
  console.log(colors.bold + colors.cyan + '\n╔══════════════════════════════════════╗' + colors.reset);
  console.log(colors.bold + colors.cyan + '║  观墨开源版 — 推送前安全校验         ║' + colors.reset);
  console.log(colors.bold + colors.cyan + '╚══════════════════════════════════════╝' + colors.reset);

  const isRelease = process.argv.includes('--release');

  // 1. Git 状态
  const { branch, unstaged, untracked } = checkGitStatus();

  // 2. 待推送提交
  const pending = checkPendingCommits(branch);

  // 3. 敏感文件
  checkSensitiveFiles();

  // 4. 敏感内容
  checkSensitiveContent();

  // 5. 不应公开的文件
  checkUnwantedTrackedFiles();

  // 6. 依赖检查
  checkDependencies();

  // 7. 构建 & 代码质量
  checkBuildAndQuality();

  // 8. 版本一致性（仅发布模式）
  if (isRelease) {
    checkVersionConsistency();
  }

  // ---- 输出结果 ----
  console.log('\n' + colors.bold + '═══════════════════════════════════════' + colors.reset);
  console.log(colors.bold + '           校验结果汇总' + colors.reset);
  console.log(colors.bold + '═══════════════════════════════════════' + colors.reset);

  console.log(`\n  ${colors.green}通过项: ${results.pass.length}${colors.reset}`);
  console.log(`  ${colors.yellow}警告项: ${results.warn.length}${colors.reset}`);
  console.log(`  ${colors.red}阻断项: ${results.block.length}${colors.reset}`);

  if (results.warn.length > 0) {
    console.log(`\n${colors.yellow}[警告详情]${colors.reset}`);
    results.warn.forEach(w => console.log(`  ${w.level} ${w.msg}`));
  }

  if (results.block.length > 0) {
    console.log(`\n${colors.red}[阻断详情]${colors.reset}`);
    results.block.forEach(b => console.log(`  ${b.level} ${b.msg}`));
  }

  // 待推送摘要
  if (pending.length > 0) {
    console.log(`\n${colors.cyan}[待推送提交摘要]${colors.reset}`);
    pending.forEach(c => console.log(`  ${c}`));

    // 变更文件摘要
    const changedFiles = remote => remote
      ? gitLines(`diff ${remote}..HEAD --name-only`)
      : gitLines('diff --name-only HEAD~5..HEAD');

    let remote = 'origin/master';
    try { execSync(`git rev-parse --verify ${remote}`, { cwd: ROOT, stdio: 'ignore' }); }
    catch { remote = 'origin/main'; }

    const changed = changedFiles(remote);
    if (changed.length > 0) {
      console.log(`\n  变更文件 (${changed.length}):`);
      changed.forEach(f => console.log(`    ${f}`));
    }
  }

  // 建议下一步
  console.log(`\n${colors.cyan}[建议的下一步操作]${colors.reset}`);
  if (results.block.length > 0) {
    console.log('  存在阻断项，必须先修复后再推送。');
    console.log('  修复后请重新运行本脚本验证。');
  } else {
    console.log('  所有阻断项已通过。请查看警告项并确认无误。');
    console.log('  如需推送，请回复 "确认推送" 以执行。');
  }

  console.log(`\n${colors.bold}${colors.yellow}当前未执行任何推送、打 tag 或 Release 操作，等待用户下一步明确指示。${colors.reset}\n`);

  // 返回码
  process.exit(results.block.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(colors.red + '脚本执行异常: ' + e.message + colors.reset);
  process.exit(1);
});
