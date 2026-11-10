/**
 * buildGraph(): 抽出 → マージ → classify → config.deploy → overrides → 層 → flows → キャッシュのルール → 検証
 * → v2 への変換と検証（docs/09 §3.2, docs/12, docs/16 §10）。
 *
 * 結果は v1（`graph`。3D の地図と既存の呼び出し元）と v2（`graphV2`。配線図。`stack-atlas build` の graph.json）の両方。
 * 抽出器は v1 の部分グラフを出し続け、v2 は v1 を upgradeGraph で変換して作る（D38）。
 * 言語アダプタ（ts-types など）と契約（openapi）は v2 の部分グラフ（PartialGraph.v2）も出す。変換した v2 に
 * mergeV2 → join（合流）→ overrides の線の削除 → cleanupV2（細かい方が勝つ掃除）→ detectBroken の順で重ねる
 * （docs/17 §2・§7 #4・#5、D50・D53）。overrides.yaml は 1 回だけ読み、v1 と v2 の両方に当てる
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
import {
  cleanupV2,
  coverageV2,
  mergeV2,
  removeOverrideWiresV2,
  type CoverageV2,
} from './merge-v2.js';
import { joinEndpoints } from './join.js';
import { writeBroken } from './broken-v2.js';
import { addExtractorName } from './meta.js';
import { completeNodes } from './nodes.js';
import { applyOverrides, loadOverrides } from './overrides.js';
import { prefixRepoFiles, resolveRepos } from './repo.js';
import { DEFAULT_RULES, runRules, type Rule } from './rules/index.js';
import type { Extractor, Logger, PartialGraph, StackAtlasConfig } from './types.js';
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
   * （path は `v2:` で始まる）。level: error が 1 つでもあれば失敗扱い
   */
  issues: ValidationIssue[];
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
}

/** 言語アダプタを重ねた結果の数（docs/17 §4） */
export interface V2AdapterReport {
  /** v2 を出した言語アダプタ（ts-types・go-types。Extractor.v2Role が language） */
  adapters: string[];
  /** v2 を出した契約の抽出器（openapi・sql。Extractor.v2Role が contract） */
  contracts: string[];
  coverage: CoverageV2;
  /** endpoint と照合できた / できなかった HTTP の呼び出し */
  joined: number;
  unjoined: string[];
  /** group にした v1 の箱 */
  groups: number;
  /** アダプタの線で置き換えた箱の単位の線 */
  replaced: number;
  /** group になった v1 の箱に残った線のうち、付け替え先を決められず中の全部へ付け替えたもの */
  undetermined: number;
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
  const issues: ValidationIssue[] = [];
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
    if (parts.length)
      partials[ex.name] = parts.length === 1 ? parts[0]! : mergePartialGraphs(parts);
  }

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
  const overridden = applyOverrides(deployed.graph, overrides);
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
    if (merged.v2) {
      // 言語アダプタと契約の v2 を重ねる。overrides は v2 にも当てる（remove の箱・その複製と中の関数の箱、
      // nodes の上書き。remove の線は合流の後）
      const removedIds = new Set(
        (overrides.remove ?? []).filter((r): r is string => typeof r === 'string'),
      );
      const removedNodes = deployed.graph.nodes.filter((n) => removedIds.has(n.id));
      const roleOf = new Map(opts.extractors.map((e) => [e.name, e.v2Role ?? 'language']));
      const withV2 = Object.entries(partials)
        .filter(([, p]) => p.v2?.nodes.length)
        .map(([name]) => name);
      const adapters = withV2.filter((n) => roleOf.get(n) !== 'contract');
      const contracts = withV2.filter((n) => roleOf.get(n) === 'contract');
      const state = mergeV2(graphV2, merged.v2, { overrides, removedNodes, adapters, contracts });
      const joined = joinEndpoints(state.graph);
      removeOverrideWiresV2(state, overrides);
      const cleaned = cleanupV2(state);
      issues.push(...joined.issues, ...cleaned.issues);
      graphV2 = cleaned.graph;
      const broken = writeBroken(graphV2);
      result.v2Adapters = {
        adapters,
        contracts,
        coverage: coverageV2(graphV2),
        joined: joined.matched,
        unjoined: joined.unmatched,
        groups: cleaned.groups,
        replaced: cleaned.replaced,
        undetermined: cleaned.undetermined,
        broken,
      };
    }
    const v2 = validateGraphV2(graphV2);
    issues.push(...v2.errors.map(v2path));
    result.graphV2 = graphV2;
    result.v2Warnings = v2.warnings;
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
