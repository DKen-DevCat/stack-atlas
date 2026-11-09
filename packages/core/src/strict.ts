/**
 * ハーネスの報告（build --dry-run --json の中身と project.generator.report。docs/19 §3.2）と strict の判定
 * （strictIssues。docs/19 §3.3、D69・D71・D72）。
 *
 * 数は最後の graph（補いの段 B の後）から数え直す（D73）:
 * - unjoined: 合流で結べなかった HTTP の呼び出し（呼び出しの項目かその子から via http の行きの線が出ていれば解決）、
 *   OpenAPI に無い handler のルート（endpoint から・via http / event で入る線があれば解決）、結べなかった SQL（via sql の
 *   線が出ていれば解決）、handler の無い endpoint（`req` から線が出ていれば解決）
 * - undetermined: cleanupV2 が付け替え先を決められなかった group の端（retarget で決めたものは入らない）
 * - opaque: links の無い箱（in と out の両方に項目がある）と、crude の links を持つ箱
 */
import type { GraphV2, HarnessReportV2, NodeV2, ValidationIssue } from '@stack-atlas/schema';
import { HARNESS_REPORT_VERSION } from '@stack-atlas/schema';
import { handlerRoutes, httpCallOf, sqlOf, type JoinReport } from './join.js';
import { coverageV2, type CoverageV2, type UndeterminedWire } from './merge-v2.js';
import type { BuildGraphResult } from './pipeline.js';
import { countSupplements, supplementText, type SupplementResult } from './supplements.js';
import type { BuildIssue, StackAtlasConfig } from './types.js';
import { boxOf } from './v2-parts.js';

export type CheckedEntry = HarnessReportV2['checked'][string];

export interface UnjoinedCall {
  box: string;
  /** 呼び出しの項目の参照（`<箱>#out/call_n`） */
  item: string;
  method: string;
  path: string;
}

export interface ScreenRouteReport {
  route: string;
  html: boolean;
  /** カバー率（screens 抽出器の issue の data。reachable: たどれる部品、dom: data-component で測れた分、yaml: regions.yaml の分） */
  coverage?: { reachable: number; dom: number; yaml: number };
}

/** build --dry-run --json の中身（docs/19 §3.2）。graph.json には数と一覧の文字列だけを書く（toGraphReport） */
export interface HarnessReport {
  checked: Record<string, CheckedEntry>;
  adapters: { names: string[]; coverage: CoverageV2 };
  contracts: { names: string[] };
  unjoined: {
    calls: UnjoinedCall[];
    /** handler の無い endpoint（strict では警告。D86） */
    endpointsWithoutHandler: string[];
    /** endpoint（OpenAPI）に無い handler のルート */
    routesWithoutEndpoint: Array<{ box: string; method: string; path: string }>;
    /** table と結べない SQL の項目 */
    sql: Array<{ item: string; table: string }>;
  };
  undetermined: UndeterminedWire[];
  opaque: { boxes: string[]; crude: string[] };
  estimates: Array<{ path: string; message: string }>;
  screens: {
    configured: boolean;
    routes: ScreenRouteReport[];
    dropped: Array<{ path: string; message: string }>;
  };
  /** 補いごとの結果（overrides の v2:・手書きの部分グラフ・views.yaml） */
  supplements: SupplementResult[];
  /** overrides の remove のうち、v1 にも v2 にも無い箱 id */
  removeMissing: string[];
  /** overrides の nodes で足した箱のうち、線の無いもの */
  addedWithoutWires: string[];
}

export interface HarnessInput {
  graph: GraphV2;
  join?: Pick<JoinReport, 'client' | 'server' | 'table'>;
  undetermined: UndeterminedWire[];
  supplements: SupplementResult[];
  removeMissing: string[];
  /** overrides の nodes で足した（抽出器に無かった）箱 id */
  addedBoxes: string[];
  checked: Record<string, CheckedEntry>;
  adapters: string[];
  contracts: string[];
  issues: readonly BuildIssue[];
  config: StackAtlasConfig;
  multi: boolean;
}

const outItems = (n: NodeV2) =>
  n.ports
    .filter((p) => p.dir === 'out')
    .flatMap((p) => p.items.map((it) => ({ it, ref: `${n.id}#${p.id}/${it.id}` })));

const under = (ref: string, root: string) => ref === root || ref.startsWith(`${root}.`);

