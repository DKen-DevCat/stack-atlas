// 根拠と未読の検査（Phase 10-1b。docs/28 §9.1 の D255〜D266）。
// 根拠つきの図（fixtures/atlas-evidence: 正解の図の写しに、サンプルのアプリ prototype/live/app の行を見て根拠を書いたもの）が通ること、
// わざと入れた誤りを見つけること、git を呼ぶときに対象の repo の設定や置き場のものに動かされないことを確かめる
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleAtlas, checkAtlas, formatAtlasReport, type AtlasReport } from '../atlas/index.js';
import { trackedRegularFiles } from '../git.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/atlas-evidence/', import.meta.url));
const APP = fileURLToPath(new URL('../../../../prototype/live/app/', import.meta.url));
const GRAPH = '.stack-atlas/graph/app.yaml';
const errors = (r: AtlasReport) => r.issues.filter((i) => i.level === 'error');
const warnings = (r: AtlasReport) => r.issues.filter((i) => i.level === 'warning');
// 開発者の git の設定（無視の決まりなど）に左右されないよう、全体と利用者の設定を読まない
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });

/**
 * 根拠つきの図を一時ディレクトリに写す: <tmp>/atlas（図。atlas.yaml は ../repo を指す）と <tmp>/repo（サンプルのアプリ）。
 * repo は git の repo にする（atlas.yaml で宣言した repo は、git の作業ツリーの中でなければ根拠を読まない。2026-11-13 のレビュー）。
 * あとから足したファイルは、track() で追跡に入れる。edit で図のファイルを書き換える
 */
function copy(edit: (graph: string) => string = (g) => g) {
  const tmp = mkdtempSync(join(tmpdir(), 'stack-atlas-evidence-'));
  const atlas = join(tmp, 'atlas');
  cpSync(FIXTURE, atlas, { recursive: true });
  cpSync(APP, join(tmp, 'repo', 'app'), { recursive: true });
  git(join(tmp, 'repo'), 'init', '-q');
  git(join(tmp, 'repo'), 'add', '-A');
  writeFileSync(join(atlas, '.stack-atlas/atlas.yaml'), 'repo: { path: ../repo }\n');
  writeFileSync(join(atlas, '.stack-atlas/reading.yaml'), 'skipped: []\n');
  const file = join(atlas, GRAPH);
  const before = readFileSync(file, 'utf8');
  const after = edit(before);
  writeFileSync(file, after);
  const repo = join(tmp, 'repo');
  return { tmp, atlas, repo, changed: after !== before, track: () => git(repo, 'add', '-A') };
}
/** 根拠の 1 つを書き換える（文字列で 1 か所だけ） */
const swap = (from: string, to: string) => (g: string) => {
  expect(g.split(from).length - 1, `"${from}" が 1 か所だけにあること`).toBe(1);
  return g.replace(from, to);
};
const LOAD = 'evidence: [{ file: app/index.html, lines: [78, 81], text: "async function load()" }]';
const loadEvidence = (file: string, lines: string, text: string) =>
  swap(LOAD, `evidence: [{ file: ${file}, lines: ${lines}, text: ${JSON.stringify(text)} }]`);

describe('根拠: 根拠つきの図', () => {
  it('根拠 24 件が、書いた行の範囲で見つかる。未読は 0（根拠に出てくる 2・申告で除いた 5）', () => {
    const r = checkAtlas(FIXTURE);
    expect(r.issues).toEqual([]);
    expect(r.evidence).toEqual({
      nodes: { with: 9, total: 9 },
      wires: { with: 15, total: 15 },
      entries: 24,
      found: 24,
    });
    expect(r.unread).toEqual([
      expect.objectContaining({
        git: true,
        total: 7,
        evidenced: 2,
        declared: 5,
        secret: 0,
        unread: 0,
      }),
    ]);
    expect(formatAtlasReport(r)).toContain(
      '根拠: 根拠のある箱 9 / 9・線 15 / 15（根拠 24 件のうち、書いた範囲で見つかったもの 24 件）',
    );
  });

  it('bundle（と live）は、根拠と未読を見ない。根拠に誤りがあっても、まとめる（docs/28 D261）', () => {
    const { atlas } = copy(loadEvidence('app/index.html', '[78, 81]', 'async function nothing()'));
    expect(errors(checkAtlas(atlas))).toHaveLength(1);
    const b = bundleAtlas(atlas);
    expect(b.graph).toBeDefined();
    expect(b.report.evidence).toBeUndefined();
    expect(b.report.unread).toBeUndefined();
  });
});

