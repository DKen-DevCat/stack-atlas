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
    expect(
      v.steps.map((s) => `${s.depth} ${s.from.id} → ${s.to.id} [${s.vias.join('+')}]`),
    ).toEqual([
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
      vias: [],
    });
  });

  // ここから下は、PR を作る前のコードレビュー（docs/26 §9）で見つかったこと
  it('分岐（when）は、挙動のものも、段のものも、そのまま出る', () => {
    const g = structuredClone(graph);
    const post = g.behaviors!.find((b) => b.id === 'post-comment')!;
    (post.steps[0] as BehaviorStepV2).when = { 'part:comment-form#filled': true };
    const v = behaviorView(g, 'post-comment')!;
    expect(v.when).toEqual({ 'part:comment-form#filled': true });
    expect(v.steps[0]!.when).toEqual({ 'part:comment-form#filled': true });
    expect(v.steps[1]).not.toHaveProperty('when');
    expect(behaviorView(g, 'open')).not.toHaveProperty('when');
  });

  it('受け口の meta.route は、文字列でも { method, path } でも読む。メソッドの無いものは、照らす相手にしない', () => {
    const requestOf = (route: unknown) => {
      const g = structuredClone(graph);
      g.nodes.find((n) => n.id === 'endpoint:POST /api/comments')!.meta = { route };
      return behaviorView(g, 'post-comment')!.steps[0]!.request;
    };
    expect(requestOf('post /api/comments')).toEqual({ method: 'POST', path: '/api/comments' });
    expect(requestOf({ method: 'post', path: '/api/comments' })).toEqual({
      method: 'POST',
      path: '/api/comments',
    });
    for (const route of ['/api/comments', { path: '/api/comments' }, { method: 'POST' }, 7, null])
      expect(requestOf(route), JSON.stringify(route)).toBeUndefined();
  });

  it('送る線が 2 本ある段は、線を書く順を入れ替えても、同じ結果になる（運び方・通信の相手を、先頭の線だけで決めない）', () => {
    const g = structuredClone(graph);
    // 削除の 1 段めに、通信（http）ではない線を 1 本足す
    const extra = {
      from: 'part:delete-button#out/reload',
      to: 'endpoint:DELETE /api/comments/{id}#in/id',
    };
    g.wires.push({ ...extra, via: 'call' });
    const first = g.behaviors!.find((b) => b.id === 'delete-comment')!.steps[0] as BehaviorStepV2;
    const http = first.send[0]!;
    const views = [
      [http, extra],
      [extra, http],
    ].map((send) => {
      first.send = send;
      expect(validateGraphV2(g).ok).toBe(true);
      return behaviorView(g, 'delete-comment')!.steps[0]!;
    });
    for (const v of views) {
      expect(v.vias).toEqual(['call', 'http']);
      expect(v.request).toEqual({ method: 'DELETE', path: '/api/comments/{id}' });
      expect(v).toMatchObject({
        from: { id: 'part:delete-button' },
        to: { id: 'endpoint:DELETE /api/comments/{id}' },
      });
    }
    expect([...views[0]!.send].sort()).toEqual([...views[1]!.send].sort());
  });

  it('始まりの部品が別の画面の部品でも、その部品（と、その画面）が出る（ビューアは、部品の screen を見て、光らせる画面を決める）', () => {
    const g = structuredClone(graph);
    g.nodes.push({
      id: 'screen:/other',
      kind: 'screen',
      name: '別の画面',
      runtime: 'browser',
      ports: [],
    });
    g.parts!.find((p) => p.id === 'comment-form')!.screen = 'screen:/other';
    expect(validateGraphV2(g).ok).toBe(true);
    const v = behaviorView(g, 'post-comment')!;
    expect(v.screen).toBe('screen:/');
    expect(v.trigger.part).toMatchObject({ id: 'comment-form', screen: 'screen:/other' });
  });

  it('深さは、検査と同じ決まり（advancePath）で進む: 検査を通る挙動は、どの段も、ここまでの経路の上から出る', () => {
    for (const b of graph.behaviors!) {
      const v = behaviorView(graph, b.id)!;
      const path: string[] = [v.steps[0]!.from.id];
      for (const s of v.steps) {
        expect(path[s.depth], `${b.id} の段 ${s.index}`).toBe(s.from.id);
        path.length = s.depth + 1;
        path.push(s.to.id);
      }
    }
  });
});