/** 最後の graph から報告を作る */
export function computeHarnessReport(input: HarnessInput): HarnessReport {
  const g = input.graph;
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const outgoing = (root: string, ok: (w: GraphV2['wires'][number]) => boolean) =>
    g.wires.some((w) => !w.reply && under(w.from, root) && ok(w));

  // unjoined（合流の時点で結べなかったもののうち、補いの線がまだ無いもの）
  const calls: UnjoinedCall[] = [];
  const routes: HarnessReport['unjoined']['routesWithoutEndpoint'] = [];
  const sql: HarnessReport['unjoined']['sql'] = [];
  const endpointsWithoutHandler: string[] = [];
  if (input.join) {
    const unCalls = new Set(input.join.client.unmatched);
    const unRoutes = new Set(input.join.server.unmatched);
    const unSql = new Set(input.join.table.unmatched);
    const noHandler = new Set(input.join.server.withoutHandler);
    for (const n of g.nodes) {
      if (n.kind !== 'endpoint')
        for (const { it, ref } of outItems(n)) {
          const c = httpCallOf(it);
          if (
            c &&
            unCalls.has(`${n.id} ${c.method} ${c.path}`) &&
            !outgoing(ref, (w) => w.via === 'http')
          )
            calls.push({ box: n.id, item: ref, method: c.method, path: c.path });
          const s = sqlOf(it);
          if (s && unSql.has(`${ref} ${s.table}`) && !outgoing(ref, (w) => w.via === 'sql'))
            sql.push({ item: ref, table: s.table });
        }
      for (const r of handlerRoutes(n)) {
        if (!unRoutes.has(`${n.id} ${r.method} ${r.path}`)) continue;
        const fed = g.wires.some(
          (w) =>
            !w.reply &&
            boxOf(w.to) === n.id &&
            (kindOf.get(boxOf(w.from)) === 'endpoint' || w.via === 'http' || w.via === 'event'),
        );
        if (!fed) routes.push({ box: n.id, method: r.method, path: r.path });
      }
      if (noHandler.has(n.id) && !g.wires.some((w) => w.from.startsWith(`${n.id}#req/`)))
        endpointsWithoutHandler.push(n.id);
    }
  }

  // 不透明（links の無い箱・crude の links の箱）
  const opaque: HarnessReport['opaque'] = { boxes: [], crude: [] };
  for (const n of g.nodes) {
    if (!n.links) {
      if (n.kind === 'table' || n.kind === 'endpoint') continue;
      const has = (dir: 'in' | 'out') => n.ports.some((p) => p.dir === dir && p.items.length > 0);
      if (has('in') && has('out')) opaque.boxes.push(n.id);
    } else if (n.links.some((l) => l.confidence === 'crude')) opaque.crude.push(n.id);
  }

  // 画面
  const screensCfg = input.config.screens;
  const screenRepo = screensCfg?.repo;
  const coverage = new Map<string, ScreenRouteReport['coverage']>();
  const dropped: HarnessReport['screens']['dropped'] = [];
  for (const i of input.issues) {
    if (!i.path.startsWith('screens:')) continue;
    const d = i.data;
    if (d && typeof d.reachable === 'number')
      coverage.set(i.path.slice('screens:'.length), {
        reachable: d.reachable,
        dom: typeof d.dom === 'number' ? d.dom : 0,
        yaml: typeof d.yaml === 'number' ? d.yaml : 0,
      });
    else dropped.push({ path: i.path, message: i.message });
  }
  const routeReports: ScreenRouteReport[] = [];
  if (screensCfg)
    for (const n of g.nodes) {
      if (n.kind !== 'screen' || !n.id.startsWith('route:') || n.meta?.sharedOf !== undefined)
        continue;
      if (input.multi && screenRepo && n.file && !n.file.startsWith(`${screenRepo}/`)) continue;
      const route = n.id.slice('route:'.length);
      const r: ScreenRouteReport = { route, html: !!n.screen?.html };
      const c = coverage.get(route);
      if (c) r.coverage = c;
      routeReports.push(r);
    }

  // overrides の nodes で足した箱のうち、線の無いもの（枠になった infra は除く）
  const wired = new Set<string>();
  for (const w of g.wires) {
    wired.add(boxOf(w.from));
    wired.add(boxOf(w.to));
  }
  const hosts = new Set(g.nodes.map((n) => n.host).filter((h): h is string => !!h));
  const present = new Set(g.nodes.map((n) => n.id));
  const addedWithoutWires = input.addedBoxes.filter(
    (id) => present.has(id) && !wired.has(id) && !hosts.has(id),
  );

  return {
    checked: input.checked,
    adapters: { names: [...input.adapters], coverage: coverageV2(g) },
    contracts: { names: [...input.contracts] },
    unjoined: { calls, endpointsWithoutHandler, routesWithoutEndpoint: routes, sql },
    undetermined: input.undetermined,
    opaque,
    estimates: input.issues
      .filter((i) => i.message.includes('推定'))
      .map((i) => ({ path: i.path, message: i.message })),
    screens: { configured: !!screensCfg, routes: routeReports, dropped },
    supplements: input.supplements,
    removeMissing: input.removeMissing,
    addedWithoutWires,
  };
}