describe('根拠: わざと入れた誤り', () => {
  const only = (edit: (g: string) => string) => {
    const { atlas } = copy(edit);
    return checkAtlas(atlas);
  };

  it('文字列が無い・行の範囲がファイルを超える・始めが終わりより後・短い・記号だけ・長すぎる: 誤り', () => {
    const cases: Array<[string, string, string, RegExp]> = [
      ['app/index.html', '[78, 81]', 'async function nothing()', /にありません/],
      ['app/index.html', '[78, 500]', 'async function load()', /行の数（112）を超えています/],
      ['app/index.html', '[81, 78]', 'async function load()', /始めが、終わりより後/],
      ['app/index.html', '[78, 81]', 'load()', /8〜200 字/],
      ['app/index.html', '[78, 81]', '() => { });', /文字か数字を含めて/],
      ['app/index.html', '[78, 81]', 'あ'.repeat(201), /8〜200 字/],
    ];
    for (const [file, lines, text, message] of cases) {
      const r = only(loadEvidence(file, lines, text));
      expect(errors(r), text.slice(0, 30)).toHaveLength(1);
      expect(errors(r)[0]).toMatchObject({
        check: 'evidence',
        file: GRAPH,
        path: '箱 "fn:load" の根拠 1',
      });
      expect(errors(r)[0]!.message).toMatch(message);
    }
  });

  it('エージェントが書いた文字列の制御文字は、出力で伏せる（端末を操作させない）', () => {
    const r = only(
      loadEvidence('app/index.html', '[78, 81]', 'async \u001b[31mfunction nothing()'),
    );
    expect(errors(r)[0]!.message).toContain('async ?[31mfunction nothing()');
    expect(formatAtlasReport(r)).not.toContain('\u001b');
  });

  it('書いた範囲の外でだけ見つかる: 警告（何行めのあたりにあるか）。前後 3 行までは、範囲で見つかったことにする', () => {
    const far = only(loadEvidence('app/index.html', '[10, 20]', 'async function load()'));
    expect(errors(far)).toEqual([]);
    expect(warnings(far)[0]!.message).toContain('78 行めのあたりにあります');
    const near = only(loadEvidence('app/index.html', '[81, 84]', 'async function load()'));
    expect(near.issues).toEqual([]);
    expect(near.evidence!.found).toBe(24);
  });

  it('ありふれた文字列（3 か所以上）・広すぎる範囲（200 行を超える）: 警告', () => {
    const common = only(loadEvidence('app/index.html', '[92, 94]', 'await load();'));
    expect(warnings(common).map((w) => w.message)).toEqual([
      expect.stringContaining('3 か所あります'),
    ]);
    const { atlas, repo, track } = copy(
      loadEvidence('long.txt', '[1, 300]', 'line 150 of the file'),
    );
    writeFileSync(
      join(repo, 'long.txt'),
      Array.from({ length: 300 }, (_, i) => `line ${i + 1} of the file`).join('\n'),
    );
    track();
    expect(warnings(checkAtlas(atlas)).map((w) => w.message)).toEqual([
      expect.stringContaining('広すぎます'),
    ]);
  });

  it('根拠に書けないファイル: repo の外・絶対パス・.git・秘密らしいもの・リンク・ハードリンク・図の置き場の中。どれも読まない', () => {
    const { atlas, repo, track } = copy();
    writeFileSync(join(repo, '.env'), 'TOKEN=async function load()\n');
    writeFileSync(join(repo, 'id_deploy'), 'async function load()\n');
    symlinkSync(join(repo, 'app/index.html'), join(repo, 'link.html'));
    // 2026-11-13 変更（レビュー 7）: ハードリンクは、根拠に使っていないファイルに張る（前は sw.js に張ったので、ほかの根拠も誤りになり、
    // hard.js の判定が働かなくても通っていた）
    writeFileSync(join(repo, 'unused.txt'), 'async function load()\n');
    linkSync(join(repo, 'unused.txt'), join(repo, 'hard.js'));
    track();
    const cases: Array<[string, RegExp]> = [
      ['../atlas/.stack-atlas/graph/app.yaml', /repo の外/],
      ['/etc/hosts', /絶対パス/],
      ['.git/config', /\.git の中/],
      ['.GIT/config', /\.git の中/],
      ['.env', /秘密らしい/],
      ['id_deploy', /秘密らしい/],
      // 追跡しているリンクは、普通のファイルではないので、追跡している普通のファイルの一覧に入らない
      ['link.html', /追跡していない|シンボリックリンク/],
      ['hard.js', /ハードリンク/],
      // 2026-11-13 追加（レビュー 1）: ファイルの下を指すパスで、check が落ちない（その根拠 1 件の誤り）
      ['app/index.html/x', /追跡していない|ありません/],
    ];
    for (const [file, message] of cases) {
      const g = readFileSync(join(atlas, GRAPH), 'utf8');
      writeFileSync(join(atlas, GRAPH), loadEvidence(file, '[1, 1]', 'async function load()')(g));
      const r = checkAtlas(atlas);
      expect(
        errors(r)
          .map((e) => e.message)
          .join('\n'),
        file,
      ).toMatch(message);
      expect(errors(r), file).toHaveLength(1);
      // 中身は写さない（エージェントが書いた文字列だけ）
      expect(JSON.stringify(r), file).not.toContain('TOKEN=');
      writeFileSync(join(atlas, GRAPH), g);
    }
    // 置き場が repo そのもののとき、図の置き場の中は書けない（自分が書いた文字は、必ず見つかるため）
    const self = mkdtempSync(join(tmpdir(), 'stack-atlas-evidence-self-'));
    cpSync(FIXTURE, self, { recursive: true });
    cpSync(APP, join(self, 'app'), { recursive: true });
    writeFileSync(join(self, '.stack-atlas/atlas.yaml'), '# 置き場そのものが repo\n');
    const g = readFileSync(join(self, GRAPH), 'utf8');
    writeFileSync(
      join(self, GRAPH),
      loadEvidence('.stack-atlas/graph/app.yaml', '[1, 400]', 'async function load()')(g),
    );
    expect(
      errors(checkAtlas(self))
        .map((e) => e.message)
        .join('\n'),
    ).toMatch(/図の置き場/);
  });

  it('大きすぎるファイルは、読まずに警告（確かめられない）', () => {
    const { atlas, repo, track } = copy(loadEvidence('big.txt', '[1, 1]', 'async function load()'));
    writeFileSync(join(repo, 'big.txt'), `async function load()\n${'x'.repeat(1024 * 1024 + 10)}`);
    track();
    const r = checkAtlas(atlas);
    expect(errors(r)).toEqual([]);
    expect(warnings(r)[0]!.message).toContain('大きすぎる');
  });

  it('根拠の無い箱と線は、1 件ずつの指摘にせず、数で知らせる。コードに無い箱（meta.why）は数えない', () => {
    const r = only((g) =>
      swap(
        LOAD + '\n',
        'meta: { why: "試し" }\n',
      )(
        swap(
          ', evidence: [{ file: app/index.html, lines: [80, 80], text: "render(comments);" }]',
          '',
        )(g),
      ),
    );
    expect(r.issues).toEqual([]);
    expect(r.evidence).toMatchObject({
      nodes: { with: 8, total: 8 },
      wires: { with: 14, total: 15 },
    });
  });
});

