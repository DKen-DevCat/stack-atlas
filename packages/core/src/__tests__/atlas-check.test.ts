// `.stack-atlas/` の図の検査（Phase 10-1a。docs/25 §3.4 の「形・参照・挙動」、docs/26）。
// 正解の図（サンプルのアプリ prototype/live/app を手で読んで書いたもの）が通ることと、
// わざと入れた誤り（無い線・つながらない段・合わない始まり・無い部品・宣言していない分岐など）を見つけることを確かめる
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAtlas, formatAtlasReport, loadAtlas, type AtlasReport } from '../atlas/index.js';

const ANSWER = fileURLToPath(new URL('./fixtures/atlas-live/', import.meta.url));
const GRAPH = '.stack-atlas/graph/app.yaml';
const PARTS = '.stack-atlas/parts.yaml';
const BEHAVIORS = '.stack-atlas/behaviors.yaml';

/** 正解の図を一時ディレクトリに写し、ファイルを書き換えてから検査する */
function withEdits(edits: Record<string, (text: string) => string> = {}): {
  root: string;
  report: AtlasReport;
} {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-check-'));
  cpSync(ANSWER, root, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) {
    const abs = join(root, file);
    const before = readFileSync(abs, 'utf8');
    const after = edit(before);
    expect(after, `${file} を書き換えられていない`).not.toBe(before);
    writeFileSync(abs, after);
  }
  return { root, report: checkAtlas(root) };
}
const swap = (a: string, b: string) => (text: string) => {
  expect(text.split(a).length - 1, `"${a}" が 1 か所だけにあること`).toBe(1);
  return text.replace(a, b);
};
const errors = (r: AtlasReport) => r.issues.filter((i) => i.level === 'error');
const messages = (r: AtlasReport) => errors(r).map((i) => i.message);

describe('checkAtlas: 正解の図', () => {
  it('エラーも警告も無い。箱・線・部品・挙動の数が出る', () => {
    const report = checkAtlas(ANSWER);
    expect(report.issues).toEqual([]);
    expect(report.counts).toEqual({
      nodes: 9,
      wires: 15,
      behaviors: 3,
      parts: 3,
      errors: 0,
      warnings: 0,
    });
    expect(report.files).toEqual([GRAPH, PARTS, BEHAVIORS]);
    expect(formatAtlasReport(report)).toBe(
      '図: 箱 9・線 15・部品 3・挙動 3（3 ファイル）\n検査（形・参照・挙動）: エラー 0 件、警告 0 件',
    );
  });
});

