/**
 * buildGraph(): 抽出 → マージ → config.deploy → overrides → 層 → flows → キャッシュのルール → 検証（docs/09 §3.2）。
 */
import {
  validateGraph,
  type Graph,
  type GraphNode,
  type Project,
  type ValidationIssue,
} from '@stack-atlas/schema';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createRepoContext, loadConfig } from './config.js';
import { applyDeployConfig } from './deploy.js';
import { loadFlows } from './flows.js';
import { gitCommit, gitRemote } from './git.js';
import { assignLayers } from './layers.js';
import { silentLogger } from './logger.js';
import { mergePartialGraphs } from './merge.js';
import { addExtractorName } from './meta.js';
import { completeNodes } from './nodes.js';
import { applyOverrides, loadOverrides } from './overrides.js';
import { DEFAULT_RULES, runRules, type Rule } from './rules/index.js';
import type { Extractor, Logger, PartialGraph, StackAtlasConfig } from './types.js';
import { clone, isPlainObject } from './util.js';

export interface BuildGraphOptions {
  /** 解析対象リポジトリ（stack-atlas.config.yaml のあるディレクトリ） */
  root: string;
  /** 走らせる順に並べた抽出器 */
  extractors: Extractor[];
  log?: Logger;
  /** generatedAt に使う時刻（テスト用） */
  now?: Date;
  /** commit を固定する（テスト用）。false なら付けない。省略時は git rev-parse HEAD */
  commit?: string | false;
  /** 設定を直接渡す（省略時は root から読む） */
  config?: StackAtlasConfig;
  /** キャッシュのルール（省略時は DEFAULT_RULES） */
  rules?: Rule[];
}

export interface ExtractorReport {
  name: string;
  status: 'ok' | 'disabled' | 'not-detected' | 'failed';
  nodes: number;
  edges: number;
  flows: number;
  error?: string;
}

export interface BuildGraphResult {
  graph: Graph;
  /** パイプライン（overrides・flows・層）と validateGraph の問題。level: error が 1 つでもあれば失敗扱い */
  issues: ValidationIssue[];
  /** 抽出器名 → その抽出器の生の出力 */
  partials: Record<string, PartialGraph>;
  /** 抽出器ごとの実行結果 */
  reports: ExtractorReport[];
  config: StackAtlasConfig;
}

export async function buildGraph(opts: BuildGraphOptions): Promise<BuildGraphResult> {
  const log = opts.log ?? silentLogger;
  const config = opts.config ?? loadConfig(opts.root, log);
  const ctx = createRepoContext(opts.root, config, log);
  const issues: ValidationIssue[] = [];
  const partials: Record<string, PartialGraph> = {};
  const reports: ExtractorReport[] = [];

  // 1. 抽出（順番に。後続は先行の結果を upstream で読める）
  let merged: PartialGraph = { nodes: [], edges: [] };
  for (const ex of opts.extractors) {
    const report: ExtractorReport = { name: ex.name, status: 'ok', nodes: 0, edges: 0, flows: 0 };
    reports.push(report);
    if (config.extractors?.[ex.name] === false) {
      report.status = 'disabled';
      log.info(`- ${ex.name}: 設定で無効（スキップ）`);
      continue;
    }
    try {
      if (!(await ex.detect(ctx))) {
        report.status = 'not-detected';
        log.info(`- ${ex.name}: 対象が見つかりません（スキップ）`);
        continue;
      }
      const part = await ex.extract(ctx, merged);
      const stamped: PartialGraph = {
        ...part,
        nodes: part.nodes.map((n) => addExtractorName(clone(n), ex.name)),
      };
      partials[ex.name] = part;
      merged = mergePartialGraphs([merged, stamped]);
      Object.assign(report, {
        nodes: part.nodes.length,
        edges: part.edges.length,
        flows: part.flows?.length ?? 0,
      });
      log.info(
        `- ${ex.name}: ノード ${report.nodes}、エッジ ${report.edges}${report.flows ? `、フロー ${report.flows}` : ''}`,
      );
    } catch (e) {
      report.status = 'failed';
      report.error = (e as Error).message;
      issues.push({
        level: 'error',
        path: `extractor:${ex.name}`,
        message: `抽出器 ${ex.name} が失敗しました: ${report.error}`,
      });
      log.error(`- ${ex.name}: 失敗しました（${report.error}）`);
    }
  }

  // 2. kind / name の補完 → config.deploy → overrides
  issues.push(...completeNodes(merged));
  const deployed = applyDeployConfig(merged, config);
  issues.push(...deployed.issues);
  const overridden = applyOverrides(deployed.graph, loadOverrides(ctx));
  issues.push(...overridden.issues);
  issues.push(...completeNodes(overridden.graph));

  // 3. 層
  const layered = assignLayers(overridden.graph, config);
  issues.push(...layered.issues);

  // 4. flows（抽出器のフロー + flows.yaml。同じ id は flows.yaml が勝つ）
  const nodeIds = new Set(layered.graph.nodes.map((n) => n.id));
  const fromYaml = loadFlows(ctx, nodeIds);
  issues.push(...fromYaml.issues);
  const yamlIds = new Set(fromYaml.flows.map((f) => f.id));
  const flows = [
    ...(layered.graph.flows ?? []).filter((f) => !yamlIds.has(f.id)),
    ...fromYaml.flows,
  ];

  // 5. 組み立て
  const graph: Graph = {
    version: 1,
    project: buildProject(opts, config, layered.graph.nodes as GraphNode[]),
    layers: layered.graph.layers,
    nodes: layered.graph.nodes.map((n) => cleanNode(n)),
    edges: layered.graph.edges,
  };
  if (flows.length) graph.flows = flows;

  // 6. キャッシュのルール
  runRules(graph, opts.rules ?? DEFAULT_RULES, log);

  // 7. 検証
  const v = validateGraph(graph);
  issues.push(...v.errors);

  return { graph, issues, partials, reports, config };
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
  nodes: GraphNode[],
): Project {
  const root = createRepoContext(opts.root, config).root;
  const project: Project = { name: config.project?.name ?? packageName(root) ?? basename(root) };
  if (config.project?.description) project.description = config.project.description;
  const repo = config.project?.repo ?? gitRemote(root);
  if (repo) project.repo = repo;
  const commit = opts.commit === undefined ? gitCommit(root) : opts.commit || undefined;
  if (commit) project.commit = commit;
  project.generatedAt = (opts.now ?? new Date()).toISOString();
  const sources = [
    ...new Set(
      nodes.map((n) => n.file?.replace(/\\/g, '/').split('/')[0]).filter((s): s is string => !!s),
    ),
  ];
  if (sources.length) project.sources = sources;
  return project;
}
