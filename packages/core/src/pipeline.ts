/**
 * buildGraph(): 抽出 → マージ → classify → config.deploy → overrides → 層 → flows → キャッシュのルール → 検証
 * → v2 への変換と検証（docs/09 §3.2, docs/12, docs/16 §10）。
 *
 * 結果は v1（`graph`。3D の地図と既存の呼び出し元）と v2（`graphV2`。配線図。`stack-atlas build` の graph.json）の両方。
 * 抽出器は v1 の部分グラフを出し続け、v2 は v1 を upgradeGraph で変換して作る（D38）。
 * 言語アダプタ（ts-types など）と契約（openapi）は v2 の部分グラフ（PartialGraph.v2）も出す。変換した v2 に
 * mergeV2 → join（合流。クライアント側・サーバー側・table）→ overrides の線の削除 → cleanupV2（細かい方が勝つ掃除）
 * → detectBroken の順で重ねる
 * （docs/17 §2・§7 #4・#5、D50・D53）。overrides.yaml は 1 回だけ読み、v1 と v2 の両方に当てる
 *
 * ハーネスの補い（Phase 8-4。docs/19 §2・§3、D67・D73）: 手書きの部分グラフ（`.stack-atlas/graph/*.v2.yaml`。言語アダプタ
 * hand）は抽出の後に v2 の部分グラフへ足す。overrides の `v2:` は 2 段で当てる（段 A: join の後・cleanupV2 の前に
 * wires・remove・nodes と retarget、段 B: cleanupV2 の後に items・variants・links・when）。その後 writeBroken →
 * views.yaml → validateGraphV2 → 段 0 の報告（coverage。数える範囲・言語ごとの読めた行。docs/23 §3.1）→ 最後の graph から
 * 数え直した報告（harness）と strict（strictIssues）。報告は `project.generator.report` にも書く（validate --strict が読む）
 *
 * 秘密らしいファイル（`.env*`・鍵・`*secret*`・認証情報など）と repo の外のファイル（`../`・絶対パス）を `file` に持つ箱は、
 * 抽出器と手書きの部分グラフの `code` を外す（箱は残す。graph.json はエージェントも人も読むので、中身の抜粋を載せない。
 * 2026-11-10 8-4 のレビュー S2。secrets.ts）
 *
 * 複数リポジトリ（config.repos、docs/12 §3.2）: 抽出器ごとに、repo を宣言順に回す
 * （`for extractor { for repo { detect; extract } }`）。そのため後続の抽出器（api-link など）は、
 * 先行する抽出器の **全 repo 分** の結果を upstream で読める。
 * repo が 2 つ以上なら、各抽出器の出力の `file` を直後に `<repo>/` で修飾する（upstream にも修飾済みで渡る）。
 */
import {
  validateGraph,
  validateGraphV2,
  type Graph,
  type GraphNode,
  type GraphV2,
  type Project,
  type ValidationIssue,
} from '@stack-atlas/schema';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRepoContext, loadConfig } from './config.js';
import { applyClassify, repoOfNames } from './classify.js';
import { applyDeployConfig } from './deploy.js';
import { loadFlows } from './flows.js';
import { gitCommit, gitRemote } from './git.js';
import { assignLayers } from './layers.js';
import { silentLogger } from './logger.js';
import { mergePartialGraphs } from './merge.js';
import { disambiguateV2, mergePartialV2 } from './v2-parts.js';
import {
  cleanupV2,
  coverageV2,
  groupInfosV2,
  mergeV2,
  removeOverrideWiresV2,
  type CoverageV2,
} from './merge-v2.js';
import { joinAll, type JoinReport } from './join.js';
import { writeBroken } from './broken-v2.js';
import { addExtractorName } from './meta.js';
import { completeNodes } from './nodes.js';
import { applyOverrides, loadOverrides, OVERRIDES_FILE } from './overrides.js';
import { HAND_ADAPTER, loadHandGraphs } from './hand-graph.js';
import { stripSecretCode } from './secrets.js';
import {
  applySupplementsA,
  applySupplementsB,
  finishRetarget,
  supplementText,
  type PendingWhen,
  type SupplementResult,
} from './supplements.js';
import {
  computeHarnessReport,
  strictIssues,
  toGraphReport,
  type CheckedEntry,
  type HarnessReport,
  type StrictResult,
} from './strict.js';
import { applyViewsYaml } from './views-yaml.js';
import { computeCoverage, coverageIssues, graphFilesOf } from './coverage.js';
import type { UndeterminedWire } from './merge-v2.js';
import { prefixRepoFiles, resolveRepos } from './repo.js';
import { DEFAULT_RULES, runRules, type Rule } from './rules/index.js';
import type {
  BuildIssue,
  Extractor,
  Logger,
  PartialGraph,
  PartialNodeV2,
  StackAtlasConfig,
} from './types.js';
import { upgradeGraph } from './upgrade.js';
import { clone, isPlainObject } from './util.js';