describe('checkAtlas: 挙動の誤りを見つける', () => {
  it('段の線が図に無い', () => {
    const { report } = withEdits({
      [BEHAVIORS]: swap(
        'send: [{ from: "endpoint:POST /api/comments#req/row", to: "table:comments#write/row" }]',
        'send: [{ from: "endpoint:POST /api/comments#req/row", to: "table:comments#write/rows" }]',
      ),
    });
    expect(errors(report)).toHaveLength(1);
    expect(errors(report)[0]).toMatchObject({
      check: 'behavior',
      file: BEHAVIORS,
      path: '挙動 "post-comment" の段 2',
    });
    expect(messages(report)[0]).toContain('図（.stack-atlas/graph/）にありません');
  });

  it('段がつながっていない（経路の上に無い箱から出ている）', () => {
    // 「投稿のあと、一覧を読み直す」（コメント欄 → load）を消すと、次の段（load → GET）が、ここまでの経路に無い箱から出る
    const { report } = withEdits({
      [BEHAVIORS]: swap(
        '      - send: [{ from: "part:comment-form#out/reload", to: "fn:load#in/call" }]\n        say: "投稿のあと、一覧を読み直す"\n',
        '',
      ),
    });
    expect(messages(report)).toEqual([
      '段がつながっていません: この段は "fn:load" から出ていますが、ここまでの経路（part:comment-form → endpoint:POST /api/comments → table:comments）に、その箱がありません',
    ]);
    expect(errors(report)[0]!.path).toBe('挙動 "post-comment" の段 3');
  });

  it('戻ってから次を呼ぶのは、つながっている（経路の手前の箱から出る段は通る）', () => {
    // 正解の図の post-comment は、コメント欄 → POST → 置き場 のあと、コメント欄 → load と続く
    expect(checkAtlas(ANSWER).counts.errors).toBe(0);
  });

  it('最初の段が、始まりの部品の箱から出ていない', () => {
    const { report } = withEdits({
      [BEHAVIORS]: swap(
        'trigger: { action: submit, part: comment-form }',
        'trigger: { action: submit, part: comment-delete }',
      ),
    });
    expect(messages(report)[0]).toBe(
      '最初の段は、始まり（"part:comment-delete"）から出る線にしてください。この段は "part:comment-form" から出ています',
    );
  });

  it('始まりの部品・result の部品が parts.yaml に無い', () => {
    const { report } = withEdits({
      [BEHAVIORS]: (t) =>
        swap(
          'trigger: { action: click, part: comment-delete }',
          'trigger: { action: click, part: nope }',
        )(
          swap(
            'result: { say: "コメントの一覧が出る。", part: comment-list }',
            'result: { say: "コメントの一覧が出る。", part: gone }',
          )(t),
        ),
    });
    expect(messages(report).sort()).toEqual([
      '挙動 "delete-comment" の始まりの部品 "nope" が、.stack-atlas/parts.yaml にありません',
      '挙動 "open" の result の部品 "gone" が、.stack-atlas/parts.yaml にありません',
    ]);
  });

  it('send に戻りの線がある・back が send の逆向きでない', () => {
    const { report } = withEdits({
      [BEHAVIORS]: swap(
        '      - send: [{ from: "part:comment-delete#out/id", to: "endpoint:DELETE /api/comments/{id}#in/id" }]\n        back: [{ from: "endpoint:DELETE /api/comments/{id}#out/status", to: "part:comment-delete#in/done" }]',
        '      - send: [{ from: "endpoint:DELETE /api/comments/{id}#out/status", to: "part:comment-delete#in/done" }]\n        back: [{ from: "table:comments#read/rows", to: "endpoint:GET /api/comments#res/rows" }]',
      ),
    });
    const m = messages(report);
    expect(m.some((x) => x.includes('send に、戻りの線（reply: true）'))).toBe(true);
  });

  it('back が send の逆向きでない', () => {
    const { report } = withEdits({
      [BEHAVIORS]: swap(
        '        back: [{ from: "endpoint:DELETE /api/comments/{id}#out/status", to: "part:comment-delete#in/done" }]',
        '        back: [{ from: "table:comments#read/rows", to: "endpoint:GET /api/comments#res/rows" }]',
      ),
    });
    expect(messages(report)).toContain(
      'back は、send の逆向き（"endpoint:DELETE /api/comments/{id}" から "part:comment-delete" へ）の線だけにしてください',
    );
  });

  it('分岐のキー: 箱が宣言していない・箱の名前が無い', () => {
    const undeclared = withEdits({
      [BEHAVIORS]: swap(
        '    trigger: { action: open }\n',
        '    trigger: { action: open }\n    when: { "screen:/#logged_in": true }\n',
      ),
    }).report;
    expect(messages(undeclared)).toEqual([
      'when のキー "screen:/#logged_in": 箱 "screen:/" は分岐 "logged_in" を宣言していません',
    ]);
    const bare = withEdits({
      [BEHAVIORS]: swap(
        '    trigger: { action: open }\n',
        '    trigger: { action: open }\n    when: { logged_in: true }\n',
      ),
    }).report;
    expect(messages(bare)).toEqual([
      'when のキー "logged_in" は "<箱 id>#<分岐 id>" で書いてください',
    ]);
    // 箱が宣言していれば通る
    const declared = withEdits({
      [BEHAVIORS]: swap(
        '    trigger: { action: open }\n',
        '    trigger: { action: open }\n    when: { "screen:/#logged_in": true }\n',
      ),
      [GRAPH]: swap(
        '    name: "記事の画面"\n    runtime: browser\n',
        '    name: "記事の画面"\n    runtime: browser\n    variants: [{ id: logged_in, name: "ログインしている" }]\n',
      ),
    }).report;
    expect(declared.counts.errors).toBe(0);
  });

  it('同時に呼ぶ（parallel）: どの列も、分かれる前の経路から始まる', () => {
    const lanes = (second: string) =>
      swap(
        '      - send: [{ from: "fn:load#out/render", to: "part:comment-list#in/comments" }]\n    result: { say: "コメントの一覧が出る。", part: comment-list }',
        `      - parallel:\n          - - send: [{ from: "fn:load#out/render", to: "part:comment-list#in/comments" }]\n          - - send: [${second}]\n    result: { say: "コメントの一覧が出る。", part: comment-list }`,
      );
    const ok = withEdits({
      [BEHAVIORS]: lanes(
        '{ from: "fn:load#out/request", to: "endpoint:GET /api/comments#in/request" }',
      ),
    }).report;
    expect(ok.counts.errors).toBe(0);
    const bad = withEdits({
      [BEHAVIORS]: lanes('{ from: "part:comment-form#out/reload", to: "fn:load#in/call" }'),
    }).report;
    expect(errors(bad)).toHaveLength(1);
    expect(errors(bad)[0]!.path).toBe('挙動 "open" の段 4 の列 2 の段 1');
    expect(messages(bad)[0]).toContain('段がつながっていません');
  });

  it('挙動の id の重複', () => {
    const { report } = withEdits({ [BEHAVIORS]: swap('  - id: delete-comment', '  - id: open') });
    expect(messages(report)).toEqual(['挙動の id "open" が重複しています']);
  });
});

