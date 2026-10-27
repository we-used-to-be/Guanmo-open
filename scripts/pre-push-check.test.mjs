import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Execute the real CLI flow with an anonymous repository and intercepted commands.
// No network, user files, builds, or native compilation are accessed.
const source = readFileSync(new URL('./pre-push-check.mjs', import.meta.url), 'utf8')
  .replace(/^import .+;\r?\n/gm, '')
  .replace('import.meta.dirname', JSON.stringify('/fixture/scripts'));

async function runCheck(args = [], content = 'Anonymous documentation', cargoVersion = '1.0.0') {
  const commands = [];
  const output = [];
  let exitCode;
  await runInNewContext(source, {
    join, relative, resolve,
    execSync(command) {
      commands.push(command);
      if (command === 'git branch --show-current') return 'feature';
      if (command === 'git ls-files') return 'README.md';
      return '';
    },
    existsSync(path) {
      return /(?:README\.md|package\.json|Cargo\.toml|CHANGELOG\.md)$/.test(path);
    },
    statSync: () => ({ isFile: () => true, size: 100 }),
    readFileSync(path) {
      if (path.endsWith('package.json')) return '{"version":"1.0.0"}';
      if (path.endsWith('Cargo.toml')) return `version = "${cargoVersion}"`;
      return content;
    },
    console: {
      log: line => output.push(String(line)),
      error: line => output.push(String(line)),
    },
    process: { argv: ['node', 'pre-push-check.mjs', ...args], exit: code => { exitCode = code; } },
  });
  return { commands, output: output.join('\n'), exitCode };
}

const qualityCommands = ['npx tsc --noEmit 2>&1', 'npx vite build 2>&1', 'cargo check 2>&1'];

test('default mode retains all existing quality checks', async () => {
  const result = await runCheck();
  assert.equal(result.exitCode, 0);
  for (const command of qualityCommands) assert.ok(result.commands.includes(command));
  assert.doesNotMatch(result.output, /NOT TESTED/);
});

test('security-only mode scans safety and skips all non-Git commands', async () => {
  const result = await runCheck(['--security-only']);
  assert.equal(result.exitCode, 0);
  assert.ok(result.commands.every(command => command.startsWith('git ')));
  assert.match(result.output, /NOT TESTED: TypeScript/);
  assert.match(result.output, /未在 tracked 文件中发现敏感内容|通过项/);
  assert.match(result.output, /确认推送/);
  assert.match(result.output, /当前未执行任何推送、打 tag 或 Release 操作/);
});

test('security-only mode still blocks sensitive content', async () => {
  const result = await runCheck(['--security-only'], 'sk-' + 'a'.repeat(32));
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /OpenAI API Key/);
  assert.ok(result.commands.every(command => command.startsWith('git ')));
});

test('release mode retains quality and version checks', async () => {
  const result = await runCheck(['--release']);
  assert.equal(result.exitCode, 0);
  for (const command of qualityCommands) assert.ok(result.commands.includes(command));
  assert.match(result.output, /Cargo.toml 版本 : 1\.0\.0/);
});

test('release security-only mode retains version checks without builds', async () => {
  const result = await runCheck(['--release', '--security-only']);
  assert.equal(result.exitCode, 0);
  assert.ok(result.commands.includes('git tag -l'));
  assert.ok(result.commands.every(command => command.startsWith('git ')));
  assert.match(result.output, /Cargo.toml 版本 : 1\.0\.0/);
  assert.match(result.output, /NOT TESTED/);
});

test('release security-only mode still blocks version mismatches', async () => {
  const result = await runCheck(['--release', '--security-only'], 'Anonymous documentation', '2.0.0');
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /版本号不一致/);
});
