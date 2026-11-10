// 配布物（package.json の files / exports）の確認: src が読む JSON Schema が、パッケージに入っていて subpath でも読めること。
// dist/validate*.js は `../<name>.schema.json` を読むので、files に無いとパックした先で検証が動かない
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  files: string[];
  exports: Record<string, unknown>;
};

/** src の（テスト以外の）ファイルが import している `../<name>.schema.json` */
function importedSchemas(): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(`${root}src`)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('.d.ts')) continue;
    const src = readFileSync(`${root}src/${f}`, 'utf8');
    for (const m of src.matchAll(/from\s+'\.\.\/([\w.-]+\.schema\.json)'/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

describe('package.json の配布物', () => {
  it('src が読む JSON Schema（v1・v2）を files と exports の両方に載せる', () => {
    const schemas = importedSchemas();
    expect(schemas).toEqual(['graph-v2.schema.json', 'graph.schema.json']);
    for (const name of schemas) {
      expect(pkg.files, name).toContain(name);
      expect(pkg.exports[`./${name}`], name).toBe(`./${name}`);
    }
  });
});