export interface BuildGraphOptions {
  /** config（stack-atlas.config.yaml）のあるディレクトリ。repos 省略時はここが唯一の解析対象 */
  root: string;
  /** 走らせる順に並べた抽出器 */
  extractors: Extractor[];
  log?: Logger;
  /** generatedAt に使う時刻（テスト用） */
  now?: Date;
  /** commit を固定する（テスト用）。false なら付けない。省略時は最初の repo の git rev-parse HEAD */
  commit?: string | false;
  /** 設定を直接渡す（省略時は root から読む） */
  config?: StackAtlasConfig;
  /** キャッシュのルール（省略時は DEFAULT_RULES） */
  rules?: Rule[];
  /**
   * v1 だけを作る（`stack-atlas build --v1`）。v2 への変換と検証をしない（書かない graph の v2 のエラーで失敗させない）。
   * このとき結果の graphV2 は無く、v2Warnings は空
   */
  v1Only?: boolean;
}

export type ExtractorStatus = 'ok' | 'disabled' | 'not-detected' | 'failed';

/** 1 つの repo での抽出器の実行結果 */
export interface RepoExtractorReport {
  status: ExtractorStatus;
  nodes: number;
  edges: number;
  flows: number;
  error?: string;
  /** detect は通ったのに動かせなかった理由（PartialGraph.skipped。go-types の go が無いなど） */
  skipped?: string;
}

/** 抽出器ごとの実行結果（nodes / edges / flows は全 repo の合計） */
export interface ExtractorReport extends RepoExtractorReport {
  name: string;
  /** repo 名 → その repo での結果（宣言順） */
  repos: Record<string, RepoExtractorReport>;
}

export interface BuildGraphResult {
  /** graph.json v1（3D の地図。build は graph.v1.json に書く） */
  graph: Graph;
  /** graph.json v2（箱の単位。docs/16 §10。build は graph.json に書く）。v1Only なら無い */
  graphV2?: GraphV2;
  /**
   * パイプライン（overrides・flows・層）と validateGraph の問題、v2 への変換と validateGraphV2 のエラー
   * （path は `v2:` で始まる）、抽出器の報告（PartialGraph.issues。warning と info）。level: error が 1 つでもあれば失敗扱い
   */
  issues: BuildIssue[];
  /**
   * validateGraphV2 の警告（口の単位の線・wireType unknown など）。箱の単位の変換では全部の箱と線に出るので issues に入れない。
   * 項目まで下げる言語アダプタ（8-2）で減っていく
   */
  v2Warnings: ValidationIssue[];
  /**
   * 言語アダプタを重ねた結果（アダプタの v2 が無ければ無い）: 自動率（項目・線・links）、合流、掃除の数。
   * CLI の build の要約に出す（docs/17 §4）
   */
  v2Adapters?: V2AdapterReport;
  /** 抽出器名 → その抽出器の出力（全 repo 分をマージしたもの。複数 repo なら file は修飾済み） */
  partials: Record<string, PartialGraph>;
  /** 抽出器ごとの実行結果（抽出器の順） */
  reports: ExtractorReport[];
  config: StackAtlasConfig;
  /** 解析した repo（名前 → 絶対パス、宣言順） */
  repos: Record<string, string>;
  /**
   * ハーネスの報告（build --dry-run --json の中身。最後の graph から数え直したもの。docs/19 §3.2）。v1Only なら無い。
   * graph.json には数と一覧の文字列だけを project.generator.report に書く
   */
  harness?: HarnessReport;
  /** strict の判定（strictIssues(result)。build --strict が失敗にするのは errors。docs/19 §3.3）。v1Only なら無い */
  strict?: StrictResult;
}

