/**
 * route 側: server component の `fetch(url, { cache, next: { revalidate, tags } })`。
 * nextjs-app が route segment config（revalidate / dynamic）から cache を作っていればそちらが優先（ここでは触らない）。
 */
import type { Cache, CacheRule } from '@stack-atlas/schema';
import { Node } from 'ts-morph';
import { literalText, numberValue, objectProps, parseSource, stringValue } from './ast.js';

export interface FetchCall {
  /** 第 1 引数（表示用） */
  target: string;
  cache?: string;
  revalidate?: number | false;
  tags?: string[];
  line: number;
}

/** オプション付きの fetch 呼び出し（cache か next.revalidate / next.tags のあるものだけ） */
export function findFetchCalls(fileName: string, text: string): FetchCall[] {
  if (!/\bfetch\s*\(/.test(text)) return [];
  const sf = parseSource(fileName, text);
  const out: FetchCall[] = [];
  sf.forEachDescendant((n) => {
    if (!Node.isCallExpression(n) || n.getExpression().getText() !== 'fetch') return;
    const [url, opts] = n.getArguments();
    if (!url || !opts || !Node.isObjectLiteralExpression(opts)) return;
    const props = objectProps(opts);
    const call: FetchCall = { target: literalText(url), line: n.getStartLineNumber() };
    const cache = props.get('cache');
    if (cache) call.cache = stringValue(cache) ?? literalText(cache);
    const next = props.get('next');
    if (next && Node.isObjectLiteralExpression(next)) {
      const np = objectProps(next);
      const r = np.get('revalidate');
      if (r) {
        if (r.getText() === 'false') call.revalidate = false;
        else {
          const v = numberValue(r);
          if (v !== undefined) call.revalidate = v;
        }
      }
      const tags = np.get('tags');
      if (tags && Node.isArrayLiteralExpression(tags))
        call.tags = tags.getElements().map((e) => stringValue(e) ?? literalText(e));
    }
    if (call.cache !== undefined || call.revalidate !== undefined || call.tags) out.push(call);
  });
  return out;
}

function describe(c: FetchCall): string {
  const parts: string[] = [];
  if (c.revalidate === false) parts.push('revalidate なし（無期限）');
  else if (c.revalidate === 0) parts.push('revalidate 0（毎回）');
  else if (c.revalidate !== undefined) parts.push(`revalidate ${c.revalidate}s`);
  if (c.tags?.length) parts.push(`tags ${c.tags.join(', ')}`);
  if (c.cache) parts.push(`cache: ${c.cache}`);
  return parts.join(' / ');
}

/** route の fetch 呼び出しから cache を作る。無ければ undefined */
export function routeFetchCache(calls: FetchCall[]): Cache | undefined {
  if (!calls.length) return undefined;
  const rules: CacheRule[] = calls.map((c) => ({ key: `fetch ${c.target}`, value: describe(c) }));
  const noStore = calls.some((c) => c.cache === 'no-store' || c.revalidate === 0);
  const secs = calls
    .map((c) => c.revalidate)
    .filter((r): r is number => typeof r === 'number' && r > 0);
  if (noStore)
    return {
      tone: 'off',
      badge: 'fetch no-store',
      rules,
      note: 'no-store / revalidate 0 の fetch があるため、このルートは動的レンダリングになる',
    };
  if (secs.length) return { tone: 'info', badge: `fetch ${Math.min(...secs)}s`, rules };
  return { tone: 'info', badge: 'fetch cache', rules };
}
