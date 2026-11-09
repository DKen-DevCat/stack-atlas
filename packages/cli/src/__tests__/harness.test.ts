// ハーネスの CLI（Phase 8-4b。docs/19 §3.2〜§3.7）: build --strict / --dry-run --json、validate --strict、init-views、
// init --skill（シンボリックリンク・home・上書きしない・--update の .new）、regions.yaml の end-to-end
import type { Extractor, PartialGraph } from '@stack-atlas/core';
import { createMemoryLogger } from '@stack-atlas/core';
import { validateGraph, validateGraphV2 } from '@stack-atlas/schema';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runBuild } from '../commands/build.js';
import { harnessVersion, initSkill, readSkillSource, SKILL_DEST } from '../commands/init-skill.js';
import { runInitViews, serializeViewsYaml } from '../commands/init-views.js';
import { runValidate } from '../commands/validate.js';
import { loadExtractors } from '../extractors.js';
import { main } from '../main.js';
import { HARNESS_SKILL } from '../paths.js';
import { hasGo } from './go-env.js';

const example = (p: string) => fileURLToPath(new URL(`../../../../examples/${p}`, import.meta.url));
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const stub = (name: string, out: PartialGraph, v2Role?: Extractor['v2Role']): Extractor => ({
  name,
  ...(v2Role ? { v2Role } : {}),
  detect: async () => true,
  extract: async () => structuredClone(out),
});
const silent = async <T>(fn: () => Promise<T>) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
  }
};
const lines = (out: string[]) => (l: string) => {
  out.push(l);
};

describe('build --strict（CI の関門。docs/19 §3.3）: fixture は補い無しで通る', () => {
  const run = async (name: string) => {
    const out = tmp(`stack-atlas-strict-${name}-`);
    const extractors = await loadExtractors(createMemoryLogger(), { skip: ['screenshots'] });
    const code = await silent(() =>
      runBuild({
        repo: example(name),
        outDir: out,
        extractors,
        strict: true,
        log: createMemoryLogger(),
      }),
    );
    return { code, out };
  };
  it('fixture-repo: 終了コード 0。validate --strict も 0（report の strict のエラー 0）', async () => {
    const { code, out } = await run('fixture-repo');
    expect(code).toBe(0);
    const g = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8'));
    expect(validateGraphV2(g).errors).toEqual([]);
    expect(g.project.generator.report.counts).toMatchObject({
      strictErrors: 0,
      unjoined: 0,
      undetermined: 0,
      screensWithoutHtml: 0,
    });
    const msgs: string[] = [];
    expect(runValidate([join(out, 'graph.json')], lines(msgs), { strict: true })).toBe(0);
    expect(msgs[0]).toMatch(/strict のエラー 0 件/);
  }, 60_000);
  it.skipIf(!hasGo)(
    'fixture-poly: 終了コード 0（handler の無い GET /transactions は警告。D86）',
    async () => {
      const { code, out } = await run('fixture-poly');
      expect(code).toBe(0);
      const g = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8'));
      expect(g.project.generator.report.counts).toMatchObject({
        strictErrors: 0,
        endpointsWithoutHandler: 1,
        undetermined: 0,
      });
      expect(g.project.generator.report.checked['go-types']).toEqual({
        status: 'ok',
        role: 'language',
      });
      expect(runValidate([join(out, 'graph.json')], () => {}, { strict: true })).toBe(0);
    },
    60_000,
  );
});

