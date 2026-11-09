/**
 * 箱の口・項目・links と、同じ言語の中の線（docs/17 §3.2・§7 #2・#3、docs/16 §5）。
 *
 * 口と項目:
 * - in: 引数（分割代入の props・引数はフィールドに展開。repo の外で宣言されたプロパティ — React の DOM の属性など — と
 *   上限で切ったものは不透明な 1 項目 `props` にまとめる。2026-11-09 レビュー C3）。引数の無い関数は `call`（name `()`、type void）、props の無い
 *   部品は `props`、画面は `html`（配信の線が着く）。呼び出しの戻りは `ret_<n>`（`checker.getResolvedSignature` の
 *   戻り型。Promise は剥がす）
 * - out: 呼び出しごとに `call_<n>`（子は呼び先の引数名。分割代入の引数はフィールド）、部品の描画は `render_<n>`
 *   （子は渡す props）、関数・hook の戻り値は `return`。番号は出現位置の順
 * - HTTP の呼び出し（パスがリテラルか定数のテンプレート）は、クライアントの呼び出しだけ（2026-11-09 レビュー C4）:
 *   `fetch`、api.callers、api-link が検出したラッパー（呼び先の宣言が repo の中）、api-link のクライアントファイルの
 *   中の既知の動詞（get・post など）。パスより後ろの引数に関数（ハンドラ）を渡すもの（`app.get('/x', handler)`）は
 *   サーバーのルートの登録なので呼び出しにしない。
 *   `call_<n>` に `meta.http = { method, path }`、子に `meta.http`（`path` / `query` / `body`）。path の子は呼び先の
 *   引数名、body は `JSON.stringify(x)` を剥がした x の型、query はパスの `?k=${v}` の v。子の optional は実引数から
 *   決める（呼び先の `init?` を写さない）。endpoint への線は合流の段（core の join.ts）が引く
 *
 * 線（同じ言語の中）: `call_n.<引数> → 呼び先#in/<引数>`（via call）、`呼び先#out/return → ret_n`（via return、reply）、
 * `render_n.<prop> → 子#in/<prop>`（via render）。引数の無い呼び出しは呼び先の `in/call`、props の無い描画は `in/props`
 * （無ければ呼び先に足す）。最も粗い単位で引く（D41: 受ける側の子が送る側の子に名前で全部写るなら親 1 本）。
 * 呼び出しでも描画でもない参照（コールバック渡し・定数・同じファイルの非 export の宣言を経由するもの）は、ts-imports と
 * 同じ相手へ箱の単位の線（`out/_ → in/_`）を引く（D53。upgrade の線を関数の単位で置き換える）
 *
 * links（箱の中）:
 * - exact: return 式・呼び出しの引数・JSX の props の式が参照する引数（プロパティのたどりは項目のパスに）、呼び出しの
 *   戻り（`ret_n`。`.then((t) => …)` の t と `await` を含む）
 * - crude: ローカル変数・useState（setter に渡した式）を経由するもの
 * - 起動の links（§7 #3）: データ由来の link が無い `call_n` / `render_n` / `return` へ、起動の項目（`call` / `props` /
 *   `html`、無ければ引数の全部）から crude
 */
import { Node, ts, type CallExpression, type SourceFile } from 'ts-morph';
import type { ItemV2, LinkV2, WireV2, WireVia } from '@stack-atlas/schema';
import {
  httpCallInfo,
  passesParam,
  type ConstResolver,
  type HttpCallInfo,
  type Wrapper,
} from '@stack-atlas/extractor-api-link';
import { localDeclarations } from '@stack-atlas/extractor-ts-imports';
import { itemId, UNDERSCORE, underscoreItem } from '@stack-atlas/core';
import type { Box } from './boxes.js';
import {
  countItems,
  makeItem,
  namedRef,
  splitProps,
  stripNullish,
  typeText,
  uniqueId,
  unwrapPromise,
  type Budget,
  type TypeEnv,
} from './model.js';

/** 呼び出しの合成項目・起動の項目の id */
export const ACTIVATION_IDS = ['call', 'props', 'html'] as const;

const CALL_ITEM: ItemV2 = { id: 'call', name: '()', type: 'void' };
const PROPS_ITEM: ItemV2 = { id: 'props', name: 'props', type: '{}', wireType: 'object' };
const HTML_ITEM: ItemV2 = { id: 'html', name: 'html', type: 'text/html', wireType: 'string' };

/** 式（または「式の .prop」）。links の元をたどる */
type ExprRef = { node: Node } | { base: Node; sub: string };

interface Slot {
  id: string;
  item: ItemV2;
  expr?: ExprRef;
  /** 呼び先の in の項目 id（線の宛先）。無ければ線を引かない */
  target?: string;
}

interface CallEvent {
  k: number;
  node: CallExpression;
  callee?: Box;
  slots: Slot[];
  /** HTTP のクエリ（`?k=${v}` の k と v の式。query の子の順） */
  query?: Array<{ key: string; expr?: Node }>;
}

interface RenderEvent {
  k: number;
  node: Node;
  callee: Box;
  attrs: Slot[];
}

/** 箱ごとの解析の途中経過（links は全部の箱の線を引いたあとに作る） */
export interface BoxState {
  box: Box;
  env: TypeEnv;
  budget: Budget;
  calls: CallEvent[];
  renders: RenderEvent[];
  /** 引数・props の記号 → in の項目のパス（`today`、`view`）か、props のオブジェクト（`.x` → x） */
  params: Map<ts.Symbol, { path: string } | { props: Map<string, string> }>;
  /** call の式（生のノード）→ 番号 */
  callOf: Map<ts.Node, number>;
  /** 不透明にまとめた引数の項目 id（`props`。起動の項目ではなくデータの項目として扱う） */
  opaque: Set<string>;
}