describe('atlas.yaml（repo の表）と reading.yaml（申告）', () => {
  const withFiles = (atlasYaml: string, readingYaml?: string) => {
    const { atlas, tmp } = copy();
    writeFileSync(join(atlas, '.stack-atlas/atlas.yaml'), atlasYaml);
    if (readingYaml !== undefined)
      writeFileSync(join(atlas, '.stack-atlas/reading.yaml'), readingYaml);
    return { report: checkAtlas(atlas), tmp, atlas };
  };

  it('repo の表の誤り: 絶対パス・~・無い・リンク・名前の重複・入れ子・repo と repos の両方・知らないキー', () => {
    const { tmp } = copy();
    symlinkSync(join(tmp, 'repo'), join(tmp, 'link'));
    const cases: Array<[string, RegExp]> = [
      ['repo: { path: /tmp }', /相対パスにしてください/],
      ['repo: { path: "~/x" }', /相対パスにしてください/],
      ['repo: { path: ../nothing }', /ありません/],
      ['repos: [{ name: a, path: ../repo }, { name: a, path: ../repo/app }]', /重複/],
      ['repos: [{ name: a, path: ../repo }, { name: b, path: ../repo/app }]', /入れ子/],
      ['repo: { path: ../repo }\nrepos: [{ name: a, path: ../repo }]', /どちらか 1 つだけ/],
      ['repo: { path: ../repo }\nurl: x', /知らないキー url/],
      ['repos: [{ name: "a/b", path: ../repo }]', /英字・数字/],
      // 2026-11-13 追加（セキュリティのレビュー 1）: 図の置き場の祖先は、repo に取らない（どこでも読める道にしない）
      ['repo: { path: .. }', /図の置き場を含むディレクトリ/],
      [
        'repos: [{ name: r, path: ../../../../../../../../../../../../.. }]',
        /図の置き場を含むディレクトリか、ホームか、ファイルシステムの根/,
      ],
    ];
    for (const [yaml, message] of cases) {
      const atlas = join(tmp, 'atlas');
      writeFileSync(join(atlas, '.stack-atlas/atlas.yaml'), yaml);
      expect(
        errors(checkAtlas(atlas))
          .map((e) => e.message)
          .join('\n'),
        yaml,
      ).toMatch(message);
    }
    const atlas = join(tmp, 'atlas');
    writeFileSync(join(atlas, '.stack-atlas/atlas.yaml'), 'repo: { path: ../link }');
    expect(
      errors(checkAtlas(atlas))
        .map((e) => e.message)
        .join('\n'),
    ).toMatch(/シンボリックリンク/);
    // 2026-11-13 追加（レビュー 2）: repo が無いときの誤りは 1 件だけ（根拠ごと・申告ごとに重ねない）
    writeFileSync(join(atlas, '.stack-atlas/atlas.yaml'), 'repo: { path: ../nothing }');
    writeFileSync(join(atlas, '.stack-atlas/reading.yaml'), 'read: [{ path: a.txt, why: x }]');
    expect(errors(checkAtlas(atlas))).toHaveLength(1);
  });

  it('宣言した repo が git の作業ツリーの中でなければ、根拠を読まない（閉じる側に倒す。誤りは 1 件）', () => {
    const { tmp } = copy();
    const plain = join(tmp, 'plain');
    cpSync(APP, join(plain, 'app'), { recursive: true });
    const atlas = join(tmp, 'atlas');
    writeFileSync(join(atlas, '.stack-atlas/atlas.yaml'), 'repo: { path: ../plain }');
    const r = checkAtlas(atlas);
    expect(errors(r)).toHaveLength(1);
    expect(errors(r)[0]!.message).toContain('一覧を得られないので、根拠を読みません');
    expect(r.evidence!.found).toBe(0);
    // 解いた repo の場所を、出力の先頭に出す（人が、思っていない場所を指していないか気づけるように）
    expect(formatAtlasReport(r)).toContain(`repo: ${realpathSync(plain)}`);
  });

  it('git の作業ツリーの中なのに git が一覧を断る（.git がリンク）ときも、根拠を読まない', () => {
    const self = mkdtempSync(join(tmpdir(), 'stack-atlas-evidence-gitlink-'));
    cpSync(FIXTURE, self, { recursive: true });
    cpSync(APP, join(self, 'app'), { recursive: true });
    writeFileSync(join(self, '.stack-atlas/atlas.yaml'), '# 置き場そのものが repo\n');
    const real = mkdtempSync(join(tmpdir(), 'stack-atlas-evidence-gitdir-'));
    git(real, 'init', '-q');
    symlinkSync(join(real, '.git'), join(self, '.git'));
    const r = checkAtlas(self);
    expect(errors(r).map((e) => e.message)).toEqual([
      expect.stringContaining('一覧を得られないので、根拠を読みません'),
    ]);
  });

  it('複数の repo: 根拠のパスは "<repo の名前>/…"。表に無い repo は誤り', () => {
    const { report } = withFiles('repos: [{ name: web, path: ../repo }]');
    // 今の図の根拠は接頭辞が無いので、どれも「表に無い」
    expect(errors(report)).toHaveLength(24);
    expect(errors(report)[0]!.message).toContain('repo が、atlas.yaml の表にありません');
    const { tmp } = copy();
    const atlas = join(tmp, 'atlas');
    writeFileSync(join(atlas, '.stack-atlas/atlas.yaml'), 'repos: [{ name: web, path: ../repo }]');
    writeFileSync(
      join(atlas, GRAPH),
      readFileSync(join(atlas, GRAPH), 'utf8').replaceAll('file: app/', 'file: web/app/'),
    );
    expect(checkAtlas(atlas).issues).toEqual([]);
  });

  it('申告の形の誤り: 理由が無い・全部に近い所を指す・read にディレクトリ・** ・知らないキー', () => {
    const cases: Array<[string, RegExp]> = [
      ['skipped: [{ path: docs/ }]', /理由（why）がありません/],
      ['skipped: [{ path: "*", why: x }]', /全部か、それに近い所/],
      ['skipped: [{ path: "*/", why: x }]', /全部か、それに近い所/],
      ['skipped: [{ path: "./", why: x }]', /全部か、それに近い所/],
      ['skipped: [{ path: "a/**/b", why: x }]', /全部か、それに近い所/],
      ['read: [{ path: app/, why: x }]', /ファイル 1 つにしてください/],
      ['read: [{ path: "app/*.js", why: x }]', /ファイル 1 つにしてください/],
      ['seen: []', /知らないキー seen/],
    ];
    for (const [yaml, message] of cases) {
      const { report } = withFiles('repo: { path: ../repo }', yaml);
      expect(
        errors(report)
          .map((e) => e.message)
          .join('\n'),
        yaml,
      ).toMatch(message);
    }
  });
});