describe('build --dry-run --json（docs/19 §3.2）', () => {
  it('出力先に何も書かず（一時ディレクトリも消す）、標準出力は JSON だけ', async () => {
    const out = join(tmp('stack-atlas-dry-'), 'never');
    const dryDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('stack-atlas-dry-run-'));
    const before = dryDirs().length;
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logs = vi.spyOn(console, 'log');
    let code: number;
    try {
      const extractors = await loadExtractors(createMemoryLogger(), { skip: ['screenshots'] });
      code = await runBuild({
        repo: example('fixture-repo'),
        outDir: out,
        extractors,
        dryRun: true,
        json: true,
        log: createMemoryLogger(),
      });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      logs.mockRestore();
    }
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(dryDirs().length).toBe(before);
    expect(logs).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    const json = JSON.parse(writes[0]!);
    // §3.2 の表のキー（スナップショット）
    expect(Object.keys(json)).toEqual([
      'checked',
      'adapters',
      'contracts',
      'unjoined',
      'undetermined',
      'opaque',
      'estimates',
      'screens',
      'supplements',
      'strict',
      'issues',
    ]);
    expect(json.checked['ts-types']).toEqual({ status: 'ok', role: 'language' });
    expect(json.checked.hand).toEqual({ status: 'not-detected', role: 'language' });
    expect(json.adapters.names).toEqual(['ts-types']);
    expect(Object.keys(json.adapters.coverage)).toContain('opaqueBoxes');
    expect(json.unjoined).toEqual({
      calls: [],
      endpointsWithoutHandler: [],
      routesWithoutEndpoint: [],
      sql: [],
    });
    // screens は一時ディレクトリで測った（5 画面とも HTML あり）
    expect(json.screens.configured).toBe(true);
    expect(json.screens.routes).toHaveLength(5);
    expect(json.screens.routes.every((r: { html: boolean }) => r.html)).toBe(true);
    expect(json.strict.errors).toEqual([]);
  }, 60_000);

  it('--strict は隙間があれば終了コード 1（--strict が無ければ 0）。--v1 とは一緒に使えない', async () => {
    const root = tmp('stack-atlas-gap-');
    writeFileSync(join(root, 'stack-atlas.config.yaml'), 'project: { name: gap }\n');
    const lang = stub(
      'lang',
      {
        nodes: [],
        edges: [],
        v2: {
          nodes: [
            {
              id: 'fn:get',
              kind: 'fn',
              name: 'get',
              runtime: 'browser',
              ports: [
                {
                  id: 'out',
                  dir: 'out',
                  items: [
                    {
                      id: 'call_1',
                      name: 'fetch()',
                      type: 'R',
                      meta: { http: { method: 'GET', path: '/x' } },
                    },
                  ],
                },
              ],
            },
          ],
          wires: [],
        },
      },
      'language',
    );
    const go = (strict: boolean) =>
      silent(() =>
        runBuild({
          repo: root,
          outDir: join(root, 'out'),
          extractors: [lang],
          strict,
          log: createMemoryLogger(),
        }),
      );
    expect(await go(false)).toBe(0);
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m) => printed.push(String(m)));
    try {
      expect(
        await runBuild({
          repo: root,
          outDir: join(root, 'out'),
          extractors: [lang],
          strict: true,
          log: createMemoryLogger(),
        }),
      ).toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(printed.join('\n')).toMatch(
      /strict: エラー 1 件[\s\S]*\[エラー\] unjoined v2:fn:get#out\/call_1/,
    );
    expect(runValidate([join(root, 'out', 'graph.json')], () => {}, { strict: true })).toBe(1);
    expect(
      await runBuild({
        repo: root,
        extractors: [lang],
        strict: true,
        v1Only: true,
        log: createMemoryLogger(),
      }),
    ).toBe(2);
  });
});

describe('validate --strict（report を読む補助。D72）', () => {
  const file = (g: unknown) => {
    const p = join(tmp('stack-atlas-vstrict-'), 'graph.json');
    writeFileSync(p, JSON.stringify(g));
    return p;
  };
  const report = (extra: Record<string, unknown> = {}) => ({
    version: 2,
    nodes: [],
    wires: [],
    project: {
      generator: {
        report: {
          version: 1,
          checked: { 'ts-types': { status: 'ok', role: 'language' } },
          counts: { strictErrors: 0 },
          ...extra,
        },
      },
    },
  });
  it('report の無い graph・言語アダプタを飛ばした graph・strict の違反のある graph・v1 はエラー', () => {
    const msgs: string[] = [];
    expect(runValidate([file(report())], lines(msgs), { strict: true })).toBe(0);
    expect(runValidate([file(report())], () => {})).toBe(0);
    expect(
      runValidate([file({ version: 2, nodes: [], wires: [] })], lines(msgs), { strict: true }),
    ).toBe(1);
    expect(runValidate([file({ version: 2, nodes: [], wires: [] })], () => {})).toBe(0);
    expect(msgs.join('\n')).toContain('build の報告（project.generator.report）がありません');
    const skipped = report({
      checked: {
        'go-types': { status: 'skipped', role: 'language', reason: 'go が見つかりません' },
      },
    });
    msgs.length = 0;
    expect(runValidate([file(skipped)], lines(msgs), { strict: true })).toBe(1);
    expect(msgs.join('\n')).toContain(
      '言語アダプタ go-types が飛ばされた graph です（go が見つかりません）',
    );
    const bad = report({
      counts: { strictErrors: 2 },
      lists: { strictErrors: ['[unjoined] a', '[views] b'] },
    });
    msgs.length = 0;
    expect(runValidate([file(bad)], lines(msgs), { strict: true })).toBe(1);
    expect(msgs.slice(1)).toEqual([
      '  [strict] build の strict の違反が 2 件あります',
      '    [unjoined] a',
      '    [views] b',
    ]);
    const v1 = JSON.parse(readFileSync(example('race-site.graph.json'), 'utf8'));
    expect(runValidate([file(v1)], () => {}, { strict: true })).toBe(1);
    // schema: report の形が違えばスキーマのエラー
    expect(validateGraphV2(report({ counts: { strictErrors: -1 } })).ok).toBe(false);
  });
});