export interface BuildContext {
  /** declKey（ファイル#開始位置）→ 箱 */
  boxByKey: Map<string, Box>;
  boxById: Map<string, Box>;
  /** declKey → ts-imports のノード id（箱でない lib・const も） */
  v1ByKey: Map<string, string>;
  /** ts-imports のノード id → kind */
  v1Kind: (id: string) => string | undefined;
  wrappers: ReadonlyMap<string, Wrapper>;
  /** api.callers（名前で HTTP の呼び出しとみなす） */
  callers: ReadonlySet<string>;
  /** api-link のクライアントファイル（絶対パス。既知の動詞 get・post などを HTTP の呼び出しとみなすファイル） */
  clientFiles: ReadonlySet<string>;
  resolverOf(sf: SourceFile): ConstResolver;
  wires: WireV2[];
  maxItems: number;
  warn(msg: string): void;
}

const rawKey = (d: ts.Node) => `${d.getSourceFile().fileName}#${d.getStart()}`;

const isInside = (n: ts.Node, root: ts.Node) => n.pos >= root.pos && n.end <= root.end;

/** 記号の宣言（別名は元へ） */
function declOf(env: TypeEnv, n: ts.Node): ts.Declaration | undefined {
  let sym = env.checker.getSymbolAtLocation(n);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) sym = env.checker.getAliasedSymbol(sym);
  return sym.declarations?.[0];
}

const addItem = (list: ItemV2[], ids: Set<string>, it: ItemV2) => {
  if (ids.has(it.id)) return;
  ids.add(it.id);
  list.push(it);
};

/** 入口の項目（phase A）: 引数・props・起動の項目・戻り値 */
export function buildPorts(box: Box, env: TypeEnv, maxItems: number): BoxState {
  const c = env.checker;
  const budget: Budget = { left: maxItems, truncated: false };
  const st: BoxState = {
    box,
    env,
    budget,
    calls: [],
    renders: [],
    params: new Map(),
    callOf: new Map(),
    opaque: new Set(),
  };
  const fn = box.fn;
  const params = (
    Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)
      ? fn.getParameters()
      : []
  ).map((p) => p.compilerNode);
  const add = (it: ItemV2) => {
    budget.left--;
    addItem(box.inItems, box.inIds, it);
  };
  /**
   * 分割代入・props のオブジェクトをフィールドに展開して in に置く。repo の外で宣言されたプロパティと、項目の上限に
   * 着いてから後のプロパティは、引数ごと不透明な 1 項目（`props`。子を置かない）にまとめる（C3）
   */
  const fields = (p: ts.ParameterDeclaration) => {
    const t = stripNullish(env, c.getTypeAtLocation(p)).t;
    const owner = namedRef(env, t);
    const ids = new Map<string, string>();
    const { own, external } = splitProps(env, t);
    const rest = [...external];
    for (const prop of own) {
      if (budget.left <= 0) {
        budget.truncated = true;
        rest.push(prop);
        continue;
      }
      const d = prop.valueDeclaration ?? prop.declarations?.[0];
      const pt = d ? c.getTypeOfSymbolAtLocation(prop, d) : c.getTypeOfSymbol(prop);
      const id = uniqueId(prop.getName(), new Set(box.inIds));
      ids.set(prop.getName(), id);
      add(
        makeItem(env, id, prop.getName(), pt, {
          ...(owner ? { ownerRef: owner } : {}),
          optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
          budget,
        }),
      );
    }
    let opaque: string | undefined;
    if (rest.length) {
      opaque = uniqueId('props', new Set(box.inIds));
      add({
        id: opaque,
        name: ts.isIdentifier(p.name) ? p.name.text : 'props',
        type: typeText(env, t),
        wireType: 'object',
      });
      for (const prop of rest) ids.set(prop.getName(), opaque);
      st.opaque.add(opaque);
    }
    if (ts.isObjectBindingPattern(p.name)) bindPattern(p.name, '', ids, opaque);
    else {
      const sym = c.getSymbolAtLocation(p.name);
      if (sym) st.params.set(sym, { props: ids });
    }
    return ids.size;
  };
  /** 分割代入の名前 → in のパス（`...rest` は不透明な項目があればそれ） */
  const bindPattern = (
    pat: ts.ObjectBindingPattern,
    prefix: string,
    ids?: Map<string, string>,
    opaque?: string,
  ) => {
    for (const el of pat.elements) {
      const key = (el.propertyName ?? el.name).getText();
      const seg = prefix
        ? itemId(key)
        : el.dotDotDotToken && opaque
          ? opaque
          : (ids?.get(key) ?? itemId(key));
      const path = prefix ? `${prefix}.${seg}` : seg;
      if (ts.isObjectBindingPattern(el.name)) bindPattern(el.name, path);
      else if (ts.isIdentifier(el.name)) {
        const sym = c.getSymbolAtLocation(el.name);
        if (sym) st.params.set(sym, { path });
      }
    }
  };

  if (box.kind === 'screen') add({ ...HTML_ITEM });
  if (box.kind === 'screen' || box.kind === 'component') {
    const p0 = params[0];
    const n = p0 ? fields(p0) : 0;
    if (!n && box.kind === 'component') add({ ...PROPS_ITEM });
  } else {
    for (const p of params) {
      if (ts.isObjectBindingPattern(p.name)) {
        fields(p);
        continue;
      }
      const name = p.name.getText();
      const sym = c.getSymbolAtLocation(p.name);
      const id = uniqueId(name, new Set(box.inIds));
      if (sym) st.params.set(sym, { path: id });
      add(
        makeItem(env, id, name, c.getTypeAtLocation(p), {
          optional: !!p.questionToken || !!p.initializer,
          budget,
        }),
      );
    }
    if (!params.length) add({ ...CALL_ITEM });
    const sig = c.getSignatureFromDeclaration(fn.compilerNode as ts.SignatureDeclaration);
    if (sig) {
      const rt = c.getReturnTypeOfSignature(sig);
      const it = makeItem(env, 'return', 'return', unwrapPromise(env, rt), {
        budget,
        display: typeText(env, rt),
      });
      budget.left--;
      addItem(box.outItems, box.outIds, it);
    }
  }
  return st;
}

/** 呼び先・描画先の箱 */
function calleeBox(st: BoxState, ctx: BuildContext, expr: Node): Box | undefined {
  const target = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
  const d = declOf(st.env, target.compilerNode);
  return d ? ctx.boxByKey.get(rawKey(d)) : undefined;
}