/** strict の違反 1 件。rule は違反の種類（docs/19 §3.3 の番号の代わりの名前） */
export interface StrictIssue {
  rule: string;
  path: string;
  message: string;
}

export interface StrictResult {
  errors: StrictIssue[];
  warnings: StrictIssue[];
}

/**
 * strict の判定（docs/19 §3.3）。エラーは「埋められる隙間」だけ（D69）: 結べない呼び出し・OpenAPI に無いルート・結べない SQL、
 * 付け替え先を決められない線、screens を設定しているのに HTML の無い route、解けない・指紋が合わない・reason の無い補い、
 * 解けない views、v1 にも v2 にも無い remove の id、見つけたのに飛ばした言語アダプタ（D87）。
 * 警告: handler の無い endpoint（D86）、口の単位の線、不透明な箱、wireType unknown、typeRef の欠け、カバー率 0、broken、
 * overrides で足した線の無い箱（D71）
 */
export function strictIssues(
  result: Pick<BuildGraphResult, 'harness' | 'graphV2' | 'v2Warnings'>,
): StrictResult {
  const errors: StrictIssue[] = [];
  const warnings: StrictIssue[] = [];
  const err = (rule: string, path: string, message: string) => errors.push({ rule, path, message });
  const warn = (rule: string, path: string, message: string) =>
    warnings.push({ rule, path, message });
  const h = result.harness;
  if (!h || !result.graphV2) {
    err('v2', 'v2', 'v2 の graph がありません（--v1 では strict を判定できません）');
    return { errors, warnings };
  }
  for (const c of h.unjoined.calls)
    err(
      'unjoined',
      `v2:${c.item}`,
      `endpoint・handler と結べない HTTP 呼び出し ${c.method} ${c.path}（overrides の v2.wires か手書きの部分グラフで補う）`,
    );
  for (const r of h.unjoined.routesWithoutEndpoint)
    err(
      'unjoined',
      `v2:${r.box}`,
      `endpoint（OpenAPI）に無い handler のルート ${r.method} ${r.path}（OpenAPI に足すか、手書きの部分グラフで endpoint を置く）`,
    );
  for (const s of h.unjoined.sql)
    err(
      'unjoined',
      `v2:${s.item}`,
      `table ${s.table} と結べない SQL（マイグレーションか v2.wires で補う）`,
    );
  for (const u of h.undetermined)
    err(
      'undetermined',
      `v2:${u.group}`,
      `付け替え先を決められない線 ${u.group} ↔ ${u.peer}（${u.via}）。候補 ${u.candidates.join(', ')}（overrides の v2.retarget で決める）`,
    );
  if (h.screens.configured)
    for (const r of h.screens.routes)
      if (!r.html)
        err(
          'screens',
          `screens:${r.route}`,
          `screens を設定しているのに route ${r.route} の HTML がありません（静的エクスポートを作る・screens.routes にサンプルを足す）`,
        );
  for (const s of h.supplements) {
    const rule = s.kind === 'view' ? 'views' : 'supplements';
    if (s.status !== 'applied') err(rule, `supplements:${s.kind}`, supplementText(s));
    else if (s.noReason && s.kind !== 'hand' && s.kind !== 'view')
      err(
        rule,
        `supplements:${s.kind}`,
        `${supplementText(s)}。reason がありません（DECISIONS.md に出すので必須）`,
      );
  }
  for (const id of h.removeMissing)
    err(
      'remove',
      'overrides:remove',
      `overrides の remove の "${id}" は v1 にも v2 にもありません`,
    );
  for (const [name, c] of Object.entries(h.checked))
    if (c.status === 'skipped' && c.role === 'language')
      err(
        'skipped',
        `extractor:${name}`,
        `言語アダプタ ${name} を飛ばしました（${c.reason ?? '理由なし'}）。項目の単位の検査が弱まるので strict では失敗にします`,
      );

  for (const id of h.unjoined.endpointsWithoutHandler)
    warn(
      'endpoint-without-handler',
      `v2:${id}`,
      `handler の無い endpoint ${id}（実装が別の所にあるなら手書きの部分グラフで handler を置く）`,
    );
  const cov = h.adapters.coverage;
  if (cov.boxWires)
    warn(
      'box-wires',
      'v2',
      `口の単位の線 ${cov.boxWires} 本（項目まで下がっていない。インフラの箱は契約で口の単位）`,
    );
  if (h.opaque.boxes.length)
    warn(
      'opaque',
      'v2',
      `不透明な箱 ${h.opaque.boxes.length}（links が無い）: ${list(h.opaque.boxes)}`,
    );
  if (cov.unknownItems) warn('unknown', 'v2', `wireType unknown の項目 ${cov.unknownItems}`);
  const typeRefs = result.v2Warnings.filter((w: ValidationIssue) => w.message.includes('typeRef'));
  if (typeRefs.length) warn('type-ref', 'v2', `types に無い typeRef ${typeRefs.length}`);
  for (const r of h.screens.routes)
    if (r.coverage && r.coverage.reachable > 0 && r.coverage.dom + r.coverage.yaml === 0)
      warn(
        'coverage',
        `screens:${r.route}`,
        `regions のカバー率 0（data-component を付けるか regions.yaml で補う）`,
      );
  const broken = result.graphV2.wires.filter((w) => w.broken?.length).length;
  if (broken) warn('broken', 'v2', `食い違いのある線 ${broken} 本（直すのはコードの側。D69）`);
  for (const id of h.addedWithoutWires)
    warn('added-box', `v2:${id}`, `overrides の nodes で足した箱 ${id} に線がありません`);
  return { errors, warnings };
}

