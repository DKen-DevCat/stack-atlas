/**
 * hook 側: SWR / React Query の呼び出しとオプションから cache を作る。
 */
import type { Cache, CacheRule } from '@stack-atlas/schema';
import { Node, type CallExpression, type ObjectLiteralExpression, type SourceFile } from 'ts-morph';
import { formatMs, literalText, numberValue, objectProps, parseSource, shortMs } from './ast.js';

type Lib = 'SWR' | 'React Query';

interface Callee {
  lib: Lib;
  /** 呼び出しの種類（バッジの補足） */
  variant?: 'infinite' | 'immutable';
}

/** import 元モジュール → default import の意味 */
const DEFAULT_IMPORTS: Record<string, Callee> = {
  swr: { lib: 'SWR' },
  'swr/infinite': { lib: 'SWR', variant: 'infinite' },
  'swr/immutable': { lib: 'SWR', variant: 'immutable' },
};

/** 名前付き import / 既定の名前 */
const NAMED: Record<string, Callee> = {
  useSWR: { lib: 'SWR' },
  useSWRInfinite: { lib: 'SWR', variant: 'infinite' },
  useSWRImmutable: { lib: 'SWR', variant: 'immutable' },
  useQuery: { lib: 'React Query' },
  useSuspenseQuery: { lib: 'React Query' },
  useInfiniteQuery: { lib: 'React Query', variant: 'infinite' },
  useSuspenseInfiniteQuery: { lib: 'React Query', variant: 'infinite' },
};

const RQ_MODULES = new Set(['@tanstack/react-query', 'react-query']);

/** ミリ秒で書くオプション */
const MS_OPTIONS = new Set([
  'dedupingInterval',
  'refreshInterval',
  'focusThrottleInterval',
  'loadingTimeout',
  'errorRetryInterval',
  'staleTime',
  'gcTime',
  'cacheTime',
  'refetchInterval',
]);

/** 拾うオプション（この順で rules に並べる） */
const OPTIONS: Record<Lib, string[]> = {
  SWR: [
    'dedupingInterval',
    'revalidateOnFocus',
    'revalidateOnReconnect',
    'revalidateOnMount',
    'revalidateIfStale',
    'refreshInterval',
    'refreshWhenHidden',
    'focusThrottleInterval',
    'keepPreviousData',
    'fallbackData',
  ],
  'React Query': [
    'staleTime',
    'gcTime',
    'cacheTime',
    'refetchOnWindowFocus',
    'refetchOnReconnect',
    'refetchOnMount',
    'refetchInterval',
    'placeholderData',
    'initialData',
  ],
};

/** 無ければ「なし」と書くポーリング系のオプション */
const POLLING: Record<Lib, string> = { SWR: 'refreshInterval', 'React Query': 'refetchInterval' };

export interface FetchHookCall {
  lib: Lib;
  callee: string;
  variant?: Callee['variant'];
  /** オプション名 → 値の式 */
  options: Map<string, Node>;
  line: number;
}

/** ファイル内の import から、呼び出し名 → Callee の表を作る */
function calleeTable(sf: SourceFile): Map<string, Callee> {
  const table = new Map<string, Callee>(Object.entries(NAMED));
  for (const imp of sf.getImportDeclarations()) {
    const mod = imp.getModuleSpecifierValue();
    const def = imp.getDefaultImport();
    if (def && DEFAULT_IMPORTS[mod]) table.set(def.getText(), DEFAULT_IMPORTS[mod]);
    for (const ni of imp.getNamedImports()) {
      const orig = ni.getName();
      const local = ni.getAliasNode()?.getText() ?? orig;
      const known = NAMED[orig];
      if (known && (mod.startsWith('swr') || RQ_MODULES.has(mod))) table.set(local, known);
    }
  }
  return table;
}

/** 呼び出しのオプションのオブジェクト（SWR は第 3 引数、React Query v5 は唯一の引数、v3/v4 は最後の引数） */
function optionsObject(call: CallExpression, lib: Lib): ObjectLiteralExpression | undefined {
  const args = call.getArguments();
  const pick = lib === 'SWR' ? args[2] : args.at(-1);
  return pick && Node.isObjectLiteralExpression(pick) ? pick : undefined;
}

/** exportName の関数（宣言・const）を探す。無ければファイル全体 */
function scopeOf(sf: SourceFile, exportName?: string): Node {
  if (!exportName) return sf;
  const fn = sf.getFunction(exportName);
  if (fn) return fn;
  const v = sf.getVariableDeclaration(exportName);
  if (v) return v;
  return sf;
}

/** ファイル（の exportName の関数）にある SWR / React Query の呼び出し */
export function findFetchHookCalls(
  fileName: string,
  text: string,
  exportName?: string,
): FetchHookCall[] {
  if (!/use(SWR|Query|InfiniteQuery|SuspenseQuery)|from\s+['"]swr/.test(text)) return [];
  const sf = parseSource(fileName, text);
  const table = calleeTable(sf);
  const out: FetchHookCall[] = [];
  scopeOf(sf, exportName).forEachDescendant((n) => {
    if (!Node.isCallExpression(n)) return;
    const name = n.getExpression().getText();
    const callee = table.get(name);
    if (!callee) return;
    const obj = optionsObject(n, callee.lib);
    out.push({
      lib: callee.lib,
      callee: name,
      variant: callee.variant,
      options: obj ? objectProps(obj) : new Map(),
      line: n.getStartLineNumber(),
    });
  });
  return out;
}

function optionValue(key: string, n: Node): string {
  const v = numberValue(n);
  if (v !== undefined && MS_OPTIONS.has(key)) {
    if (v === 0 && (key === 'refreshInterval' || key === 'refetchInterval')) return 'なし';
    return formatMs(v);
  }
  return literalText(n);
}

/** 呼び出し（ファイル内の最初のもの）から cache を作る。呼び出しが無ければ undefined */
export function hookCache(calls: FetchHookCall[]): Cache | undefined {
  const first = calls[0];
  if (!first) return undefined;
  const { lib } = first;
  const rules: CacheRule[] = [];
  for (const key of OPTIONS[lib]) {
    const n = first.options.get(key);
    if (n) rules.push({ key, value: optionValue(key, n) });
  }
  const poll = POLLING[lib];
  if (!first.options.has(poll)) rules.push({ key: poll, value: 'なし' });

  const msKey = lib === 'SWR' ? 'dedupingInterval' : 'staleTime';
  const ms = first.options.get(msKey);
  const msValue = ms ? numberValue(ms) : undefined;
  let badge: string = lib;
  if (first.variant === 'immutable') badge += ' immutable';
  else if (first.variant === 'infinite') badge += ' infinite';
  if (msValue !== undefined)
    badge += lib === 'SWR' ? ` ${shortMs(msValue)}` : ` stale ${shortMs(msValue)}`;

  const cache: Cache = { tone: 'ok', badge, rules };
  const notes: string[] = [];
  if (calls.length > 1)
    notes.push(
      `${first.callee} などを ${calls.length} 回呼んでいる（表示は ${first.line} 行目の 1 つ目）`,
    );
  if (lib === 'React Query' && msValue === undefined)
    notes.push(
      'staleTime 未指定（既定 0 = 取得直後から stale。フォーカスやマウントのたびに再取得）',
    );
  if (notes.length) cache.note = notes.join('\n');
  return cache;
}