describe('init-views（docs/19 §3.4）', () => {
  const v1: PartialGraph = {
    nodes: [
      { id: 'route:/', kind: 'page', file: 'src/app/page.tsx' },
      { id: 'layout:/', kind: 'layout', file: 'src/app/layout.tsx' },
      { id: 'cron:daily', kind: 'cron', name: 'daily' },
      { id: 'actor:user', kind: 'actor', name: '利用者' },
      {
        id: 'infra:cdn',
        kind: 'infra',
        name: 'CDN',
        meta: { cdktf: { type: 'aws_cloudfront_distribution' } },
      },
    ],
    edges: [
      { from: 'actor:user', to: 'infra:cdn', kind: 'flow' },
      { from: 'infra:cdn', to: 'route:/', kind: 'flow' },
    ],
  };
  const repo = () => {
    const root = tmp('stack-atlas-views-');
    writeFileSync(join(root, 'stack-atlas.config.yaml'), 'project: { name: views }\n');
    return root;
  };
  it('始点の候補（画面・trigger・利用者）を書き、build でそのまま解ける。既存は上書きしない', async () => {
    const root = repo();
    const ex = [stub('v1', v1)];
    expect(
      await silent(() => runInitViews({ repo: root, extractors: ex, log: createMemoryLogger() })),
    ).toBe(0);
    const text = readFileSync(join(root, '.stack-atlas', 'views.yaml'), 'utf8');
    expect(text).toContain('start: "route:/"');
    expect(text).toContain('start: "cron:daily"');
    expect(text).toContain('start: "actor:user"');
    expect(text).not.toContain('start: "layout:/"');
    expect(text).toContain('#   infra:cdn#hit');
    const log = createMemoryLogger();
    expect(await silent(() => runInitViews({ repo: root, extractors: ex, log }))).toBe(1);
    expect(log.of('error')[0]).toContain('すでにあります');
    expect(readFileSync(join(root, '.stack-atlas', 'views.yaml'), 'utf8')).toBe(text);
    // build で読まれ、解けない view は無い
    const out = join(root, 'out');
    expect(
      await silent(() =>
        runBuild({
          repo: root,
          outDir: out,
          extractors: ex,
          strict: true,
          log: createMemoryLogger(),
        }),
      ),
    ).toBe(0);
    const g = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8'));
    expect(g.views.map((v: { start: string }) => v.start)).toEqual([
      'route:/',
      'cron:daily',
      'actor:user',
    ]);
  });
  it('.stack-atlas がシンボリックリンクなら書かない。views.yml があれば止める', async () => {
    const root = repo();
    const elsewhere = tmp('stack-atlas-views-target-');
    symlinkSync(elsewhere, join(root, '.stack-atlas'));
    expect(
      await silent(() =>
        runInitViews({ repo: root, extractors: [stub('v1', v1)], log: createMemoryLogger() }),
      ),
    ).toBe(2);
    expect(readdirSync(elsewhere)).toEqual([]);
    const other = repo();
    mkdirSync(join(other, '.stack-atlas'));
    writeFileSync(join(other, '.stack-atlas', 'views.yml'), 'views: []\n');
    expect(
      await silent(() =>
        runInitViews({ repo: other, extractors: [stub('v1', v1)], log: createMemoryLogger() }),
      ),
    ).toBe(1);
  });
  it('候補が無ければ空の雛形', () => {
    expect(serializeViewsYaml({ version: 2, nodes: [], wires: [] })).toContain('views: []');
  });
});

