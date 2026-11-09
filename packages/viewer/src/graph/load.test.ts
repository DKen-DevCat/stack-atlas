import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import {
  graphUrlFromSearch,
  isBoxLevelWarning,
  prevUrlFromSearch,
  loadGraphFromFile,
  parseGraphText,
  resolveAssetUrl,
  summarizeIssues,
} from './load';
import { SAMPLE_PATH, SAMPLE_V2_PATH } from './testSample';

const sampleText = readFileSync(SAMPLE_PATH, 'utf8');
const sampleV2Text = readFileSync(SAMPLE_V2_PATH, 'utf8');

describe('prevUrlFromSearch', () => {
  it('?prev= を ?graph= と同じ規則で解決する', () => {
    expect(
      prevUrlFromSearch('?graph=out/graph.json&prev=prev/graph.json', 'http://h/atlas/index.html'),
    ).toBe('http://h/atlas/prev/graph.json');
    expect(prevUrlFromSearch('?graph=g.json', 'http://h/')).toBeNull();
  });
});

describe('graphUrlFromSearch', () => {
  it('ページの URL を基準に解決する', () => {
    expect(
      graphUrlFromSearch('?graph=samples/race-site.graph.json', 'http://localhost:5173/'),
    ).toBe('http://localhost:5173/samples/race-site.graph.json');
    expect(
      graphUrlFromSearch('?graph=../data/g.json', 'https://example.com/atlas/viewer/index.html'),
    ).toBe('https://example.com/atlas/data/g.json');
    expect(graphUrlFromSearch('?graph=https://cdn.example.com/g.json', 'http://localhost/')).toBe(
      'https://cdn.example.com/g.json',
    );
  });
  it('指定がなければ null', () => {
    expect(graphUrlFromSearch('', 'http://localhost/')).toBeNull();
    expect(graphUrlFromSearch('?graph=', 'http://localhost/')).toBeNull();
  });
});

describe('resolveAssetUrl', () => {
  const base = 'https://example.com/maps/site/graph.json';
  it('相対パスは graph.json の URL 基準', () => {
    expect(resolveAssetUrl('shots/races-id.png', base)).toBe(
      'https://example.com/maps/site/shots/races-id.png',
    );
    expect(resolveAssetUrl('../shared/a.png', base)).toBe('https://example.com/maps/shared/a.png');
    expect(resolveAssetUrl('/abs/a.png', base)).toBe('https://example.com/abs/a.png');
  });
  it('絶対 URL・data URL はそのまま', () => {
    expect(resolveAssetUrl('https://cdn.example.com/a.png', base)).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(resolveAssetUrl('data:image/png;base64,AAAA', undefined)).toBe(
      'data:image/png;base64,AAAA',
    );
  });
  it('基準 URL がない（ファイルから読んだ）なら相対パスは解決しない', () => {
    expect(resolveAssetUrl('shots/a.png', undefined)).toBeUndefined();
    expect(resolveAssetUrl(undefined, base)).toBeUndefined();
  });
});

