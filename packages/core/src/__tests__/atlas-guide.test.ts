// エージェントに渡す手順書（harness/guide/。Phase 10-1c。docs/25 §3.6）:
// 手順書の例が検査を通ること、手順書に特定の言語やフレームワークの名前が無いこと（docs/24 §4）、
// 手順書の例が、試しの対象（サンプルのアプリ）の答えを含まないこと
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAtlas, loadAtlas } from '../atlas/index.js';

const GUIDE_DIR = fileURLToPath(new URL('../../../../harness/guide/', import.meta.url));
const guide = readFileSync(GUIDE_DIR + 'GUIDE.md', 'utf8');
const exampleFiles = ['graph/list.yaml', 'parts.yaml', 'behaviors.yaml'].map((f) =>
  readFileSync(`${GUIDE_DIR}example/.stack-atlas/${f}`, 'utf8'),
);

describe('試しでエージェントが書いた図（fixtures/atlas-live-agent）', () => {
  // 手順書と例だけを渡したエージェントが書いたもの（docs/26 §8）。手を入れていない。契約を変えたら、ここが落ちる
  const AGENT = fileURLToPath(new URL('./fixtures/atlas-live-agent/', import.meta.url));

  it('エラーも警告も無く検査を通る', () => {
    const report = checkAtlas(AGENT);
    expect(report.issues).toEqual([]);
    expect(report.counts).toMatchObject({ nodes: 11, wires: 17, parts: 4, behaviors: 3 });
  });

  it('正解表（docs/26 §8.1）と合っている: 受け口 3・置き場 1・挙動 3・操作を受ける部品のセレクタ', () => {
    const { atlas } = loadAtlas(AGENT);
    const routes = atlas.nodes
      .filter((n) => n.kind === 'endpoint')
      .map((n) => (n.meta as { route?: string } | undefined)?.route)
      .sort();
    expect(routes).toEqual([
      'DELETE /api/comments/{id}',
      'GET /api/comments',
      'POST /api/comments',
    ]);
    expect(atlas.nodes.filter((n) => n.kind === 'table')).toHaveLength(1);
    expect(atlas.nodes.filter((n) => n.kind === 'screen')).toHaveLength(1);
    const triggers = atlas.behaviors.map(
      (b) => `${b.trigger.action} ${b.trigger.part ?? '(画面)'}`,
    );
    expect(triggers).toEqual(['open (画面)', 'submit comment-form', 'click delete-button']);
    const selector = (id: string) => atlas.parts.find((p) => p.id === id)?.selector;
    expect(selector('comment-form')).toBe('#comment-form');
    expect(selector('delete-button')).toBe('#comments button.del');
    expect(selector('comment-list')).toBe('#comments');
    // 投稿と削除のあとに、一覧を読み直す（どちらの挙動も、一覧を読む受け口を通る）
    for (const id of ['post-comment', 'delete-comment']) {
      const b = atlas.behaviors.find((x) => x.id === id)!;
      const sends = b.steps.flatMap((e) => ('send' in e ? e.send : []));
      expect(sends.some((w) => w.to.startsWith('endpoint:GET /api/comments#'))).toBe(true);
    }
  });
});

describe('手順書（harness/guide）', () => {
  it('例（example/）は、エラーも警告も無く検査を通る', () => {
    const report = checkAtlas(GUIDE_DIR + 'example');
    expect(report.issues).toEqual([]);
    expect(report.counts).toMatchObject({ nodes: 6, wires: 10, parts: 2, behaviors: 2 });
  });

  it('手順書の中の線・部品・挙動の例は、example/ にそのままある（手順書と例がずれない）', () => {
    const all = exampleFiles.join('\n');
    for (const line of [
      '{ from: "part:add-form#out/item", to: "endpoint:POST /items#in/body.item", via: http }',
      '{ from: "endpoint:POST /items#out/body.item", to: "part:add-form#in/saved", via: http, reply: true }',
      'trigger: { action: submit, part: add-form }',
      'send: [{ from: "endpoint:POST /items#req/row", to: "table:items#write/row" }]',
      'send: [{ from: "part:add-form#out/added", to: "part:item-list#in/item" }]',
      'selector: "form.add"',
    ]) {
      expect(guide, `手順書に無い: ${line}`).toContain(line);
      expect(all, `example/ に無い: ${line}`).toContain(line);
    }
  });

  it('特定の言語やフレームワークの名前を書いていない（道具は言語を選ばない）', () => {
    // 名前の一覧は、確かめの種。全部は挙げられないので、よく出るものだけ（条件 3 の確かめは docs/25 §5）
    const names =
      /\b(React|Vue|Svelte|Angular|Next\.?js|Nuxt|TypeScript|JavaScript|Python|Java|Kotlin|Swift|PHP|Ruby|Rails|Laravel|Django|Flask|FastAPI|Spring|Express|WordPress|Golang|Rust|Terraform|SQL|GraphQL|JSX|TSX)\b/i;
    for (const text of [guide, ...exampleFiles]) expect(text.match(names)?.[0]).toBeUndefined();
  });

  it('例は、試しの対象（サンプルのアプリ）の答えを含まない', () => {
    // エージェントに書かせる試し（10-1c）の対象は prototype/live/app。その受け口・部品の名前を、手順書と例に書かない
    for (const text of [guide, ...exampleFiles]) {
      expect(text).not.toContain('/api/comments');
      expect(text).not.toContain('comment-form');
      expect(text).not.toContain('button.del');
    }
  });
});