describe('init --skill（docs/19 §3.6）', () => {
  const quiet = { info: () => {}, error: () => {} };
  const errs = () => {
    const e: string[] = [];
    return { log: { info: () => {}, error: (m: string) => e.push(m) }, e };
  };
  const skillFile = (dir: string, rel: string) => join(dir, ...SKILL_DEST, rel);

  it('ワークスペースの harness/skill に SKILL.md（frontmatter）・VERSION・雛形がある。--version は VERSION', async () => {
    const files = readSkillSource(HARNESS_SKILL);
    const skill = files.get('SKILL.md')!.toString('utf8');
    expect(skill).toMatch(/^---\nname: stack-atlas\ndescription: .+\n---\n/);
    expect(skill).not.toMatch(/allowed-tools/);
    expect([...files.keys()].filter((k) => k.startsWith('templates/')).sort()).toEqual([
      'templates/DECISIONS.md',
      'templates/stack-atlas.config.yaml',
      'templates/stack-atlas.overrides.yaml',
      'templates/views.yaml',
    ]);
    const v = files.get('VERSION')!.toString('utf8').trim();
    expect(harnessVersion()).toBe(v);
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m) => printed.push(String(m)));
    try {
      expect(await main(['--version'])).toBe(0);
      expect(await main(['init'])).toBe(2);
    } finally {
      log.mockRestore();
    }
    expect(printed[0]).toBe(v);
  });

  it('空のディレクトリに写し、manifest にハッシュ。2 回目は何も上書きしない', () => {
    const dir = tmp('stack-atlas-skill-');
    const r = initSkill({ dir, log: quiet });
    expect(r.code).toBe(0);
    const src = readSkillSource(HARNESS_SKILL);
    for (const [rel, data] of src) expect(readFileSync(skillFile(dir, rel))).toEqual(data);
    const manifest = JSON.parse(readFileSync(skillFile(dir, 'manifest.json'), 'utf8'));
    expect(Object.keys(manifest.files).sort()).toEqual([...src.keys()].sort());
    expect(manifest.version).toBe(harnessVersion());
    for (const f of [
      'stack-atlas.config.yaml',
      'stack-atlas.overrides.yaml',
      '.stack-atlas/views.yaml',
      '.stack-atlas/DECISIONS.md',
    ])
      expect(existsSync(join(dir, f)), f).toBe(true);
    // 利用者が変えたファイルは 2 回目（--update 無し）でも、--update でも上書きしない
    writeFileSync(skillFile(dir, 'SKILL.md'), 'mine');
    writeFileSync(join(dir, 'stack-atlas.config.yaml'), 'project: { name: mine }\n');
    const again = initSkill({ dir, log: quiet });
    expect(again.code).toBe(0);
    expect(again.report!.created).toEqual([]);
    expect(again.report!.skipped).toContain('.claude/skills/stack-atlas/SKILL.md');
    expect(readFileSync(skillFile(dir, 'SKILL.md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(dir, 'stack-atlas.config.yaml'), 'utf8')).toBe(
      'project: { name: mine }\n',
    );
  });

  it('--update: 手で変えていないファイルは置き換え、変えたものは .new に出す', () => {
    const v1 = tmp('stack-atlas-skill-src1-');
    cpSync(HARNESS_SKILL, v1, { recursive: true });
    writeFileSync(join(v1, 'VERSION'), '0.1.0\n');
    const dir = tmp('stack-atlas-skill-up-');
    expect(initSkill({ dir, source: v1, log: quiet }).code).toBe(0);
    writeFileSync(skillFile(dir, 'SKILL.md'), 'mine');
    const v2 = tmp('stack-atlas-skill-src2-');
    cpSync(v1, v2, { recursive: true });
    writeFileSync(join(v2, 'VERSION'), '0.2.0\n');
    writeFileSync(join(v2, 'SKILL.md'), '---\nname: stack-atlas\ndescription: new\n---\n');
    mkdirSync(join(v2, 'references'));
    writeFileSync(join(v2, 'references', 'model.md'), '# model\n');
    // --update 無しは何も置き換えない（無いファイルは作る）
    const plain = initSkill({ dir, source: v2, log: quiet }).report!;
    expect(plain.updated).toEqual([]);
    expect(plain.created).toEqual(['.claude/skills/stack-atlas/references/model.md']);
    expect(readFileSync(skillFile(dir, 'VERSION'), 'utf8')).toBe('0.1.0\n');
    const r = initSkill({ dir, source: v2, update: true, log: quiet });
    expect(r.code).toBe(0);
    expect(r.report!.updated).toEqual(['.claude/skills/stack-atlas/VERSION']);
    expect(r.report!.conflicts).toEqual(['.claude/skills/stack-atlas/SKILL.md']);
    expect(r.report!.created).toEqual([]);
    expect(readFileSync(skillFile(dir, 'VERSION'), 'utf8')).toBe('0.2.0\n');
    expect(readFileSync(skillFile(dir, 'SKILL.md'), 'utf8')).toBe('mine');
    expect(readFileSync(skillFile(dir, 'SKILL.md.new'), 'utf8')).toContain('description: new');
    // manifest: 置き換えたものは新しいハッシュ、手で変えたものは入れたときのハッシュのまま（次の --update も .new）
    const m = JSON.parse(readFileSync(skillFile(dir, 'manifest.json'), 'utf8'));
    expect(m.version).toBe('0.2.0');
    const again = initSkill({ dir, source: v2, update: true, log: quiet });
    expect(again.report!.conflicts).toEqual(['.claude/skills/stack-atlas/SKILL.md']);
    expect(m.files['SKILL.md']).not.toBe(
      JSON.parse(readFileSync(skillFile(dir, 'manifest.json'), 'utf8')).files['VERSION'],
    );
  });

  it('シンボリックリンクはどの段でも断り、何も書かない（.claude・skills・stack-atlas・ファイル・.stack-atlas）', () => {
    const cases: Array<[string, (dir: string, target: string) => void]> = [
      ['.claude', (d, t) => symlinkSync(t, join(d, '.claude'))],
      [
        '.claude/skills',
        (d, t) => (mkdirSync(join(d, '.claude')), symlinkSync(t, join(d, '.claude', 'skills'))),
      ],
      [
        '.claude/skills/stack-atlas',
        (d, t) => (
          mkdirSync(join(d, '.claude', 'skills'), { recursive: true }),
          symlinkSync(t, join(d, ...SKILL_DEST))
        ),
      ],
      [
        'SKILL.md',
        (d, t) => (
          mkdirSync(join(d, ...SKILL_DEST), { recursive: true }),
          writeFileSync(join(t, 'x.md'), 'x'),
          symlinkSync(join(t, 'x.md'), skillFile(d, 'SKILL.md'))
        ),
      ],
      ['.stack-atlas', (d, t) => symlinkSync(t, join(d, '.stack-atlas'))],
    ];
    for (const [name, plant] of cases) {
      const dir = tmp('stack-atlas-skill-link-');
      const target = tmp('stack-atlas-skill-target-');
      plant(dir, target);
      const before = readdirSync(target);
      const { log, e } = errs();
      expect(initSkill({ dir, log }).code, name).toBe(2);
      expect(e[0], name).toContain('シンボリックリンク');
      expect(readdirSync(target), name).toEqual(before);
      expect(existsSync(join(dir, 'stack-atlas.config.yaml')), name).toBe(false);
    }
  });

  it('home と / は断る。コピー元に SKILL.md と VERSION が無ければ断る', () => {
    const dir = tmp('stack-atlas-skill-home-');
    const a = errs();
    expect(initSkill({ dir, home: dir, log: a.log }).code).toBe(2);
    expect(a.e[0]).toContain('home と / は断ります');
    expect(readdirSync(dir)).toEqual([]);
    expect(initSkill({ dir: '/', log: quiet }).code).toBe(2);
    const empty = tmp('stack-atlas-skill-empty-');
    const b = errs();
    expect(initSkill({ dir, source: empty, log: b.log }).code).toBe(2);
    expect(b.e[0]).toContain('SKILL.md と VERSION がありません');
  });
});