describe('checkAtlas: 部品と、箱・線の誤りを見つける', () => {
  it('部品の box が無い・screen が画面の箱でない', () => {
    const { report } = withEdits({
      [PARTS]: (t) =>
        swap(
          '    box: "part:comment-list"',
          '    box: "part:nothing"',
        )(
          swap(
            '    box: "part:comment-delete"\n    screen: "screen:/"',
            '    box: "part:comment-delete"\n    screen: "fn:load"',
          )(t),
        ),
    });
    expect(messages(report).sort()).toEqual([
      '部品 "comment-delete" の screen "fn:load" は、画面の箱（kind: screen）ではありません（fn）',
      '部品 "comment-list" の box "part:nothing" の箱がありません',
    ]);
  });

  it('線の先の項目が無い: どのファイルの、どの線かが出る', () => {
    const { report } = withEdits({
      [GRAPH]: swap(
        '{ from: "fn:load#out/render", to: "part:comment-list#in/comments", via: render }',
        '{ from: "fn:load#out/render", to: "part:comment-list#in/items", via: render }',
      ),
    });
    const refs = errors(report).filter((i) => i.check === 'ref');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      file: GRAPH,
      path: '線 "fn:load#out/render" → "part:comment-list#in/items"/to',
    });
    // その線を通る挙動も、線が無いと言われる（3 つの挙動とも、最後に一覧へ描く）
    expect(errors(report).filter((i) => i.check === 'behavior')).toHaveLength(3);
  });

  it('箱の形が契約に合わない（runtime が無い）: 形の誤りとして、どの箱かが出る', () => {
    const { report } = withEdits({
      [GRAPH]: swap('    name: load\n    runtime: browser\n', '    name: load\n'),
    });
    const form = errors(report).filter((i) => i.check === 'form');
    expect(form.length).toBeGreaterThan(0);
    expect(form[0]).toMatchObject({ file: GRAPH });
    expect(form[0]!.path).toContain('箱 "fn:load"');
  });
});

