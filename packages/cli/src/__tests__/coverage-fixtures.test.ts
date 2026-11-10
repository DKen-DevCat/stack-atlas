// 段 0 の報告（Phase 9-L0。docs/23 §3.1・§5）を 3 つの fixture で確かめる: 生成物の除外、読んだ・読めていないの事実、
// strict のエラーの数は変わらない（0・0・3。build --strict の数は harness.test.ts の fixture のテストが固定している）
import {
  buildGraph,
  createMemoryLogger,
  loadConfig,
  scanRepoScope,
  strictIssues,
  type BuildGraphResult,
} from '@stack-atlas/core';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadExtractors } from '../extractors.js';
import { hasGo } from './go-env.js';

const example = (p: string) => fileURLToPath(new URL(`../../../../examples/${p}`, import.meta.url));
/** fixture が git の追跡の下にあるか（CI の checkout と手元の clone。tarball から動かすときは walk になる） */
const tracked = (() => {
  try {
    return (
      execFileSync('git', ['ls-files', 'web/next.config.ts'], {
        cwd: example('fixture-poly'),
        encoding: 'utf8',
      }).trim() === 'web/next.config.ts'
    );
  } catch {
    return false;
  }
})();

const builds = new Map<string, Promise<BuildGraphResult>>();
const build = (name: string) => {
  let p = builds.get(name);
  if (!p) {
    p = (async () => {
      const log = createMemoryLogger();
      const extractors = await loadExtractors(log, { skip: ['screenshots', 'screens'] });
      return buildGraph({ root: example(name), extractors, log, commit: false });
    })();
    builds.set(name, p);
  }
  return p;
};
const lang = (r: BuildGraphResult, l: string) =>
  r.harness!.coverage.languages.find((x) => x.language === l);

describe('fixture の数える範囲（Phase 9-L0）', () => {
  it.each(['fixture-poly', 'fixture-gaps'])(
    '%s: web/export/_next/static/chunks/*.js は生成物（既知のディレクトリ _next）として除く',
    (name) => {
      const root = example(`${name}/web`);
      const s = scanRepoScope(root, 'web', loadConfig(example(name), createMemoryLogger()));
      expect(s.files.filter((f) => f.path.includes('_next/'))).toEqual([]);
      if (tracked) {
        expect(s.method).toBe('git');
        // chunks の js 7・css 1・font 1
        expect(s.excluded.dir).toBe(9);
      } else expect(s.prunedDirs).toBeGreaterThan(0);
      expect(s.files.some((f) => f.path === 'src/app/page.tsx')).toBe(true);
    },
  );
});

describe('fixture の「読んだ」と読めていないソース（Phase 9-L0。見つかったことを固定する）', () => {
  it('fixture-repo: next.config.mjs は nextjs-app と cache が読む（docs/23 の見込みでは警告だったが、読んでいる）。読めていないソースは無い', async () => {
    const r = await build('fixture-repo');
    expect(lang(r, 'javascript')).toEqual({
      language: 'javascript',
      files: 1,
      lines: 9,
      read: { adapter: 0, extractor: 9, hand: 0, none: 0 },
      readBy: { cache: 9, 'nextjs-app': 9 },
      unread: { files: 0, lines: 0 },
    });
    // infra/ の CDKtf の .ts は tsconfig に入っていないが、cdktf が construct の場所を探すのに読む
    expect(lang(r, 'typescript')!.readBy).toMatchObject({ cdktf: 368 });
    expect(lang(r, 'typescript')!.unread.files).toBe(0);
    expect(r.harness!.coverage.unread).toEqual([]);
    expect(r.issues.filter((i) => i.path === 'coverage')).toEqual([]);
    if (tracked) expect(r.harness!.coverage.scope.excluded.output).toBe(6); // screens.dir の site/
    expect(strictIssues(r).warnings.map((w) => w.rule)).not.toContain('unread');
  }, 60_000);

  it('fixture-gaps: legacy/api/stats.php（PHP）と down のマイグレーション（sql.migrations の外）が読めていない。.env.local は数えるが読まない', async () => {
    const r = await build('fixture-gaps');
    const c = r.harness!.coverage;
    expect(c.unread.map((u) => [u.language, u.files, u.examples])).toEqual([
      ['php', 1, ['platform/legacy/api/stats.php']],
      [
        'sql',
        2,
        ['platform/migrations/000001_init.down.sql', 'platform/migrations/000002_push.down.sql'],
      ],
    ]);
    expect(r.issues.filter((i) => i.path === 'coverage').map((i) => i.level)).toEqual([
      'warning',
      'warning',
    ]);
    expect(c.scope.secret).toBe(1);
    // 言語アダプタの読んだファイル（go-types が無くても go が全部のファイルを申告する）
    expect(lang(r, 'go')!.unread).toEqual({ files: 0, lines: 0 });
    expect(lang(r, 'typescript')!.unread).toEqual({ files: 0, lines: 0 });
    expect(lang(r, 'terraform')!.readBy).toEqual({ terraform: 507 });
    expect(c.formats.find((f) => f.format === 'tfvars')).toEqual({
      format: 'tfvars',
      files: 1,
      readBy: ['terraform'],
    });
    expect(c.formats.find((f) => f.format === 'go-mod')!.readBy).toContain('go');
    // 段 0 の警告は strict でも警告（9-L0 ではエラーにしない。D171）
    const s = strictIssues(r);
    expect(s.warnings.filter((w) => w.rule === 'unread')).toHaveLength(2);
    expect(s.errors.map((e) => e.rule)).not.toContain('empty');
  }, 60_000);

  it.skipIf(!hasGo)(
    'fixture-poly・fixture-gaps: go は go-types（言語アダプタ）が読んだ段に数える',
    async () => {
      for (const name of ['fixture-poly', 'fixture-gaps']) {
        const go = lang(await build(name), 'go')!;
        expect(go.read.adapter, name).toBe(go.lines);
        expect(Object.keys(go.readBy).sort(), name).toEqual(['go', 'go-types']);
      }
    },
    60_000,
  );

  it('fixture-poly: 読めていないのは down のマイグレーションだけ', async () => {
    const r = await build('fixture-poly');
    expect(r.harness!.coverage.unread.map((u) => [u.language, u.files, u.lines])).toEqual([
      ['sql', 2, 3],
    ]);
  }, 60_000);
});