describe('未読（使い捨ての git の repo で）', () => {
  /** <tmp>/repo を git の repo にして、ファイルを足す */
  function gitRepo(files: Record<string, string>) {
    const { atlas, repo, track } = copy();
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), text);
    }
    track();
    return { atlas, repo };
  }

  it('最上位のディレクトリごとに数える。根拠・申告・秘密らしいものは除き、別に数える。追跡していないファイルは根拠に書けない', () => {
    const { atlas, repo } = gitRepo({
      'docs/a.md': '# a',
      'docs/b.md': '# b',
      'lib/x.txt': 'x',
      'README.md': 'r',
      '.env.example': 'X=1',
    });
    writeFileSync(
      join(atlas, '.stack-atlas/reading.yaml'),
      'skipped: [{ path: docs/, why: "文書" }]\n',
    );
    writeFileSync(join(repo, 'untracked.txt'), 'async function load()\n');
    let r = checkAtlas(atlas);
    expect(r.issues).toEqual([]);
    expect(r.unread![0]).toMatchObject({
      git: true,
      total: 7,
      evidenced: 2,
      declared: 2,
      secret: 1,
      unread: 2,
      files: ['README.md', 'lib/x.txt'],
    });
    expect(r.unread![0]!.dirs).toEqual([
      { dir: '.', total: 2, unread: 1 },
      { dir: 'lib/', total: 1, unread: 1 },
      { dir: 'app/', total: 2, unread: 0 },
      { dir: 'docs/', total: 2, unread: 0 },
    ]);
    expect(formatAtlasReport(r)).toContain(
      '未読: 2 / 7（28.6%。根拠に出てくる 2・申告で除いた 2・秘密らしいので読まない 1）',
    );
    // 追跡していないファイルは、根拠に書けない
    const g = readFileSync(join(atlas, GRAPH), 'utf8');
    writeFileSync(
      join(atlas, GRAPH),
      loadEvidence('untracked.txt', '[1, 1]', 'async function load()')(g),
    );
    r = checkAtlas(atlas);
    expect(errors(r).map((e) => e.message)).toEqual([
      expect.stringContaining('git が追跡していない'),
    ]);
  });

  it('申告の当たり方の警告: 何にも当たらない・半分を超える・根拠に出てくるファイルを skipped に書いた', () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`lib/f${i}.txt`, `${i}`]),
    );
    const { atlas } = gitRepo(files);
    writeFileSync(
      join(atlas, '.stack-atlas/reading.yaml'),
      [
        'skipped:',
        '  - { path: nothing/, why: "無い" }',
        '  - { path: lib/, why: "全部" }',
        '  - { path: app/sw.js, why: "読んでいない" }',
      ].join('\n'),
    );
    const r = checkAtlas(atlas);
    expect(warnings(r).map((w) => w.message)).toEqual([
      expect.stringContaining('どれにも当たりません'),
      expect.stringContaining('半分を超える 12 件'),
      expect.stringContaining('根拠に出てくるファイル（app/sw.js）'),
    ]);
  });

  it('git の repo でなければ、未読は数えない（知らせだけ）', () => {
    // 2026-11-13 変更（セキュリティのレビュー 1）: 宣言した repo は git が要るので、置き場そのものが repo の形で確かめる
    const atlas = mkdtempSync(join(tmpdir(), 'stack-atlas-evidence-plain-'));
    cpSync(FIXTURE, atlas, { recursive: true });
    cpSync(APP, join(atlas, 'app'), { recursive: true });
    writeFileSync(join(atlas, '.stack-atlas/atlas.yaml'), '# 置き場そのものが repo\n');
    const r = checkAtlas(atlas);
    expect(r.issues).toEqual([]);
    expect(r.unread![0]).toMatchObject({ git: false });
    expect(formatAtlasReport(r)).toContain('未読: 数えられません');
  });
});