const calleeName = (call: CallExpression) => {
  const e = call.getExpression();
  if (Node.isIdentifier(e)) return e.getText();
  if (Node.isPropertyAccessExpression(e)) return e.getName();
  return e.getText().slice(0, 30);
};

/** 式が関数（アロー関数・関数式、関数の型の値。ルートの登録のハンドラなど）か */
function isFunctionValue(env: TypeEnv, n: Node): boolean {
  const x = strip(n);
  if (Node.isArrowFunction(x) || Node.isFunctionExpression(x)) return true;
  const t = env.checker.getTypeAtLocation(x.compilerNode);
  return t.getCallSignatures().length > 0;
}

/**
 * HTTP の呼び出しがクライアントの呼び出しか（C4）: パスより後ろの引数に関数を渡すもの（`app.get('/x', handler)`・
 * `router.post('/x', (req, res) => …)`）はサーバーのルートの登録。`fetch` と api.callers は名前で、api-link が検出した
 * ラッパーは呼び先の宣言が repo の中にあるとき、既知の動詞（get・post・request など）は api-link のクライアントファイルの
 * 中だけ
 */
function isClientCall(st: BoxState, ctx: BuildContext, call: CallExpression, info: HttpCallInfo) {
  const args = call.getArguments();
  if (args.some((a, i) => i > info.pathIndex && isFunctionValue(st.env, a))) return false;
  if (info.callee === 'fetch' || ctx.callers.has(info.callee)) return true;
  if (ctx.wrappers.has(info.callee)) {
    const e = call.getExpression();
    const d = declOf(
      st.env,
      (Node.isPropertyAccessExpression(e) ? e.getNameNode() : e).compilerNode,
    );
    if (d && st.env.inRepo(d.getSourceFile().fileName)) return true;
  }
  return ctx.clientFiles.has(st.box.abs);
}

/** ラッパーの中で引数をそのままパスとして渡している呼び出し（呼び出しではなく中継） */
function isRelay(call: CallExpression, pathIndex: number, box: Box): boolean {
  const arg = call.getArguments()[pathIndex];
  if (!arg) return false;
  for (const a of call.getAncestors()) {
    if (Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a)) {
      if (a.getParameters().some((p) => passesParam(arg, p.getName()))) return true;
    }
    if (a === box.fn) break;
  }
  return false;
}

const strip = (n: Node): Node => {
  let x = n;
  for (;;) {
    if (
      Node.isParenthesizedExpression(x) ||
      Node.isAsExpression(x) ||
      Node.isNonNullExpression(x) ||
      Node.isSatisfiesExpression(x) ||
      Node.isTypeAssertion(x) ||
      Node.isAwaitExpression(x)
    )
      x = x.getExpression();
    else return x;
  }
};

/** `JSON.stringify(x, …)` → x */
const unStringify = (n: Node): Node => {
  const x = strip(n);
  if (Node.isCallExpression(x) && x.getExpression().getText() === 'JSON.stringify') {
    const a = x.getArguments()[0];
    if (a) return a;
  }
  return x;
};

/** オブジェクトリテラルのプロパティの式（`{ body }` の短縮形も） */
function propertyExpr(obj: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  const p = obj.getProperty(name);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return undefined;
}

/** クエリの値の式の置き場（パスに出ない文字） */
const MARK = '\u{E000}';
const PLACEHOLDER = new RegExp(`^${MARK}(\\d+)${MARK}$`, 'u');

/** パスの式のクエリ（`/days?month=${month}` → [{ key: month, expr }]） */
function queryOf(arg: Node, resolve: ConstResolver): Array<{ key: string; expr?: Node }> {
  const parts: Array<string | Node> = [];
  const visit = (n: Node) => {
    const x = strip(n);
    if (Node.isStringLiteral(x) || Node.isNoSubstitutionTemplateLiteral(x)) {
      parts.push(x.getLiteralText());
      return;
    }
    const c = resolve(x);
    if (c !== undefined) {
      parts.push(c);
      return;
    }
    if (Node.isTemplateExpression(x)) {
      parts.push(x.getHead().getLiteralText());
      for (const span of x.getTemplateSpans()) {
        visit(span.getExpression());
        parts.push(span.getLiteral().getLiteralText());
      }
      return;
    }
    if (Node.isBinaryExpression(x) && x.getOperatorToken().getText() === '+') {
      visit(x.getLeft());
      visit(x.getRight());
      return;
    }
    parts.push(x);
  };
  visit(arg);
  let text = '';
  const exprs: Node[] = [];
  for (const p of parts) {
    if (typeof p === 'string') text += p;
    else {
      text += `${MARK}${exprs.length}${MARK}`;
      exprs.push(p);
    }
  }
  const q = text.indexOf('?');
  if (q < 0) return [];
  const out: Array<{ key: string; expr?: Node }> = [];
  for (const kv of text
    .slice(q + 1)
    .split('#')[0]!
    .split('&')) {
    const eq = kv.indexOf('=');
    const key = eq < 0 ? kv : kv.slice(0, eq);
    if (!key || key.includes(MARK)) continue;
    const m = PLACEHOLDER.exec(eq < 0 ? '' : kv.slice(eq + 1));
    out.push(m ? { key, expr: exprs[Number(m[1])]! } : { key });
  }
  return out;
}

/**
 * phase B1: 呼び出し・描画・参照を集めて、call_n / ret_n / render_n と線を作る（呼び先の口にも起動の項目・`_` を足す）
 */