const list = (xs: readonly string[], max = 10) =>
  xs.length > max ? `${xs.slice(0, max).join(', ')} ほか ${xs.length - max}` : xs.join(', ');

/** graph.json に書く報告の一覧の上限（1 つの一覧につき） */
export const REPORT_LIST_MAX = 100;

/** graph.json の project.generator.report（数と一覧の文字列。docs/19 §3.3） */
export function toGraphReport(h: HarnessReport, strict: StrictResult): HarnessReportV2 {
  const sup = countSupplements(h.supplements);
  const cap = (xs: string[]) => xs.slice(0, REPORT_LIST_MAX);
  return {
    version: HARNESS_REPORT_VERSION,
    checked: h.checked,
    counts: {
      unjoined:
        h.unjoined.calls.length + h.unjoined.routesWithoutEndpoint.length + h.unjoined.sql.length,
      endpointsWithoutHandler: h.unjoined.endpointsWithoutHandler.length,
      undetermined: h.undetermined.length,
      opaque: h.opaque.boxes.length,
      crude: h.opaque.crude.length,
      estimates: h.estimates.length,
      screensWithoutHtml: h.screens.configured ? h.screens.routes.filter((r) => !r.html).length : 0,
      supplementsApplied: sup.applied,
      supplementsUnresolved: sup.unresolved,
      supplementsMismatch: sup.mismatch,
      removeMissing: h.removeMissing.length,
      strictErrors: strict.errors.length,
      strictWarnings: strict.warnings.length,
    },
    lists: {
      unjoined: cap([
        ...h.unjoined.calls.map((c) => `${c.item} ${c.method} ${c.path}`),
        ...h.unjoined.routesWithoutEndpoint.map((r) => `${r.box} ${r.method} ${r.path}`),
        ...h.unjoined.sql.map((s) => `${s.item} ${s.table}`),
      ]),
      undetermined: cap(h.undetermined.map((u) => `${u.group} ↔ ${u.peer} (${u.via})`)),
      strictErrors: cap(strict.errors.map((e) => `[${e.rule}] ${e.path}: ${e.message}`)),
    },
  };
}
