import { execFileSync } from 'node:child_process';

function git(root: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** root が Git 管理下なら HEAD のコミット SHA */
export function gitCommit(root: string): string | undefined {
  return git(root, ['rev-parse', 'HEAD']);
}

/** origin の URL（認証情報は取り除く）。無ければ undefined */
export function gitRemote(root: string): string | undefined {
  const url = git(root, ['remote', 'get-url', 'origin']);
  if (!url) return undefined;
  const clean = url.replace(/^(\w+:\/\/)[^@/]+@/, '$1');
  // ローカルのプロキシ経由など、外から辿れない URL は使わない
  return /^\w+:\/\/(localhost|127\.0\.0\.1)[:/]/.test(clean) ? undefined : clean;
}