export function buildCalls(st: BoxState, ctx: BuildContext): void {
  const { box, env } = st;
  const resolve = ctx.resolverOf(box.sf);
  let nCall = 0;
  let nRender = 0;
  const calledBoxes = new Set<string>();
  const skipIdents = new Set<ts.Node>();

  box.fn.forEachDescendant((n) => {
    if (Node.isCallExpression(n)) {
      const callee = calleeBox(st, ctx, n.getExpression());
      const info = httpCallInfo(n, ctx.wrappers, resolve);
      const http =
        info &&
        !('unreadable' in info) &&
        isClientCall(st, ctx, n, info) &&
        !isRelay(n, info.pathIndex, box)
          ? info
          : undefined;
      const boxCall =
        callee && callee !== box && callee.kind !== 'component' && callee.kind !== 'screen';
      if (!boxCall && !http) return;
      const k = ++nCall;
      st.callOf.set(n.compilerNode, k);
      const ev: CallEvent = { k, node: n, ...(boxCall ? { callee } : {}), slots: [] };
      st.calls.push(ev);
      const e = n.getExpression();
      skipIdents.add((Node.isPropertyAccessExpression(e) ? e.getNameNode() : e).compilerNode);
      if (boxCall) {
        calledBoxes.add(callee.id);
        box.refs.add(callee.id);
      }
      buildCall(st, ctx, ev, http ?? undefined, resolve);
      return;
    }
    if (Node.isJsxSelfClosingElement(n) || Node.isJsxOpeningElement(n)) {
      const tag = n.getTagNameNode();
      const callee = calleeBox(st, ctx, tag);
      if (!callee || callee.kind !== 'component' || callee === box) return;
      skipIdents.add((Node.isPropertyAccessExpression(tag) ? tag.getNameNode() : tag).compilerNode);
      const k = ++nRender;
      const ev: RenderEvent = { k, node: n, callee, attrs: [] };
      st.renders.push(ev);
      calledBoxes.add(callee.id);
      box.refs.add(callee.id);
      buildRender(st, ctx, ev);
    }
  });

  // 呼び出しでも描画でもない参照（D53）。同じファイルの非 export の宣言は推移的にたどる（ts-imports と同じ）
  const refs = new Set<string>();
  const localOf = new Map<ts.Node, Node>();
  for (const list of localDeclarations(box.sf).values())
    for (const d of list) localOf.set(d.compilerNode, d);
  const queue: Node[] = [box.fn];
  const visited = new Set<ts.Node>();
  for (let i = 0; i < queue.length; i++) {
    const root = queue[i]!;
    if (visited.has(root.compilerNode)) continue;
    visited.add(root.compilerNode);
    root.forEachDescendant((id) => {
      if (!Node.isIdentifier(id) || skipIdents.has(id.compilerNode)) return;
      const parent = id.getParent();
      if (parent && Node.isImportSpecifier(parent)) return;
      /** 型の参照（`Today` の注釈など）は線にしないが、refs（掃除の付け替え先の手がかり）には入れる */
      const typeOnly = !!parent && Node.isTypeReference(parent);
      const d = declOf(env, id.compilerNode);
      if (!d) return;
      if (typeOnly) {
        const t = ctx.boxByKey.get(rawKey(d))?.id ?? ctx.v1ByKey.get(rawKey(d));
        if (t && t !== box.id && !t.includes('#')) box.refs.add(t);
        return;
      }
      // 同じファイルの非 export のトップレベル宣言は中へ
      if (d.getSourceFile() === box.sf.compilerNode) {
        let top: ts.Node | undefined = d;
        while (top && !localOf.has(top)) top = top.parent;
        const local = top && localOf.get(top);
        if (local) queue.push(local);
        if (local || isInside(d, box.fn.compilerNode)) return;
      }
      const key = rawKey(d);
      const target = ctx.boxByKey.get(key)?.id ?? ctx.v1ByKey.get(key);
      // `#` を含む v1 の id（ts-imports の衝突の退避）は v2 に入らない（upgrade が落とす）
      if (!target || target === box.id || target.includes('#')) return;
      box.refs.add(target);
      const kind = ctx.boxByKey.get(key)?.kind ?? ctx.v1Kind(target);
      if (!kind || kind === 'type' || kind === 'schema') return;
      refs.add(target);
    });
  }
  for (const t of refs) {
    if (calledBoxes.has(t)) continue;
    const tb = ctx.boxById.get(t);
    const kind = tb?.kind ?? ctx.v1Kind(t);
    addItem(box.outItems, box.outIds, underscoreItem());
    if (tb) addItem(tb.inItems, tb.inIds, underscoreItem());
    const render = kind === 'component' || kind === 'screen';
    ctx.wires.push({ from: `${box.id}#out/_`, to: `${t}#in/_`, via: render ? 'render' : 'call' });
    if (!render) {
      addItem(box.inItems, box.inIds, underscoreItem());
      if (tb) addItem(tb.outItems, tb.outIds, underscoreItem());
      ctx.wires.push({ from: `${t}#out/_`, to: `${box.id}#in/_`, via: 'return', reply: true });
    }
  }
  if (st.budget.truncated || countItems([...box.inItems, ...box.outItems]) > ctx.maxItems) {
    ctx.warn(
      `ts-types: ${box.id} の項目が上限（${ctx.maxItems}）を超えたので、子の展開を打ち切りました（config の adapters.maxItems）`,
    );
  }
}