describe('regions.yaml の end-to-end（docs/19 §3.7）', () => {
  it('fixture-repo の写しに regions.yaml を置くと、graph.json の screen.regions に source: yaml で入り、v1・v2 とも検証を通る', async () => {
    const root = tmp('stack-atlas-regions-e2e-');
    cpSync(example('fixture-repo'), root, {
      recursive: true,
      filter: (src) => !src.includes(`${join('.stack-atlas', 'out')}`),
    });
    mkdirSync(join(root, '.stack-atlas', 'screens'), { recursive: true });
    writeFileSync(
      join(root, '.stack-atlas', 'screens', 'index.regions.yaml'),
      '- { ref: hook:useRaces, x: 0, y: 100, w: 640, h: 200 }\n',
    );
    const out = join(root, 'out');
    const extractors = await loadExtractors(createMemoryLogger(), { skip: ['screenshots'] });
    expect(
      await silent(() =>
        runBuild({ repo: root, outDir: out, extractors, strict: true, log: createMemoryLogger() }),
      ),
    ).toBe(0);
    const v2 = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8'));
    const v1 = JSON.parse(readFileSync(join(out, 'graph.v1.json'), 'utf8'));
    expect(validateGraphV2(v2).errors).toEqual([]);
    expect(validateGraph(v1).ok).toBe(true);
    const screen = v2.nodes.find((n: { id: string }) => n.id === 'route:/').screen;
    expect(screen.regions).toEqual([
      { ref: 'hook:useRaces', x: 0, y: 100, w: 640, h: 200, source: 'yaml' },
    ]);
  }, 60_000);
});