describe('parseGraphText', () => {
  it('サンプルは問題なく読める', () => {
    const r = parseGraphText(sampleText, 'x', 'http://localhost/x.json');
    expect(r.graph?.nodes.length).toBeGreaterThan(0);
    expect(summarizeIssues(r.issues)).toEqual({ errors: 0, warnings: 0 });
    expect(r.baseUrl).toBe('http://localhost/x.json');
    expect(r.versionWarning).toBeUndefined();
  });

  it('JSON でなければエラーだけ返す', () => {
    const r = parseGraphText('{nope', 'bad.json');
    expect(r.graph).toBeUndefined();
    expect(r.issues[0]?.level).toBe('error');
    expect(r.issues[0]?.message).toMatch(/JSON として読めません/);
  });

  it('参照エラーがあっても graph を返し、問題を一覧にする（D7）', () => {
    const g = JSON.parse(sampleText);
    g.edges.push({ from: 'comp:Nope', to: 'type:Race', kind: 'uses' });
    g.nodes[0].kind = 'robot';
    const r = parseGraphText(JSON.stringify(g), 'x');
    expect(r.graph).toBeDefined();
    expect(summarizeIssues(r.issues)).toEqual({ errors: 1, warnings: 1 });
    expect(r.issues.find((i) => i.level === 'error')?.message).toContain('comp:Nope');
  });

  it('スキーマ違反なら graph なし', () => {
    const g = JSON.parse(sampleText);
    delete g.layers;
    const r = parseGraphText(JSON.stringify(g), 'x');
    expect(r.graph).toBeUndefined();
    expect(summarizeIssues(r.issues).errors).toBeGreaterThan(0);
  });

  it('未知の version は警告を出して v1 として読む', () => {
    // version 2 は配線図（v2）として読むようになったので、未知の version の例は 3 にした（Phase 8-0b）
    const g = JSON.parse(sampleText);
    g.version = 3;
    const r = parseGraphText(JSON.stringify(g), 'x');
    expect(r.versionWarning).toMatch(/version 3/);
    expect(r.graph).toBeDefined();
    expect(r.v2).toBeUndefined();
  });

  it('version 2 は v2 の検証器で読み、エラーと警告を 1 列にする（v1 の graph は返さない）', () => {
    const r = parseGraphText(sampleV2Text, 'v2.json', 'http://localhost/v2.json');
    expect(r.v2).toBe(true);
    expect(r.graph).toBeUndefined();
    expect(r.graphV2?.nodes.length).toBeGreaterThan(0);
    expect(r.versionWarning).toBeUndefined();
    expect(r.baseUrl).toBe('http://localhost/v2.json');
    // 例の v2 は警告 1 件（fetcher の戻りの wireType が unknown）
    expect(summarizeIssues(r.issues)).toEqual({ errors: 0, warnings: 1 });
  });

  it('version 2 でスキーマ違反なら graphV2 なし（v2 のまま。v1 として読み直さない）', () => {
    const g = JSON.parse(sampleV2Text);
    delete g.nodes;
    const r = parseGraphText(JSON.stringify(g), 'x');
    expect(r.v2).toBe(true);
    expect(r.graphV2).toBeUndefined();
    expect(r.graph).toBeUndefined();
    expect(summarizeIssues(r.issues).errors).toBeGreaterThan(0);
  });
});

describe('loadGraphFromFile', () => {
  it('Blob から読む。基準 URL はない', async () => {
    const r = await loadGraphFromFile(Object.assign(new Blob([sampleText]), { name: 'mine.json' }));
    expect(r.source).toBe('mine.json');
    expect(r.baseUrl).toBeUndefined();
    expect(r.graph).toBeDefined();
  });
});

describe('isBoxLevelWarning（箱の単位の v2 で必ず出る警告。配線図の一覧に出さない）', () => {
  const graph: GraphV2 = {
    version: 2,
    nodes: [
      {
        id: 'lib:a',
        kind: 'helper',
        name: 'a',
        runtime: 'browser',
        ports: [
          {
            id: 'in',
            dir: 'in',
            items: [{ id: '_', name: '値', type: 'unknown', wireType: 'unknown' }],
          },
          {
            id: 'out',
            dir: 'out',
            items: [
              {
                id: 'ret',
                name: 'ret',
                type: 'Promise<T>',
                wireType: 'unknown',
                children: [{ id: 'x', name: 'x', type: 'unknown', wireType: 'unknown' }],
              },
            ],
          },
        ],
      },
    ],
    wires: [],
  };
  const w = (path: string, message: string, level: 'warning' | 'error' = 'warning') => ({
    level,
    path,
    message,
  });

  it('口の単位の線・箱の警告は箱の単位', () => {
    expect(isBoxLevelWarning(w('/wires/0', '線 "a" → "b" は口の単位です'), graph)).toBe(true);
    expect(
      isBoxLevelWarning(
        w('/nodes/0/ports', '箱 "lib:a" は口の単位の項目（"_"）を持っています'),
        graph,
      ),
    ).toBe(true);
  });

  it('wireType unknown は、型の分からない置き場の項目（type も unknown）のときだけ', () => {
    const msg = '項目 "…" の wireType が unknown です';
    expect(isBoxLevelWarning(w('/nodes/0/ports/0/items(in/_)', msg), graph)).toBe(true);
    expect(isBoxLevelWarning(w('/nodes/0/ports/1/items(out/ret.x)', msg), graph)).toBe(true);
    // 型は分かっているが線の上の形が分からない項目は、読むべき警告として残す（手組みの v2 の fetcher の戻りなど）
    expect(isBoxLevelWarning(w('/nodes/0/ports/1/items(out/ret)', msg), graph)).toBe(false);
  });

  it('エラー・ほかの警告・graph が無いときは残す', () => {
    expect(isBoxLevelWarning(w('/wires/0', '口の単位', 'error'), graph)).toBe(false);
    expect(isBoxLevelWarning(w('/nodes/0/links', '不透明な箱'), graph)).toBe(false);
    expect(
      isBoxLevelWarning(w('/nodes/0/ports/0/items(in/_)', 'wireType が unknown です'), undefined),
    ).toBe(false);
  });
});