function buildCall(
  st: BoxState,
  ctx: BuildContext,
  ev: CallEvent,
  http: { method: string; path: string; pathIndex: number; callee: string } | undefined,
  resolve: ConstResolver,
) {
  const { box, env, budget } = st;
  const c = env.checker;
  const call = ev.node;
  const args = call.getArguments();
  const sig = c.getResolvedSignature(call.compilerNode);
  const params = sig?.getParameters() ?? [];
  const used = new Set<string>();
  const slots: Slot[] = [];
  const argType = (a: Node) => c.getTypeAtLocation(a.compilerNode);
  const slotItem = (id: string, name: string, t: ts.Type) => {
    budget.left--;
    return makeItem(env, id, name, t, { budget });
  };
  const paramName = (i: number) => params[Math.min(i, params.length - 1)]?.getName();

  // 引数（呼び先の引数名。分割代入はフィールド）。HTTP で呼び先が箱でない（fetch）なら役割の子だけ
  if (ev.callee) {
    params.forEach((p, i) => {
      const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
      const arg = args[i];
      if (!arg) return;
      if (decl && ts.isObjectBindingPattern(decl.name)) {
        const pt = stripNullish(env, c.getTypeOfSymbolAtLocation(p, decl)).t;
        const at = stripNullish(env, argType(arg)).t;
        // 呼び先が不透明な props にまとめたプロパティ（repo の外の宣言・上限で切ったもの）は、引数ごと 1 つにする（C3）
        const { own, external } = splitProps(env, pt);
        let opaque = external.some((x) => c.getPropertyOfType(at, x.getName()));
        for (const prop of own) {
          const sp = c.getPropertyOfType(at, prop.getName());
          if (!sp) continue;
          if (budget.left <= 0) {
            budget.truncated = true;
            opaque = true;
            break;
          }
          const sent = c.getTypeOfSymbolAtLocation(sp, arg.compilerNode);
          const id = uniqueId(prop.getName(), used);
          const pe = propertyExpr(strip(arg), prop.getName());
          slots.push({
            id,
            item: slotItem(id, prop.getName(), sent),
            expr: pe ? { node: pe } : { base: arg, sub: prop.getName() },
            target: itemId(prop.getName()),
          });
        }
        if (opaque) {
          const id = uniqueId('props', used);
          budget.left--;
          slots.push({
            id,
            item: { id, name: 'props', type: typeText(env, at), wireType: 'object' },
            expr: { node: arg },
            target: 'props',
          });
        }
        return;
      }
      const name = p.getName();
      const id = uniqueId(name, used);
      slots.push({
        id,
        item: slotItem(id, name, argType(arg)),
        expr: { node: arg },
        target: itemId(name),
      });
    });
  }
  if (http) {
    const pathArg = args[http.pathIndex];
    const pathParam = paramName(http.pathIndex) ?? 'url';
    let pathSlot = slots.find((s) => s.target === itemId(pathParam));
    if (!pathSlot && pathArg) {
      const id = uniqueId(pathParam, used);
      pathSlot = { id, item: slotItem(id, pathParam, argType(pathArg)), expr: { node: pathArg } };
      slots.unshift(pathSlot);
    }
    if (pathSlot) pathSlot.item.meta = { http: 'path' };
    // body: パス以外のオブジェクトリテラルの引数の body（JSON.stringify を剥がす）
    args.forEach((a, i) => {
      if (i === http.pathIndex) return;
      const be = propertyExpr(strip(a), 'body');
      if (!be) return;
      const x = unStringify(be);
      const target = params[i] ? itemId(params[i]!.getName()) : undefined;
      // 呼び先の引数 init の項目を body の項目に置き換える（init の残り — method・headers — は項目にしない）
      const at = slots.findIndex(
        (s) => s.target === target && s.expr && 'node' in s.expr && s.expr.node === a,
      );
      if (at >= 0) {
        used.delete(slots[at]!.id);
        slots.splice(at, 1);
      }
      const id = uniqueId('body', used);
      const item = slotItem(id, 'body', argType(x));
      item.meta = { http: 'body' };
      slots.push({ id, item, expr: { node: x }, ...(ev.callee && target ? { target } : {}) });
    });
    // query: パスの `?k=${v}`
    const qs = pathArg ? queryOf(pathArg, resolve) : [];
    if (qs.length) {
      const id = uniqueId('query', used);
      const qused = new Set<string>();
      const children = qs.map((q) => {
        const qid = uniqueId(q.key, qused);
        budget.left--;
        return q.expr
          ? makeItem(env, qid, q.key, argType(q.expr), { budget })
          : { id: qid, name: q.key, type: 'string', wireType: 'string' as const };
      });
      slots.push({
        id,
        item: {
          id,
          name: 'query',
          type: 'object',
          wireType: 'object',
          children,
          meta: { http: 'query' },
        },
        ...(ev.callee && pathSlot?.target ? { target: pathSlot.target } : {}),
      });
      ev.query = qs;
    }
  }
  ev.slots = slots;

  const callType = c.getTypeAtLocation(call.compilerNode);
  const name = http
    ? `${calleeName(call)}(${(args[http.pathIndex]?.getText() ?? '').slice(0, 40)})`
    : `${calleeName(call)}()`;
  const callItem: ItemV2 = {
    id: `call_${ev.k}`,
    name,
    type: typeText(env, callType),
    wireType: 'object',
    ...(slots.length ? { children: slots.map((s) => s.item) } : {}),
    ...(http ? { meta: { http: { method: http.method, path: http.path } } } : {}),
  };
  addItem(box.outItems, box.outIds, callItem);
  const ret = unwrapPromise(env, callType);
  budget.left--;
  addItem(
    box.inItems,
    box.inIds,
    makeItem(env, `ret_${ev.k}`, `${calleeName(call)}() の戻り`, ret, {
      budget,
      display: typeText(env, ret),
    }),
  );

  // 線
  const callee = ev.callee;
  if (!callee) return;
  let wired = false;
  for (const s of slots) {
    if (!s.target) continue;
    const r = callee.inItems.find((x) => x.id === s.target);
    if (!r) continue;
    wireBetween(
      ctx,
      `${box.id}#out/call_${ev.k}.${s.id}`,
      s.item,
      `${callee.id}#in/${r.id}`,
      r,
      'call',
    );
    wired = true;
  }
  if (!wired) {
    addItem(callee.inItems, callee.inIds, { ...CALL_ITEM });
    ctx.wires.push({ from: `${box.id}#out/call_${ev.k}`, to: `${callee.id}#in/call`, via: 'call' });
  }
  if (callee.outItems.some((x) => x.id === 'return'))
    ctx.wires.push({
      from: `${callee.id}#out/return`,
      to: `${box.id}#in/ret_${ev.k}`,
      via: 'return',
      reply: true,
    });
}

