import { execFileSync } from 'node:child_process';
import { realpathSync, statfsSync } from 'node:fs';
import { platform } from 'node:os';

function command(command, args = []) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }).trim();
  } catch {
    return null;
  }
}

function pnpmVersion() {
  const match = /(?:^|\s)pnpm\/([^\s]+)/u.exec(process.env.npm_config_user_agent ?? '');
  if (match) return match[1];
  return command(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version']);
}

const disk = statfsSync(process.cwd());
const gitRoot = command('git', ['rev-parse', '--show-toplevel']);
const gitRootMatchesCwd = gitRoot === null ? false : realpathSync(gitRoot) === realpathSync(process.cwd());
const report = {
  schemaVersion: 1,
  platform: platform(),
  node: process.version,
  git: command('git', ['--version']),
  githubCli: command('gh', ['--version'])?.split('\n')[0] ?? null,
  pnpm: pnpmVersion(),
  gitRootMatchesCwd,
  gitAuthorConfigured: command('git', ['var', 'GIT_AUTHOR_IDENT']) !== null,
  freeDiskAtLeast8GiB: disk.bavail * disk.bsize >= 8 * 1024 * 1024 * 1024,
  privacyNote: 'This report omits usernames, account identities, absolute paths, OS build numbers, and exact disk capacity.'
};

console.log(JSON.stringify(report, null, 2));
if (!report.git || !report.pnpm || !report.gitRootMatchesCwd || !report.freeDiskAtLeast8GiB) process.exitCode = 1;
