import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const exec = promisify(execFile);
export type RunCommand = (file: string, args: string[]) => Promise<string>;
const runCommand: RunCommand = async (file, args) => {
  const r = await exec(file, args, { timeout: 20 * 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' } });
  return r.stdout.trim();
};
export async function updateCli(dir: string, progress: (text: string) => void, run: RunCommand = runCommand): Promise<string> {
  progress('正在检查 CLI 与 npm 最新稳定版本');
  const before = await run('codex', ['--version']);
  const current = before.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (!current) throw new Error(`无法识别当前版本：${before}`);
  const latest = (await run('npm', ['view', '@openai/codex', 'version'])).trim();
  if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('npm 返回的稳定版本格式无效');
  if (latest === current) return `CLI 已是最新稳定版 ${current}，无需更新。`;
  const a = latest.split('.').map(Number), b = current.split('.').map(Number);
  const first = a.findIndex((v, i) => v !== b[i]);
  if (first >= 0 && a[first] < b[first]) return `当前 CLI ${current} 高于 npm 稳定版 ${latest}，未降级。`;
  const root = await run('npm', ['root', '-g']);
  if (root !== '/usr/local/lib/node_modules') throw new Error(`全局安装路径与预期不同：${root}，未修改。`);
  await run('sudo', ['-n', 'true']);
  progress(`备份 ${current}，准备更新到 ${latest}`);
  const backup = join(dir, 'codex-before.tar');
  await run('sudo', ['-n', 'tar', '-cpf', backup, '-C', root, '@openai/codex']);
  const oldLink = await run('readlink', ['/usr/local/bin/codex']);
  writeFileSync(join(dir, 'versions.json'), JSON.stringify({ current, latest, oldLink }), { mode: 0o600 });
  try {
    progress(`安装 ${latest}；此阶段停止请求不会中断安装事务`);
    await run('sudo', ['-n', 'npm', 'install', '-g', `@openai/codex@${latest}`]);
    progress('验证新 CLI');
    const after = await run('codex', ['--version']);
    if (after.trim() !== `codex-cli ${latest}`) throw new Error(`版本验证失败：${after}`);
    await run('codex', ['exec', '--help']);
    return `CLI 已从 ${current} 更新到 ${latest}，版本及启动检查通过。运行中的桌面会话不会被强制重启。`;
  } catch (error) {
    progress('更新失败，恢复本机原版本备份');
    try {
      await run('sudo', ['-n', 'rm', '-rf', '--', '/usr/local/lib/node_modules/@openai/codex']);
      await run('sudo', ['-n', 'tar', '-xpf', backup, '-C', root]);
      await run('sudo', ['-n', 'ln', '-sfn', '--', oldLink, '/usr/local/bin/codex']);
      const restored = await run('codex', ['--version']);
      if (restored.trim() !== before.trim()) throw new Error(`恢复后版本异常：${restored}`);
    } catch (rollback) { throw new Error(`更新失败：${String(error)}；回退也失败：${String(rollback)}；备份：${backup}`); }
    throw new Error(`更新失败，已恢复 ${current}：${String(error)}`);
  }
}

export async function recoverCliUpdate(dir: string, progress: (text: string) => void, run: RunCommand = runCommand): Promise<string> {
  progress('正在核查中断更新的版本与备份');
  const metadata = join(dir, 'versions.json');
  if (!existsSync(metadata)) {
    return `原更新没有进入安装阶段，未执行重装。当前：${await run('codex', ['--version'])}。需要升级可重新发送 /update-cli。`;
  }
  const { current, latest, oldLink } = JSON.parse(readFileSync(metadata, 'utf8'));
  if (![current, latest].every(v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) || typeof oldLink !== 'string') throw new Error('更新记录格式异常');
  let observed: string | undefined;
  try {
    const version = await run('codex', ['--version']);
    observed = version;
    if ([`codex-cli ${latest}`, `codex-cli ${current}`].includes(version.trim())) {
      await run('codex', ['exec', '--help']);
      return `更新恢复检查通过，当前 ${version}，无需重复安装。`;
    }
  } catch { /* restore the local backup below */ }
  if (observed && /^codex-cli \d+\.\d+\.\d+$/.test(observed) && ![`codex-cli ${current}`, `codex-cli ${latest}`].includes(observed)) {
    throw new Error(`当前版本 ${observed} 已被其他操作更改，保留现场，不覆盖。`);
  }
  const backup = join(dir, 'codex-before.tar');
  if (!existsSync(backup)) throw new Error('缺少备份，停止恢复以保留现场');
  await run('sudo', ['-n', 'tar', '-tf', backup]);
  progress(`恢复本机备份 ${current}`);
  await run('sudo', ['-n', 'rm', '-rf', '--', '/usr/local/lib/node_modules/@openai/codex']);
  await run('sudo', ['-n', 'tar', '-xpf', backup, '-C', '/usr/local/lib/node_modules']);
  await run('sudo', ['-n', 'ln', '-sfn', '--', oldLink, '/usr/local/bin/codex']);
  const restored = await run('codex', ['--version']);
  if (restored.trim() !== `codex-cli ${current}`) throw new Error(`恢复验证失败：${restored}`);
  await run('codex', ['exec', '--help']);
  return `已从本机备份恢复 CLI ${current}，启动验证通过。`;
}