describe('checkAtlas: ファイルの形と、読みの守り', () => {
  it('YAML として読めない', () => {
    const { report } = withEdits({ [BEHAVIORS]: (t) => t + '\n  - id: [unclosed\n' });
    expect(errors(report)[0]).toMatchObject({ check: 'form', file: BEHAVIORS });
    expect(messages(report)[0]).toContain('YAML として読めません');
  });

  it('挙動の形: action の語彙・open に part・空の steps', () => {
    const bad = (from: string, to: string) =>
      messages(withEdits({ [BEHAVIORS]: swap(from, to) }).report)[0];
    expect(
      bad(
        'trigger: { action: click, part: comment-delete }',
        'trigger: { action: tap, part: comment-delete }',
      ),
    ).toContain('trigger は { action: open | click | submit | input | change');
    expect(bad('trigger: { action: open }', 'trigger: { action: open, part: comment-form }')).toBe(
      'action が open のとき、part は書きません（画面を開くことが始まりです）',
    );
    expect(
      bad('trigger: { action: submit, part: comment-form }', 'trigger: { action: submit }'),
    ).toBe('action が submit のとき、part（部品の id）が要ります');
  });

  it('シンボリックリンクのファイルは読まない', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-check-'));
    cpSync(ANSWER, root, { recursive: true });
    renameSync(join(root, BEHAVIORS), join(root, 'elsewhere.yaml'));
    symlinkSync(join(root, 'elsewhere.yaml'), join(root, BEHAVIORS));
    const report = checkAtlas(root);
    expect(messages(report)).toEqual([
      '.stack-atlas/behaviors.yaml がシンボリックリンクなので読みません',
    ]);
    expect(report.counts.behaviors).toBe(0);
  });

  it('graph/ が無い・*.yaml が無い・古い形（*.v2.yaml）は読まない', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stack-atlas-check-'));
    expect(messages(checkAtlas(empty))[0]).toContain('.stack-atlas/graph/ がありません');

    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-check-'));
    cpSync(ANSWER, root, { recursive: true });
    renameSync(join(root, GRAPH), join(root, '.stack-atlas/graph/app.v2.yaml'));
    const report = checkAtlas(root);
    expect(messages(report)).toContain('.stack-atlas/graph/ に *.yaml がありません');
    expect(
      report.issues.some(
        (i) => i.level === 'warning' && i.message.includes('古い形のファイルなので読みません'),
      ),
    ).toBe(true);
    expect(report.counts.nodes).toBe(0);
  });

  it('behaviors.yaml が無ければ、警告（箱と線だけでも検査できる）', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-check-'));
    cpSync(ANSWER, root, { recursive: true });
    renameSync(join(root, BEHAVIORS), join(root, 'away.yaml'));
    const report = checkAtlas(root);
    expect(report.counts.errors).toBe(0);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ level: 'warning', check: 'behavior' });
  });
});