function buildRender(st: BoxState, ctx: BuildContext, ev: RenderEvent) {
  const { box, env, budget } = st;
  const c = env.checker;
  const el = ev.node;
  const used = new Set<string>();
  const attrs: Slot[] = [];
  const attributes =
    Node.isJsxSelfClosingElement(el) || Node.isJsxOpeningElement(el) ? el.getAttributes() : [];
  for (const a of attributes) {
    if (Node.isJsxAttribute(a)) {
      const name = a.getNameNode().getText();
      if (name === 'key' || name === 'ref') continue;
      const init = a.getInitializer();
      const expr = init && Node.isJsxExpression(init) ? init.getExpression() : init;
      const id = uniqueId(name, used);
      budget.left--;
      // 文字列の属性（month="2026-11"）は string、値の無い属性（disabled）は true
      const item: ItemV2 = !expr
        ? { id, name, type: 'boolean', wireType: 'boolean' }
        : Node.isStringLiteral(expr)
          ? { id, name, type: 'string', wireType: 'string' }
          : makeItem(env, id, name, c.getTypeAtLocation(expr.compilerNode), { budget });
      attrs.push({ id, item, ...(expr ? { expr: { node: expr } } : {}), target: itemId(name) });
    } else if (Node.isJsxSpreadAttribute(a)) {
      // `{...rest}`: repo の中で宣言されたプロパティは 1 つずつ、外のもの（DOM の属性など）と上限で切ったものは
      // 不透明な 1 項目にまとめる（C3）
      const x = a.getExpression();
      const t = stripNullish(env, c.getTypeAtLocation(x.compilerNode)).t;
      const { own, external } = splitProps(env, t);
      let opaque = external.length > 0;
      for (const p of own) {
        if (budget.left <= 0) {
          budget.truncated = true;
          opaque = true;
          break;
        }
        const d = p.valueDeclaration ?? p.declarations?.[0];
        const pt = d ? c.getTypeOfSymbolAtLocation(p, d) : c.getTypeOfSymbol(p);
        const id = uniqueId(p.getName(), used);
        budget.left--;
        attrs.push({
          id,
          item: makeItem(env, id, p.getName(), pt, { budget }),
          expr: { base: x, sub: p.getName() },
          target: itemId(p.getName()),
        });
      }
      if (opaque) {
        const id = uniqueId('props', used);
        budget.left--;
        attrs.push({
          id,
          item: {
            id,
            name: `{...${x.getText().slice(0, 30)}}`,
            type: typeText(env, t),
            wireType: 'object',
          },
          expr: { node: x },
          target: 'props',
        });
      }
    }
  }
  // 子要素（<Layout>…</Layout>）は children の props
  const parent = el.getParent();
  if (Node.isJsxOpeningElement(el) && parent && Node.isJsxElement(parent)) {
    const kids = parent.getJsxChildren().filter((k) => !(Node.isJsxText(k) && !k.getText().trim()));
    const recv = ev.callee.inItems.find((x) => x.id === 'children');
    if (kids.length && recv && !used.has('children')) {
      const { id: _i, ...rest } = recv;
      void _i;
      attrs.push({
        id: 'children',
        item: { id: 'children', ...rest, name: 'children' },
        target: 'children',
      });
    }
  }
  ev.attrs = attrs;
  const tag =
    Node.isJsxSelfClosingElement(el) || Node.isJsxOpeningElement(el)
      ? el.getTagNameNode().getText()
      : ev.callee.name;
  addItem(box.outItems, box.outIds, {
    id: `render_${ev.k}`,
    name: `${tag}()`,
    type: 'JSX.Element',
    wireType: 'object',
    ...(attrs.length ? { children: attrs.map((s) => s.item) } : {}),
  });
  let wired = false;
  /** 受ける側の不透明な props（repo の外のプロパティをまとめたもの）。名前で当たらない属性はここへ */
  const opaqueIn = ev.callee.inItems.find((x) => x.id === 'props');
  for (const s of attrs) {
    const r = ev.callee.inItems.find((x) => x.id === s.target) ?? opaqueIn;
    if (!r) continue;
    wireBetween(
      ctx,
      `${box.id}#out/render_${ev.k}.${s.id}`,
      s.item,
      `${ev.callee.id}#in/${r.id}`,
      r,
      'render',
    );
    wired = true;
  }
  if (!wired) {
    addItem(ev.callee.inItems, ev.callee.inIds, { ...PROPS_ITEM });
    ctx.wires.push({
      from: `${box.id}#out/render_${ev.k}`,
      to: `${ev.callee.id}#in/props`,
      via: 'render',
    });
  }
}

/** 受ける側の子が送る側の子に名前で全部写るか（子を再帰。子の無い側は写るとみなす） */
function mapsAll(s: ItemV2, r: ItemV2): boolean {
  if (!s.children?.length || !r.children?.length) return true;
  return r.children.every((rc) => {
    const sc = s.children!.find((x) => x.id === rc.id);
    return !!sc && mapsAll(sc, rc);
  });
}

/** 最も粗い単位で線を引く（D41）。名前で全部写らなければ写る子ごとに */
function wireBetween(
  ctx: BuildContext,
  sRef: string,
  s: ItemV2,
  rRef: string,
  r: ItemV2,
  via: WireVia,
) {
  if (mapsAll(s, r)) {
    ctx.wires.push({ from: sRef, to: rRef, via });
    return;
  }
  for (const rc of r.children ?? []) {
    const sc = s.children?.find((x) => x.id === rc.id);
    if (sc) wireBetween(ctx, `${sRef}.${sc.id}`, sc, `${rRef}.${rc.id}`, rc, via);
  }
}

/** links の元（in の項目のパス） */
interface Src {
  path: string;
  exact: boolean;
}