/** 言語アダプタを重ねた結果の数（docs/17 §4） */
export interface V2AdapterReport {
  /** v2 を出した言語アダプタ（ts-types・go-types。Extractor.v2Role が language） */
  adapters: string[];
  /** v2 を出した契約の抽出器（openapi・sql。Extractor.v2Role が contract） */
  contracts: string[];
  coverage: CoverageV2;
  /** endpoint と照合できた（か、OpenAPI が無く handler と直接結んだ）/ できなかった HTTP の呼び出し */
  joined: number;
  unjoined: string[];
  /**
   * 合流の内訳（docs/17 §3.4。8-2b）: クライアント側（endpoint と結んだ呼び出し・handler と直接結んだもの・必須の役割の
   * 欠け D59）、サーバー側（endpoint と handler の対・endpoint に無い handler のルート・handler の無い endpoint・login）、
   * table（SQL の項目・テーブルの無いもの）
   */
  join: Pick<JoinReport, 'client' | 'server' | 'table'>;
  /** group にした v1 の箱 */
  groups: number;
  /** アダプタの線で置き換えた箱の単位の線 */
  replaced: number;
  /**
   * group になった v1 の箱に残った線のうち、付け替え先を決められず中の全部へ付け替えたもの（overrides の v2.retarget で
   * 決めたものは数えない）
   */
  undetermined: number;
  /** 付け替え先を決められなかった group の端（docs/19 §3.2 の undetermined） */
  undeterminedList?: UndeterminedWire[];
  /** broken を持つ線 */
  broken: number;
}

/** repo ごとの状態 → 抽出器全体の状態（failed > ok > not-detected > disabled） */
function overallStatus(list: RepoExtractorReport[]): ExtractorStatus {
  const order: ExtractorStatus[] = ['failed', 'ok', 'not-detected', 'disabled'];
  for (const s of order) if (list.some((r) => r.status === s)) return s;
  return 'not-detected';
}