// コードレビュー（10-1a。PR を作る前に 1 回）で見つかったことを、事実のまま固定する
describe('checkAtlas: レビューで見つかったこと', () => {
  /** 正解の図を写し、ファイルを足す・書き換える・消す（値が null なら消す） */
  const withFiles = (
    files: Record<string, string | null>,
    edits: Parameters<typeof withEdits>[0] = {},
  ) => {
    const { root } = withEdits(edits);
    for (const [file, content] of Object.entries(files)) {
      if (content === null) rmSync(join(root, file));
      else writeFileSync(join(root, file), content);
    }
    return { root, report: checkAtlas(root) };
  };

  it('1 つの誤りで、後ろの正しい段に指摘を重ねない（段の線の打ち間違い）', () => {
    // 最初の段の線を打ち間違えても、後ろの段（どれも正しい）に「つながっていません」は出ない
    const { report } = withEdits({
      [BEHAVIORS]: swap(
        'send: [{ from: "part:comment-form#out/comment", to: "endpoint:POST /api/comments#in/body.comment" }]',
        'send: [{ from: "part:comment-form#out/comment", to: "endpoint:POST /api/comments#in/body.commentx" }]',
      ),
    });
    expect(messages(report)).toHaveLength(1);
    expect(messages(report)[0]).toContain('図（.stack-atlas/graph/）にありません');
  });

  it('形の違う箱が 1 つあっても、ほかの箱・線の参照の検査は止まらない', () => {
    const { report } = withEdits({
      [GRAPH]: (t) =>
        swap(
          '    name: load\n    runtime: browser\n',
          '    name: load\n',
        )(
          swap(
            '{ from: "endpoint:DELETE /api/comments/{id}#req/id", to: "table:comments#key/id", via: call }',
            '{ from: "endpoint:DELETE /api/comments/{id}#req/id", to: "table:comments#key/nothing", via: call }',
          )(t),
        ),
    });
    const form = errors(report).filter((i) => i.check === 'form');
    expect(form.every((i) => i.path?.startsWith('箱 "fn:load"'))).toBe(true);
    expect(form.length).toBeGreaterThan(0);
    // 形の誤り（fn:load）と同じ回に、別の線の行き先が無いことも出る
    expect(
      errors(report).some(
        (i) =>
          i.check === 'ref' &&
          i.path?.includes('"table:comments#key/nothing"') &&
          i.message.includes('終点'),
      ),
    ).toBe(true);
    // 形の違う箱は捨てるので、数に入らない
    expect(report.counts.nodes).toBe(8);
  });

  it('検証器が誤りにした線は、「図にある線」として扱わない（行き先の無い線を通る段は、線が無いと言われる）', () => {
    const { report } = withEdits({
      [GRAPH]: swap(
        '{ from: "endpoint:DELETE /api/comments/{id}#req/id", to: "table:comments#key/id", via: call }',
        '{ from: "endpoint:DELETE /api/comments/{id}#req/id", to: "table:comments#key/nothing", via: call }',
      ),
      [BEHAVIORS]: swap(
        'send: [{ from: "endpoint:DELETE /api/comments/{id}#req/id", to: "table:comments#key/id" }]',
        'send: [{ from: "endpoint:DELETE /api/comments/{id}#req/id", to: "table:comments#key/nothing" }]',
      ),
    });
    expect(errors(report).filter((i) => i.check === 'behavior')).toHaveLength(1);
    expect(errors(report).filter((i) => i.check === 'ref')).toHaveLength(1);
  });

  it('同じ両端の線を 2 度書いても、挙動の側に偽の指摘は出ない（重複の指摘だけ）', () => {
    const { report } = withEdits({
      [GRAPH]: (t) =>
        t +
        '  - { from: "part:comment-form#out/comment", to: "endpoint:POST /api/comments#in/body.comment", via: http, reply: true }\n',
    });
    expect(messages(report)).toHaveLength(1);
    expect(messages(report)[0]).toContain('重複しています');
  });

  it('箱 id の # は誤り（項目の参照と、分岐のキーで解けなくなる）', () => {
    const { report } = withEdits({
      [GRAPH]: swap('  - id: "part:comment-list"', '  - id: "part:comment#list"'),
    });
    // 契約のスキーマが、箱 id の形で断る（その箱は捨てられ、形の誤りとして出る）
    expect(
      errors(report).some(
        (i) => i.check === 'form' && i.path === '箱 "part:comment#list"/id' && i.file === GRAPH,
      ),
    ).toBe(true);
    expect(report.counts.nodes).toBe(8);
  });

  it('知らないキーは誤り（back の打ち間違いで、返りの線が黙って消えない）', () => {
    const typo = withEdits({
      [BEHAVIORS]: swap(
        '        back: [{ from: "endpoint:DELETE /api/comments/{id}#out/status", to: "part:comment-delete#in/done" }]',
        '        bak: [{ from: "endpoint:DELETE /api/comments/{id}#out/status", to: "part:comment-delete#in/done" }]',
      ),
    }).report;
    expect(messages(typo)).toEqual([
      '段に、知らないキー bak があります（書けるのは send, back, say, when）',
    ]);
    expect(typo.counts.behaviors).toBe(2); // その挙動は読まない

    const mixed = withEdits({
      [BEHAVIORS]: swap(
        '      - send: [{ from: "fn:load#out/render", to: "part:comment-list#in/comments" }]\n    result: { say: "コメントの一覧が出る。", part: comment-list }',
        '      - parallel: [[{ send: [{ from: "a#out/x", to: "b#in/x" }] }], [{ send: [{ from: "a#out/x", to: "c#in/x" }] }]]\n        send: [{ from: "fn:load#out/render", to: "part:comment-list#in/comments" }]\n    result: { say: "コメントの一覧が出る。", part: comment-list }',
      ),
    }).report;
    expect(messages(mixed)[0]).toContain(
      '同時に呼ぶ所（parallel）に、知らないキー send があります',
    );

    const part = withEdits({
      [PARTS]: swap('    selector: "#comments"', '    selector: "#comments"\n    selecter: "x"'),
    }).report;
    expect(messages(part).some((m) => m.includes('部品に、知らないキー selecter があります'))).toBe(
      true,
    );

    const topLevel = withEdits({ [GRAPH]: swap('\nwires:\n', '\nwire: []\nwires:\n') }).report;
    expect(messages(topLevel)[0]).toContain('トップレベルに、知らないキー wire があります');
  });

  it('behaviors.yaml が「あるが読めない」ときは、「ありません」と言わない', () => {
    const { report } = withEdits({ [BEHAVIORS]: (t) => t + '\n  - id: [unclosed\n' });
    expect(report.issues.filter((i) => i.file === BEHAVIORS)).toHaveLength(1);
    expect(report.issues.some((i) => i.message.includes('がありません'))).toBe(false);
  });

  it('名前の似たファイル（*.yml）は、読まずに名指しで誤りにする。parts.yaml が無ければ警告', () => {
    const { report } = withFiles({
      '.stack-atlas/graph/api.yml': 'nodes: []\n',
      '.stack-atlas/parts.yml': 'parts: []\n',
      '.stack-atlas/behaviors.yml': 'behaviors: []\n',
    });
    expect(messages(report).sort()).toEqual([
      '*.yml（api.yml）は読みません。*.yaml という名前にしてください',
      'behaviors.yml は読みません。behaviors.yaml という名前にしてください',
      'parts.yml は読みません。parts.yaml という名前にしてください',
    ]);

    const noParts = withFiles({ [PARTS]: null, [BEHAVIORS]: null }).report;
    expect(noParts.counts.errors).toBe(0);
    expect(noParts.issues.map((i) => i.file).sort()).toEqual([BEHAVIORS, PARTS]);
    expect(noParts.issues.every((i) => i.level === 'warning')).toBe(true);
  });

  it('型の指摘にも、どのファイルの、どの型かが出る', () => {
    const { report } = withFiles(
      { '.stack-atlas/graph/more.yaml': 'types:\n  - { id: "type:Comment", name: Comment }\n' },
      { [GRAPH]: (t) => t + 'types:\n  - { id: "type:Comment", name: Comment }\n' },
    );
    expect(errors(report)).toHaveLength(1);
    expect(errors(report)[0]).toMatchObject({
      file: '.stack-atlas/graph/more.yaml',
      path: '型 "type:Comment"/id',
    });
  });

  it('loadAtlas が返す箱・線は、形の検査を通ったものだけ（生の値を型だけ付けて返さない）', () => {
    const { root } = withFiles({
      '.stack-atlas/graph/app.yaml':
        'nodes:\n  - null\n  - "x"\n  - { id: "screen:/", kind: screen, name: s, runtime: browser, ports: [] }\nwires:\n  - 3\n',
    });
    const { atlas, issues } = loadAtlas(root);
    expect(atlas.nodes.map((n) => n.id)).toEqual(['screen:/']);
    expect(atlas.wires).toEqual([]);
    expect(issues.filter((i) => i.file === GRAPH).map((i) => i.path?.split('/')[0])).toEqual([
      '箱 1 番め',
      '箱 2 番め',
      '線 1 番め',
    ]);
  });
});