/** phase B2: 箱の中の links（データ由来 ＋ 起動） */
export function buildLinks(st: BoxState): LinkV2[] {
  const { box, env } = st;
  const c = env.checker;
  const fnRaw = box.fn.compilerNode;
  type Local =
    | { kind: 'local'; init: Node; sub: string[] }
    | { kind: 'state'; init?: Node; setter?: ts.Symbol }
    | { kind: 'then'; receiver: Node }
    | { kind: 'elem'; receiver: Node };
  const locals = new Map<ts.Symbol, Local>();
  const setterArgs = new Map<ts.Symbol, Node[]>();
  const symOf = (n: Node) => c.getSymbolAtLocation(n.compilerNode);
  const ARRAY_CB = /^(map|forEach|filter|find|findLast|some|every|flatMap)$/;

  box.fn.forEachDescendant((n) => {
    if (Node.isVariableDeclaration(n)) {
      const init = n.getInitializer();
      const name = n.getNameNode();
      if (!init) return;
      if (Node.isIdentifier(name)) {
        const s = symOf(name);
        if (s) locals.set(s, { kind: 'local', init, sub: [] });
      } else if (Node.isArrayBindingPattern(name)) {
        const els = name.getElements();
        const ie = strip(init);
        const isState =
          Node.isCallExpression(ie) &&
          /(^|\.)use(State|Reducer)$/.test(ie.getExpression().getText());
        if (isState) {
          const [s0, s1] = els;
          const ss = s0 && Node.isBindingElement(s0) ? symOf(s0.getNameNode()) : undefined;
          const setter = s1 && Node.isBindingElement(s1) ? symOf(s1.getNameNode()) : undefined;
          const first = (ie as CallExpression).getArguments()[0];
          if (ss)
            locals.set(ss, {
              kind: 'state',
              ...(first ? { init: first } : {}),
              ...(setter ? { setter } : {}),
            });
        } else {
          for (const e of els)
            if (Node.isBindingElement(e)) {
              const s = symOf(e.getNameNode());
              if (s) locals.set(s, { kind: 'local', init, sub: [] });
            }
        }
      } else if (Node.isObjectBindingPattern(name)) {
        for (const e of name.getElements()) {
          const s = symOf(e.getNameNode());
          const key = (e.getPropertyNameNode() ?? e.getNameNode()).getText();
          if (s) locals.set(s, { kind: 'local', init, sub: [key] });
        }
      }
      return;
    }
    if (Node.isCallExpression(n)) {
      const e = n.getExpression();
      // setter に渡した式
      if (Node.isIdentifier(e)) {
        const s = symOf(e);
        if (s) setterArgs.set(s, [...(setterArgs.get(s) ?? []), ...n.getArguments()]);
      }
      if (Node.isPropertyAccessExpression(e)) {
        const cb = n.getArguments()[0];
        const name = e.getName();
        if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
          const p0 = cb.getParameters()[0];
          const s = p0 && Node.isIdentifier(p0.getNameNode()) ? symOf(p0.getNameNode()) : undefined;
          if (s && name === 'then') locals.set(s, { kind: 'then', receiver: e.getExpression() });
          else if (s && ARRAY_CB.test(name))
            locals.set(s, { kind: 'elem', receiver: e.getExpression() });
        }
      }
    }
  });

  const sourcesMemo = new Map<ts.Symbol, Src[]>();
  const inProgress = new Set<ts.Symbol>();
  const crude = (xs: Src[]) => xs.map((x) => ({ ...x, exact: false }));
  const withSub = (xs: Src[], sub: string[]) =>
    sub.length ? xs.map((x) => ({ ...x, path: `${x.path}.${sub.map(itemId).join('.')}` })) : xs;

  const ofSymbol = (s: ts.Symbol): Src[] => {
    const p = st.params.get(s);
    if (p) {
      if ('path' in p) return [{ path: `in/${p.path}`, exact: true }];
      return [...p.props.values()].map((id) => ({ path: `in/${id}`, exact: true }));
    }
    const l = locals.get(s);
    if (!l) return [];
    const memo = sourcesMemo.get(s);
    if (memo) return memo;
    if (inProgress.has(s)) return [];
    inProgress.add(s);
    let out: Src[] = [];
    switch (l.kind) {
      case 'local':
        out = crude(withSub(sourcesOf(l.init), l.sub));
        break;
      case 'state': {
        const xs = [...(l.init ? sourcesOf(l.init) : [])];
        for (const a of l.setter ? (setterArgs.get(l.setter) ?? []) : []) xs.push(...sourcesOf(a));
        out = crude(xs);
        break;
      }
      case 'then':
        out = valueOf(l.receiver);
        break;
      case 'elem':
        out = sourcesOf(l.receiver);
        break;
    }
    inProgress.delete(s);
    sourcesMemo.set(s, out);
    return out;
  };

  /** then の受け手（呼び出しの値） */
  const valueOf = (n: Node): Src[] => sourcesOf(n);

  /** 関数の戻りの式（then のコールバック） */
  const returnsOf = (f: Node): Node[] => {
    if (!(Node.isArrowFunction(f) || Node.isFunctionExpression(f))) return [];
    const body = f.getBody();
    if (!Node.isBlock(body)) return [body];
    const out: Node[] = [];
    body.forEachDescendant((x, t) => {
      if (
        Node.isArrowFunction(x) ||
        Node.isFunctionExpression(x) ||
        Node.isFunctionDeclaration(x)
      ) {
        t.skip();
        return;
      }
      if (Node.isReturnStatement(x)) {
        const e = x.getExpression();
        if (e) out.push(e);
      }
    });
    return out;
  };

  const sourcesOf = (n0: Node): Src[] => {
    const n = strip(n0);
    if (Node.isIdentifier(n)) {
      const s = symOf(n);
      return s ? ofSymbol(s) : [];
    }
    if (Node.isShorthandPropertyAssignment(n)) {
      const s = c.getShorthandAssignmentValueSymbol(n.compilerNode);
      return s ? ofSymbol(s) : [];
    }
    if (Node.isPropertyAccessExpression(n)) {
      const base = strip(n.getExpression());
      if (Node.isIdentifier(base)) {
        const s = symOf(base);
        const p = s ? st.params.get(s) : undefined;
        if (p && 'props' in p) {
          const id = p.props.get(n.getName());
          return id ? [{ path: `in/${id}`, exact: true }] : [];
        }
      }
      return withSub(sourcesOf(base), [n.getName()]);
    }
    if (Node.isElementAccessExpression(n)) return sourcesOf(n.getExpression());
    if (Node.isCallExpression(n)) {
      const k = st.callOf.get(n.compilerNode);
      if (k !== undefined) return [{ path: `in/ret_${k}`, exact: true }];
      const e = n.getExpression();
      if (Node.isPropertyAccessExpression(e) && e.getName() === 'then') {
        const cb = n.getArguments()[0];
        return cb ? returnsOf(cb).flatMap(sourcesOf) : [];
      }
      const args = n.getArguments().flatMap((a) => sourcesOf(a));
      if (Node.isPropertyAccessExpression(e)) return [...sourcesOf(e.getExpression()), ...args];
      return args;
    }
    if (Node.isTemplateExpression(n))
      return n.getTemplateSpans().flatMap((s) => sourcesOf(s.getExpression()));
    if (Node.isBinaryExpression(n)) return [...sourcesOf(n.getLeft()), ...sourcesOf(n.getRight())];
    if (Node.isConditionalExpression(n))
      return [...sourcesOf(n.getWhenTrue()), ...sourcesOf(n.getWhenFalse())];
    if (Node.isObjectLiteralExpression(n))
      return n.getProperties().flatMap((p) => {
        if (Node.isPropertyAssignment(p)) {
          const i = p.getInitializer();
          return i ? sourcesOf(i) : [];
        }
        if (Node.isShorthandPropertyAssignment(p) || Node.isSpreadAssignment(p))
          return Node.isSpreadAssignment(p) ? sourcesOf(p.getExpression()) : sourcesOf(p);
        return [];
      });
    if (Node.isArrayLiteralExpression(n)) return n.getElements().flatMap(sourcesOf);
    if (Node.isSpreadElement(n)) return sourcesOf(n.getExpression());
    if (Node.isPrefixUnaryExpression(n) || Node.isPostfixUnaryExpression(n))
      return sourcesOf(n.getOperand());
    return [];
  };
  const exprSources = (e: ExprRef | undefined): Src[] => {
    if (!e) return [];
    if ('node' in e) return sourcesOf(e.node);
    return withSub(sourcesOf(e.base), [e.sub]);
  };

  // links（from は in の項目の木に合わせて末尾から粗くする）
  const links = new Map<string, LinkV2>();
  const resolveIn = (path: string): string | undefined => {
    const segs = path.replace(/^in\//, '').split('.');
    let list: ItemV2[] | undefined = box.inItems;
    const kept: string[] = [];
    for (const seg of segs) {
      const it: ItemV2 | undefined = list?.find((x) => x.id === seg);
      if (!it) break;
      kept.push(seg);
      list = it.children;
    }
    return kept.length ? `in/${kept.join('.')}` : undefined;
  };
  const add = (src: Src, to: string) => {
    const from = resolveIn(src.path);
    if (!from) return;
    const key = `${from}\u0000${to}`;
    const prev = links.get(key);
    if (prev && (prev.confidence === 'exact' || !src.exact)) return;
    links.set(key, { from, to, confidence: src.exact ? 'exact' : 'crude' });
  };

  for (const ev of st.calls) {
    for (const s of ev.slots) {
      const to = `out/call_${ev.k}.${s.id}`;
      if (s.item.meta?.http === 'query') {
        const qs = ev.query ?? [];
        (s.item.children ?? []).forEach((child, i) => {
          const q = qs[i];
          if (q?.expr) for (const src of sourcesOf(q.expr)) add(src, `${to}.${child.id}`);
        });
        continue;
      }
      for (const src of exprSources(s.expr)) add(src, to);
    }
  }
  for (const ev of st.renders)
    for (const s of ev.attrs)
      for (const src of exprSources(s.expr)) add(src, `out/render_${ev.k}.${s.id}`);
  // 戻り値
  const ret = box.outItems.find((x) => x.id === 'return');
  if (ret) {
    const exprs: Node[] = [];
    const body =
      Node.isFunctionDeclaration(box.fn) ||
      Node.isArrowFunction(box.fn) ||
      Node.isFunctionExpression(box.fn)
        ? box.fn.getBody()
        : undefined;
    if (body && !Node.isBlock(body)) exprs.push(body);
    else
      box.fn.forEachDescendant((x) => {
        if (!Node.isReturnStatement(x)) return;
        let f: ts.Node | undefined = x.compilerNode.parent;
        while (f && !ts.isFunctionLike(f)) f = f.parent;
        if (f !== fnRaw) return;
        const e = x.getExpression();
        if (e) exprs.push(e);
      });
    for (const e0 of exprs) {
      const e = strip(e0);
      if (Node.isObjectLiteralExpression(e)) {
        for (const p of e.getProperties()) {
          const name =
            Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)
              ? p.getName()
              : undefined;
          const child = name ? ret.children?.find((x) => x.id === itemId(name)) : undefined;
          const to = child ? `out/return.${child.id}` : 'out/return';
          const srcs = Node.isPropertyAssignment(p)
            ? sourcesOf(p.getInitializer() ?? p)
            : Node.isShorthandPropertyAssignment(p)
              ? sourcesOf(p)
              : Node.isSpreadAssignment(p)
                ? sourcesOf(p.getExpression())
                : [];
          for (const src of srcs) add(src, to);
        }
      } else for (const src of sourcesOf(e)) add(src, 'out/return');
    }
  }

  // 起動の links（§7 #3）: データ由来の link が無い call_n / render_n / return へ
  const activation = box.inItems.filter(
    (x) => (ACTIVATION_IDS as readonly string[]).includes(x.id) && !st.opaque.has(x.id),
  );
  const starts = activation.length
    ? activation
    : box.inItems.filter((x) => !/^ret_\d+$/.test(x.id) && x.id !== UNDERSCORE);
  const targeted = (id: string) =>
    [...links.values()].some((l) => l.to === `out/${id}` || l.to.startsWith(`out/${id}.`));
  for (const o of box.outItems) {
    if (o.id === UNDERSCORE || targeted(o.id)) continue;
    if (!/^(call|render)_\d+$/.test(o.id) && o.id !== 'return') continue;
    if (o.id === 'return' && !o.wireType && !o.children) continue; // void の戻りは流れない
    for (const a of starts)
      links.set(`in/${a.id}\u0000out/${o.id}`, {
        from: `in/${a.id}`,
        to: `out/${o.id}`,
        confidence: 'crude',
      });
  }
  return [...links.values()];
}