export async function buildGraph(opts: BuildGraphOptions): Promise<BuildGraphResult> {
  const log = opts.log ?? silentLogger;
  const configDir = resolve(opts.root);
  const config = opts.config ?? loadConfig(configDir, log);
  const issues: BuildIssue[] = [];
  const partials: Record<string, PartialGraph> = {};
  const reports: ExtractorReport[] = [];

  const resolved = resolveRepos(configDir, config);
  issues.push(...resolved.issues);
  for (const i of resolved.issues) log.error(i.message);
  const repos = resolved.repos;
  const repoNames = Object.keys(repos);
  const multi = repoNames.length > 1;
  const contexts = repoNames.map((name) =>
    createRepoContext(repos[name]!, config, log, { repoName: name, repos, configDir }),
  );
  const tag = (repoName: string, name: string) => (multi ? `[${repoName}] ${name}` : name);

  // 1. 抽出（抽出器の順 × repo の宣言順。後続は先行の結果を upstream で読める）
  let merged: PartialGraph = { nodes: [], edges: [] };
  /** 言語アダプタの箱 id → 持ち主（`<抽出器>@<repo>`。衝突の検出） */
  const v2Owners = new Map<string, string>();
  for (const ex of opts.extractors) {
    const report: ExtractorReport = {
      name: ex.name,
      status: 'ok',
      nodes: 0,
      edges: 0,
      flows: 0,
      repos: {},
    };
    reports.push(report);
    if (config.extractors?.[ex.name] === false) {
      for (const n of repoNames)
        report.repos[n] = { status: 'disabled', nodes: 0, edges: 0, flows: 0 };
      report.status = 'disabled';
      log.info(`- ${ex.name}: 設定で無効（スキップ）`);
      continue;
    }
    const parts: PartialGraph[] = [];
    for (const ctx of contexts) {
      const rr: RepoExtractorReport = { status: 'ok', nodes: 0, edges: 0, flows: 0 };
      report.repos[ctx.repoName] = rr;
      const label = tag(ctx.repoName, ex.name);
      try {
        if (!(await ex.detect(ctx))) {
          rr.status = 'not-detected';
          log.info(`- ${label}: 対象が見つかりません（スキップ）`);
          continue;
        }
        const part = prefixRepoFiles(await ex.extract(ctx, merged), ctx);
        if (part.skipped) rr.skipped = part.skipped;
        // 抽出器の報告は issues.json へ（error は出させない。ビルドを止めるのは検証の役目）
        for (const i of part.issues ?? [])
          issues.push({ ...i, level: i.level === 'info' ? 'info' : 'warning' });
        // 言語アダプタの箱 id の衝突（別のアダプタ・別の repo が先に出した id）は、後の方を file で修飾する（C6）
        if (part.v2 && (ex.v2Role ?? 'language') === 'language') {
          const d = disambiguateV2(part.v2, v2Owners, `${ex.name}@${ctx.repoName}`);
          part.v2 = d.part;
          for (const r of d.renamed) {
            const message = `v2: 箱 id ${r.from} が ${r.other} と ${label} で重なったので、${label} の方を ${r.to} にしました`;
            log.warn(message);
            issues.push({ level: 'warning', path: `v2:node:${r.to}`, message });
          }
        }
        const stamped: PartialGraph = {
          ...part,
          nodes: part.nodes.map((n) => addExtractorName(clone(n), ex.name)),
        };
        parts.push(part);
        merged = mergePartialGraphs([merged, stamped]);
        Object.assign(rr, {
          nodes: part.nodes.length,
          edges: part.edges.length,
          flows: part.flows?.length ?? 0,
        });
        log.info(
          `- ${label}: ノード ${rr.nodes}、エッジ ${rr.edges}${rr.flows ? `、フロー ${rr.flows}` : ''}`,
        );
      } catch (e) {
        rr.status = 'failed';
        rr.error = (e as Error).message;
        issues.push({
          level: 'error',
          path: multi ? `extractor:${ex.name}@${ctx.repoName}` : `extractor:${ex.name}`,
          message: `抽出器 ${label} が失敗しました: ${rr.error}`,
        });
        log.error(`- ${label}: 失敗しました（${rr.error}）`);
      }
    }
    const list = Object.values(report.repos);
    report.status = overallStatus(list);
    for (const r of list) {
      report.nodes += r.nodes;
      report.edges += r.edges;
      report.flows += r.flows;
    }
    const failed = list.find((r) => r.error);
    if (failed?.error) report.error = failed.error;
    const skipped = list.find((r) => r.skipped);
    if (skipped?.skipped) report.skipped = skipped.skipped;
    if (parts.length)
      partials[ex.name] = parts.length === 1 ? parts[0]! : mergePartialGraphs(parts);
  }

  // 1b. 手書きの部分グラフ（言語アダプタ hand。docs/19 §3.1）。アダプタ・契約と同じ id の箱は子の追加だけ（アダプタが勝つ）
  const owned = new Map<string, PartialNodeV2>((merged.v2?.nodes ?? []).map((n) => [n.id, n]));
  const hand = opts.v1Only ? undefined : loadHandGraphs(configDir, owned);
  if (hand) {
    issues.push(...hand.issues);
    if (hand.part) {
      merged = { ...merged, v2: mergePartialV2([merged.v2, hand.part])! };
      partials[HAND_ADAPTER] = { nodes: [], edges: [], v2: hand.part };
    }
    if (hand.files.length)
      log.info(`- ${HAND_ADAPTER}: 手書きの部分グラフ ${hand.files.length} ファイル`);
  }
  // 秘密らしいファイル・repo の外のファイルの code を外す（S2）
  const stripped = stripSecretCode([...merged.nodes, ...(merged.v2?.nodes ?? [])]);
  if (stripped.length)
    issues.push({
      level: 'info',
      path: 'secrets',
      message: `秘密らしいファイルか repo の外のファイルの箱 ${stripped.length} の code（中身の抜粋）を graph に入れませんでした: ${stripped.slice(0, 10).join(', ')}${stripped.length > 10 ? ` ほか ${stripped.length - 10}` : ''}`,
    });

  // 2. kind / name の補完 → classify → config.deploy → overrides
  const repoOf = repoOfNames(repoNames);
  issues.push(...completeNodes(merged));
  const classified = applyClassify(merged, config, repoOf, log);
  const deployed = applyDeployConfig(classified, config, repoOf);
  issues.push(...deployed.issues);
  const configCtx = createRepoContext(configDir, config, log, {
    repoName: multi ? basename(configDir) : (repoNames[0] ?? basename(configDir)),
    repos,
    configDir,
  });
  // overrides.yaml は 1 回だけ読む（v2 にも同じものを当てる。読み直すと警告が 2 回出る）
  const overrides = loadOverrides(configCtx);
  // remove の id は v2 の箱（言語アダプタだけが出す fn: など。その @runtime の複製の元も）にあれば v1 で警告しない（v2 で消える）
  const v2Ids = new Set<string>();
  for (const n of merged.v2?.nodes ?? []) {
    v2Ids.add(n.id);
    if (typeof n.meta?.sharedOf === 'string') v2Ids.add(n.meta.sharedOf);
  }
  const v1Ids = new Set(deployed.graph.nodes.map((n) => n.id));
  const removeMissing = (overrides.remove ?? []).filter(
    (r): r is string => typeof r === 'string' && !v1Ids.has(r) && !v2Ids.has(r),
  );
  const addedBoxes = (overrides.nodes ?? []).map((n) => n.id).filter((id) => !v1Ids.has(id));
  const overridden = applyOverrides(deployed.graph, overrides, OVERRIDES_FILE, { knownIds: v2Ids });
  issues.push(...overridden.issues);
  issues.push(...completeNodes(overridden.graph));

  // 3. 層（kinds[k].layer も既定の割り当てに使う）
  const kinds = { ...(merged.kinds ?? {}) };
  for (const [k, def] of Object.entries(config.kinds ?? {}))
    kinds[k] = { ...(kinds[k] ?? {}), ...def };
  const layered = assignLayers(overridden.graph, { ...config, kinds });
  issues.push(...layered.issues);

  // 4. flows（抽出器のフロー + flows.yaml。同じ id は flows.yaml が勝つ）
  const nodeIds = new Set(layered.graph.nodes.map((n) => n.id));
  const fromYaml = loadFlows(configCtx, nodeIds);
  issues.push(...fromYaml.issues);
  const yamlIds = new Set(fromYaml.flows.map((f) => f.id));
  const flows = [
    ...(layered.graph.flows ?? []).filter((f) => !yamlIds.has(f.id)),
    ...fromYaml.flows,
  ];

  // 5. 組み立て
  const graph: Graph = {
    version: 1,
    project: buildProject(opts, config, configDir, repos, layered.graph.nodes as GraphNode[]),
    layers: layered.graph.layers,
    nodes: layered.graph.nodes.map((n) => cleanNode(n)),
    edges: layered.graph.edges,
  };
  if (flows.length) graph.flows = flows;
  if (Object.keys(kinds).length) graph.kinds = kinds;

  // 6. キャッシュのルール
  runRules(graph, opts.rules ?? DEFAULT_RULES, log);

  // 7. 検証
  const v = validateGraph(graph);
  issues.push(...v.errors);

  // 8. v2 への変換と検証（docs/16 §10）。v1Only なら作らない。
  // v2 のエラーは issues にだけ入れる（v1 の検証エラーと同じく、出すのは build の要約。log にも出すと 2 回出る）
  const result: BuildGraphResult = {
    graph,
    issues,
    v2Warnings: [],
    partials,
    reports,
    config,
    repos,
  };
  if (!opts.v1Only) {
    const v2path = (i: ValidationIssue): ValidationIssue => ({ ...i, path: `v2:${i.path}` });
    let graphV2 = upgradeGraph(graph, { onIssue: (i) => issues.push(v2path(i)) });
    const supplements: SupplementResult[] = [...(hand?.results ?? [])];
    /** 手書きのファイルの結果（ファイル → 結果。端の解けない線・when の解けない線で解けないにする） */
    const handResult = new Map((hand?.results ?? []).map((r) => [r.target ?? '', r]));
    /** when の付いた手書きの線（段 B の後で when のキーを確かめる。重ねるときに写されるので、graph の中の線から引く） */
    const handPending = (wires: GraphV2['wires']): PendingWhen[] =>
      wires.flatMap((w) => {
        const r =
          w.meta?.by === HAND_ADAPTER ? handResult.get(String(w.meta.handFile ?? '')) : undefined;
        return w.when && r ? [{ wire: w, result: r }] : [];
      });
    let groups: ReadonlyMap<string, string[]> = new Map();
    let undeterminedList: UndeterminedWire[] = [];
    let joinReport: Pick<JoinReport, 'client' | 'server' | 'table'> | undefined;
    const roleOf = new Map(opts.extractors.map((e) => [e.name, e.v2Role ?? 'language']));
    const withV2 = Object.entries(partials)
      .filter(([, p]) => p.v2?.nodes.length)
      .map(([name]) => name);
    const adapters = withV2.filter((n) => roleOf.get(n) !== 'contract');
    const contracts = withV2.filter((n) => roleOf.get(n) === 'contract');
    if (merged.v2) {
      // 言語アダプタと契約の v2 を重ねる。overrides は v2 にも当てる（remove の箱・その複製と中の関数の箱、
      // nodes の上書き。remove の線は合流の後）
      const removedIds = new Set(
        (overrides.remove ?? []).filter((r): r is string => typeof r === 'string'),
      );
      const removedNodes = deployed.graph.nodes.filter((n) => removedIds.has(n.id));
      const state = mergeV2(graphV2, merged.v2, { overrides, removedNodes, adapters, contracts });
      // endpoint を受け持つインフラ（v1 の deploy。handler が複数合うときに host で選ぶ。§7 #11）
      const endpointHosts = new Map<string, string[]>();
      for (const e of graph.edges)
        if (e.kind === 'deploy')
          endpointHosts.set(e.to, [...(endpointHosts.get(e.to) ?? []), e.from]);
      const joined = joinAll(state.graph, { endpointHosts, skip: new Set(state.groups.keys()) });
      removeOverrideWiresV2(state, overrides);
      // 補いの段 A（wires・remove・nodes。retarget は cleanupV2 が使う。docs/19 §3.1）
      const stageA = applySupplementsA(state.graph, overrides.v2, { groups: state.groups });
      const cleaned = cleanupV2(state, { pairs: joined.pairs, retarget: stageA.retarget });
      finishRetarget(stageA, cleaned.retargetUsed, cleaned.retargetSatisfied);
      issues.push(...joined.issues, ...cleaned.issues);
      graphV2 = cleaned.graph;
      // 端の解けない手書きの線（typo）: そのファイルを解けない補いにする（黙って落とさない）
      for (const w of cleaned.droppedHand) {
        const r = handResult.get(String(w.meta?.handFile ?? ''));
        if (!r) continue;
        r.status = 'unresolved';
        const what = `線 ${w.from} → ${w.to} の端が graph にありません（箱・項目の id を確かめる）`;
        r.message = r.message ? `${r.message}。${what}` : what;
      }
      // 補いの段 B（items・variants・links・when）は掃除（`_` の crude の links）の後
      const stageB = applySupplementsB(graphV2, overrides.v2, {
        pendingWhen: [...stageA.pendingWhen, ...handPending(graphV2.wires)],
      });
      supplements.push(...stageA.results, ...stageB);
      const broken = writeBroken(graphV2, { fixed: joined.fixedBroken });
      groups = state.groups;
      undeterminedList = cleaned.undeterminedList;
      joinReport = { client: joined.client, server: joined.server, table: joined.table };
      result.v2Adapters = {
        adapters,
        contracts,
        coverage: coverageV2(graphV2),
        joined: joined.client.matched + joined.client.direct,
        unjoined: joined.client.unmatched,
        join: joinReport,
        groups: cleaned.groups,
        replaced: cleaned.replaced,
        undetermined: cleaned.undetermined,
        undeterminedList,
        broken,
      };
    } else if (overrides.v2) {
      // 言語アダプタが無くても補いは当てる（箱の単位の graph の線・箱）
      const stageA = applySupplementsA(graphV2, overrides.v2);
      finishRetarget(stageA, new Set());
      supplements.push(...stageA.results, ...applySupplementsB(graphV2, overrides.v2, stageA));
    }
    // views.yaml（同じ id は flows.yaml 由来の view に勝つ。docs/19 §3.4）
    const views = applyViewsYaml(graphV2, configDir, groups);
    issues.push(...views.issues);
    supplements.push(...views.results);
    for (const r of supplements) {
      if (r.status === 'applied' && !r.noReason) continue;
      if (r.kind === 'hand' && r.status === 'applied') continue;
      if (r.kind === 'view' && r.status === 'applied') continue;
      issues.push({
        level: 'warning',
        path: `supplements:${r.kind}`,
        message:
          r.status === 'applied'
            ? `${supplementText(r)}。reason がありません（strict ではエラー）`
            : supplementText(r),
      });
    }
    // group になった v1 の箱の元の名前・kind・file（3D の地図の group のノードに使う。Phase 8-6、docs/20 §5.1 #3）
    const groupInfo = groupInfosV2(graphV2, graph);
    if (groupInfo.length) graphV2.groups = groupInfo;
    else delete graphV2.groups;
    const v2 = validateGraphV2(graphV2);
    issues.push(...v2.errors.map(v2path));
    result.graphV2 = graphV2;
    result.v2Warnings = v2.warnings;

    // ハーネスの報告と strict（最後の graph から数え直す。D73）
    const checked: Record<string, CheckedEntry> = {};
    for (const r of reports) {
      const role = opts.extractors.find((e) => e.name === r.name)?.v2Role;
      // failed（ある repo で失敗）を skipped（別の repo で飛ばした）で隠さない（2026-11-10 8-4 のレビュー）
      const c: CheckedEntry = {
        status: r.status === 'failed' ? 'failed' : r.skipped ? 'skipped' : r.status,
      };
      if (role) c.role = role;
      const reason = r.status === 'failed' ? (r.error ?? r.skipped) : (r.skipped ?? r.error);
      if (reason) c.reason = reason;
      checked[r.name] = c;
    }
    // 手書きの部分グラフ: ファイルごとの結果を映す（全部が解けなければ failed。2026-11-10 8-4 のレビュー）
    const handFiles = supplements.filter((r) => r.kind === 'hand');
    const handBad = handFiles.filter((r) => r.status !== 'applied').length;
    checked[HAND_ADAPTER] = !handFiles.length
      ? { status: 'not-detected', role: 'language' }
      : handBad === handFiles.length
        ? {
            status: 'failed',
            role: 'language',
            reason: `手書きのファイル ${handFiles.length} がどれも解けません（supplements の kind hand）`,
          }
        : {
            status: 'ok',
            role: 'language',
            ...(handBad
              ? {
                  reason: `${handFiles.length} ファイルのうち ${handBad} が解けません（supplements の kind hand）`,
                }
              : {}),
          };
    // 段 0 の報告（数える範囲・言語ごとの読めた行。docs/23 §3.1、Phase 9-L0）。読めていないソースは言語ごとに警告
    const coverage = computeCoverage({
      repos,
      configDir,
      config,
      partials,
      roles: new Map(opts.extractors.map((e) => [e.name, e.v2Role])),
      graphFiles: graphFilesOf(graph.nodes, graphV2.nodes, graphV2.types, graphV2.groups),
    });
    issues.push(...coverageIssues(coverage));
    result.harness = computeHarnessReport({
      coverage,
      graph: graphV2,
      ...(joinReport ? { join: joinReport } : {}),
      undetermined: undeterminedList,
      supplements,
      removeMissing,
      addedBoxes,
      checked,
      adapters,
      contracts,
      issues,
      config,
      multi,
    });
    if (result.v2Adapters)
      result.v2Adapters.unjoined = result.harness.unjoined.calls.map(
        (c) => `${c.box} ${c.method} ${c.path}`,
      );
    result.strict = strictIssues(result);
    const project = (graphV2.project ??= {});
    project.generator = {
      ...(project.generator ?? {}),
      report: toGraphReport(result.harness, result.strict),
    };
  }
  return result;
}

