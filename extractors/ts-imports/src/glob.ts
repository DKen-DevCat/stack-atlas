/**
 * 小さな glob → RegExp（`**`、`*`、`?`、`{a,b}`）。パスは / 区切りの相対パスで照合する。
 * ★ extractors/api-link/src/glob.ts と同じ実装。
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` は 0 個以上のディレクトリ
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&'))
          .join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** glob の静的な先頭ディレクトリ（`apps/api/src/handlers/**\/*.ts` → `apps/api/src/handlers`） */
export function globBase(glob: string): string {
  const parts = glob.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (/[*?{[]/.test(p)) break;
    out.push(p);
  }
  if (out.length === parts.length) out.pop();
  return out.join('/');
}

export const toArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