describe('git を呼ぶときの守り（docs/28 D263。対象の repo は信用しない）', () => {
  const saved = { PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR };
  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.GIT_DIR === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.GIT_DIR;
  });

  it('repo の設定のコマンド（fsmonitor）・repo に置いた git・呼んだ側の GIT_DIR に動かされない', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stack-atlas-git-guard-'));
    const repo = join(tmp, 'repo');
    const other = join(tmp, 'other');
    for (const dir of [repo, other]) {
      mkdirSync(dir);
      git(dir, 'init', '-q');
    }
    writeFileSync(join(repo, 'a.txt'), 'a');
    writeFileSync(join(other, 'private.csv'), 'secret');
    git(repo, 'add', 'a.txt');
    git(other, 'add', 'private.csv');
    const marker = join(tmp, 'ran');
    // 1. repo の設定: fsmonitor にコマンドを書く
    git(repo, 'config', 'core.fsmonitor', `touch ${marker}-fsmonitor; false`);
    // 2. repo に置いた git（PATH に . が先にあると、repo で起動した子が拾う）
    writeFileSync(join(repo, 'git'), `#!/bin/sh\ntouch ${marker}-fake\nexit 1\n`);
    chmodSync(join(repo, 'git'), 0o755);
    process.env.PATH = ['.', '', saved.PATH].join(delimiter);
    // 3. 呼んだ側の GIT_DIR が、別の repo を指す
    process.env.GIT_DIR = join(other, '.git');
    const t = trackedRegularFiles(repo);
    expect(t).toMatchObject({ files: ['a.txt'] });
    expect(existsSync(`${marker}-fsmonitor`)).toBe(false);
    expect(existsSync(`${marker}-fake`)).toBe(false);
  });

  it('PATH の、repo の中の絶対パスの段（npm exec が足す node_modules/.bin）にある git も、実行しない', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stack-atlas-git-npm-'));
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', 'a.txt');
    const marker = join(tmp, 'ran');
    for (const dir of [join(repo, 'node_modules', '.bin'), join(repo, 'bin')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'git'), `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
      chmodSync(join(dir, 'git'), 0o755);
    }
    process.env.PATH = [join(repo, 'node_modules', '.bin'), join(repo, 'bin'), saved.PATH].join(
      delimiter,
    );
    expect(trackedRegularFiles(repo)).toMatchObject({ files: ['a.txt'] });
    expect(existsSync(marker)).toBe(false);
  });

  it('.git が別の repo を指すファイル（gitfile）なら、使わない', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stack-atlas-git-gitfile-'));
    const repo = join(tmp, 'repo');
    const other = join(tmp, 'other');
    mkdirSync(repo);
    mkdirSync(other);
    git(other, 'init', '-q');
    writeFileSync(join(other, 'private.csv'), 'secret');
    git(other, 'add', 'private.csv');
    writeFileSync(join(repo, '.git'), `gitdir: ${join(other, '.git')}\n`);
    expect(trackedRegularFiles(repo)).toHaveProperty('why');
  });
});

describe('道具は、言語を選ばない（docs/24。docs/28 の条件 6）', () => {
  it('根拠と未読の検査のコードに、特定の言語やフレームワークの名前が無い', () => {
    const names =
      /\b(React|Vue|Svelte|Angular|Next\.?js|Nuxt|TypeScript|JavaScript|Python|Java|Kotlin|Swift|PHP|Ruby|Rails|Laravel|Django|Flask|FastAPI|Spring|Express|WordPress|Golang|Rust|Terraform|SQL|GraphQL|JSX|TSX)\b/i;
    const src = readFileSync(
      fileURLToPath(new URL('../atlas/evidence.ts', import.meta.url)),
      'utf8',
    );
    expect(src.match(names)?.[0]).toBeUndefined();
  });
});
