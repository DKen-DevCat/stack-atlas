// 挙動を、見せるための段の列にする（Phase 10。docs/25 §3.5、docs/26 §4）。
// 入力は、試しでエージェントが書いた図をまとめた graph.json（packages/core の fixtures/atlas-live-agent を bundle したもの。
// 同じであることは、core の atlas-bundle.test.ts が確かめる）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateGraphV2, type BehaviorStepV2, type GraphV2 } from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import { behaviorView } from '../behavior-view.js';

const graph = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/atlas-live-agent.graph.json', import.meta.url)),
    'utf8',
  ),
) as GraphV2;

describe('behaviorView', () => {
  it('入力の graph は、契約の検証を通る', () => {
    expect(validateGraphV2(graph)).toMatchObject({ ok: true, errors: [] });
  });

  it('投稿する: 段ごとに、どの箱からどの箱へ、何を送り、何が返るか。深さは、奥を呼ぶと増え、戻ってから呼ぶと減る', () => {
    const v = behaviorView(graph, 'post-comment')!;
    expect(v.name).toBe('コメントを投稿する');
    expect(v.trigger).toMatchObject({
      action: 'submit',
      part: { id: 'comment-form', selector: '#comment-form' },
    });
    expect(v.result).toMatchObject({ part: { id: 'comment-list', selector: '#comments' } });
    expect(v.steps.map((s) => `${s.depth} ${s.from.id} → ${s.to.id} [${s.via}]`)).toEqual([
      '0 part:comment-form → endpoint:POST /api/comments [http]',
      '1 endpoint:POST /api/comments → table:comments [call]',
      '0 part:comment-form → fn:load [call]',
      '1 fn:load → endpoint:GET /api/comments [http]',
      '2 endpoint:GET /api/comments → table:comments [call]',
      '1 fn:load → fn:render [call]',
      '2 fn:render → part:status [render]',
      '2 fn:render → part:comment-list [render]',
    ]);
    expect(v.steps[0]).toMatchObject({ index: 0, send: ['comment'], back: ['body.comment'] });
    expect(v.steps[1]).toMatchObject({ send: ['row'], back: [] });
    expect(v.steps[2]!.say).toContain('load を呼ぶ');
    // 箱の根拠（ファイルと行）が付く
    expect(v.steps[0]!.from).toMatchObject({
      kind: 'component',
      runtime: 'browser',
      file: 'app/index.html',
      line: 33,
    });
  });

  it('画面の側から受け口へ出る通信の段だけ、メソッドとパスが付く（ライブが、実際の通信と照らす段）', () => {
    const requests = (id: string) =>
      behaviorView(graph, id)!.steps.flatMap((s) =>
        s.request ? [`${s.index}: ${s.request.method} ${s.request.path}`] : [],
      );
    expect(requests('open')).toEqual(['1: GET /api/comments']);
    expect(requests('post-comment')).toEqual(['0: POST /api/comments', '3: GET /api/comments']);
    expect(requests('delete-comment')).toEqual([
      '0: DELETE /api/comments/{id}',
      '3: GET /api/comments',
    ]);
  });

  it('1 つの段に送る線が 2 本あれば、送るものも 2 つ', () => {
    const v = behaviorView(graph, 'delete-comment')!;
    expect(v.steps[1]).toMatchObject({ send: ['id', 'その行を消す'], back: [] });
    expect(v.steps[0]!.back).toEqual(['204（中身なし）']);
  });

  it('開く: 始まりは画面の箱。部品は無い', () => {
    const v = behaviorView(graph, 'open')!;
    expect(v.trigger).toEqual({ action: 'open' });
    expect(v.steps[0]).toMatchObject({ depth: 0, from: { id: 'screen:/' }, to: { id: 'fn:load' } });
  });

  it('同時に呼ぶ所は、列ごとに番号が付き、どの列も分かれる前の深さから始まる', () => {
    const g = structuredClone(graph);
    const open = g.behaviors!.find((b) => b.id === 'open')!;
    const [first, second, third, ...rest] = open.steps as BehaviorStepV2[];
    open.steps = [first!, { parallel: [[second!, third!], rest] }];
    expect(validateGraphV2(g).ok).toBe(true);
    const v = behaviorView(g, 'open')!;
    expect(
      v.steps.map(
        (s) =>
          `${s.parallel ? `${s.parallel.group}/${s.parallel.lane}` : '-'} ${s.depth} ${s.to.id}`,
      ),
    ).toEqual([
      '- 0 fn:load',
      '0/0 1 endpoint:GET /api/comments',
      '0/0 2 table:comments',
      '0/1 1 fn:render',
      '0/1 2 part:status',
      '0/1 2 part:comment-list',
    ]);
  });

  it('無い挙動は undefined。解けない線の段は、分かる範囲で出す', () => {
    expect(behaviorView(graph, 'nope')).toBeUndefined();
    const g = structuredClone(graph);
    g.behaviors![0]!.steps = [{ send: [{ from: 'ghost:x#out/a', to: 'ghost:y#in/b' }] }];
    const v = behaviorView(g, g.behaviors![0]!.id)!;
    expect(v.steps[0]).toMatchObject({
      from: { id: 'ghost:x', kind: 'unknown' },
      send: ['a'],
      via: undefined,
    });
  });
});
