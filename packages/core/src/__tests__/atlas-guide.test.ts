// エージェントに渡す手順書（harness/guide/。Phase 10-1c。docs/25 §3.6）:
// 手順書の例が検査を通ること、手順書に特定の言語やフレームワークの名前が無いこと（docs/24 §4）、
// 手順書の例が、試しの対象（サンプルのアプリ）の答えを含まないこと
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAtlas } from '../atlas/index.js';

const GUIDE_DIR = fileURLToPath(new URL('../../../../harness/guide/', import.meta.url));
const guide = readFileSync(GUIDE_DIR + 'GUIDE.md', 'utf8');
const exampleFiles = ['graph/list.yaml', 'parts.yaml', 'behaviors.yaml'].map((f) =>
  readFileSync(`${GUIDE_DIR}example/.stack-atlas/${f}`, 'utf8'),
);

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