/** undefined のフィールドを落とし、フィールド順を graph.json の慣例に揃える */
function cleanNode(n: object): GraphNode {
  const order = [
    'id',
    'layer',
    'kind',
    'name',
    'file',
    'line',
    'code',
    'position',
    'cache',
    'screen',
    'meta',
  ];
  const out: Record<string, unknown> = {};
  for (const k of order)
    if ((n as Record<string, unknown>)[k] !== undefined) out[k] = (n as Record<string, unknown>)[k];
  for (const [k, v] of Object.entries(n)) if (!(k in out) && v !== undefined) out[k] = v;
  return out as unknown as GraphNode;
}

function packageName(root: string): string | undefined {
  const p = join(root, 'package.json');
  if (!existsSync(p)) return undefined;
  try {
    const pkg: unknown = JSON.parse(readFileSync(p, 'utf8'));
    return isPlainObject(pkg) && typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function buildProject(
  opts: BuildGraphOptions,
  config: StackAtlasConfig,
  configDir: string,
  repos: Record<string, string>,
  nodes: GraphNode[],
): Project {
  const names = Object.keys(repos);
  const multi = names.length > 1;
  const first = names.length ? repos[names[0]!]! : configDir;
  const project: Project = {
    name: config.project?.name ?? packageName(configDir) ?? basename(configDir),
  };
  if (config.project?.description) project.description = config.project.description;
  const repo =
    config.project?.repo ?? gitRemote(first) ?? (multi ? basename(configDir) : undefined);
  if (repo) project.repo = repo;
  const commit = opts.commit === undefined ? gitCommit(first) : opts.commit || undefined;
  if (commit) project.commit = commit;
  project.generatedAt = (opts.now ?? new Date()).toISOString();
  const sources = multi
    ? names
    : [
        ...new Set(
          nodes
            .map((n) => n.file?.replace(/\\/g, '/').split('/')[0])
            .filter((s): s is string => !!s),
        ),
      ];
  if (sources.length) project.sources = sources;
  return project;
}
