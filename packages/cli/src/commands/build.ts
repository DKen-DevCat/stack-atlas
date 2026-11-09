/**
 * `stack-atlas build <repo> [-o <outDir>] [--with-viewer] [--no-screenshots] [--v1]`
 *
 * <repo> は stack-atlas.config.yaml のあるディレクトリ。config に `repos` があれば、そこに並べた repo をまとめて解析する
 * （docs/12 §3.2）。overrides / flows / memos は <repo> から読む。
 *
 * out/ に graph.json（v2。配線図）・graph.v1.json（v1。3D の地図）・issues.json・memos.json（.stack-atlas/memos.json
 * があれば）を書く（docs/16 §10）。--v1 なら従来どおり graph.json に v1 だけを書く（graph.v1.json は消し、v2 は作らない）。
 * --with-viewer ならビューアの dist/ も同梱し、out/ をそのまま静的ホスティングできる形にする。
 *
 * 出力先の既定（<repo>/.stack-atlas/out）は解析対象の repo の中にある。repo がそこにシンボリックリンクを置いて
 * 別のファイルを書き換えさせないよう、書く前に出力先のリンクを確かめ、あれば書かずに終了コード 2 にする（unsafeOutputs）。
 *
 * screens 抽出器（docs/18 §3.3）は消毒した画面の HTML と資産を、出力先の中の一時ディレクトリ（.screens-staging-*）の
 * screens/ に書く。build が成功して graph.json を書くときに、前回の screens/（印のファイルがあるものだけ）と入れ替える
 * （swapScreens。失敗した build は前回の screens/ を残す）。出力先の screens/ が印の無いディレクトリなら、
 * 画面を書かずに警告する（利用者のディレクトリを消さない。screensDirState）。
 *
 * スクショ抽出器の書き出し先（config.screenshots.outDir）は、解析対象の repo の設定なので信用しない。
 * build の出力先そのものだけにする（confineShotsOutDir。graph.json は shots/… で参照するので、ほかは警告して出力先にする）。
 */
import {
  AtlasConfigError,
  SCREENS_DIR,
  SCREENS_MARKER,
  buildGraph,
  createConsoleLogger,
  loadConfig,
  loadMemos,
  memosFile,
  orphanMemos,
  pathWithin,
  screensDirState,
  screensSkipMessage,
  serializeMemos,
  type BuildGraphResult,
  type Extractor,
  type Logger,
  type V2AdapterReport,
} from '@stack-atlas/core';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadExtractors } from '../extractors.js';
import { VIEWER_DIST } from '../paths.js';

export interface BuildOptions {
  repo: string;
  outDir?: string;
  withViewer?: boolean;
  screenshots?: boolean;
  log?: Logger;
  /** 抽出器の差し替え（テスト用）。省略時は抽出器パッケージを動的 import */
  extractors?: Extractor[];
  viewerDist?: string;
  /** graph.json に v1 だけを書く（Phase 8-1 より前の出力。graph.v1.json は書かない） */
  v1Only?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  disabled: '設定で無効',
  'not-detected': '対象なし',
  failed: '失敗',
};

/** build の結果を日本語の要約にする。v1Only なら graph.json は v1 */
export function formatBuildSummary(
  res: BuildGraphResult,
  outDir: string,
  orphans: string[] = [],
  v1Only = false,
): string {
  const { graph, graphV2, reports, issues } = res;
  const lines = ['', '── Stack Atlas build ──'];
  lines.push('抽出器:');
  if (!reports.length) lines.push('  （なし）');
  const multi = Object.keys(res.repos ?? {}).length > 1;
  for (const r of reports) {
    const perRepo = Object.entries(r.repos ?? {}).filter(
      ([, rr]) => rr.status === 'ok' || rr.status === 'failed',
    );
    if (multi && perRepo.length) {
      // 複数 repo: 動いた（か失敗した）repo ごとに 1 行
      for (const [repo, rr] of perRepo) {
        lines.push(
          rr.status === 'ok'
            ? `  ${r.name} (${repo}): ノード ${rr.nodes}、エッジ ${rr.edges}${rr.flows ? `、フロー ${rr.flows}` : ''}`
            : `  ${r.name} (${repo}): ${STATUS_LABEL.failed}${rr.error ? `（${rr.error}）` : ''}`,
        );
      }
      continue;
    }
    lines.push(
      r.status === 'ok'
        ? `  ${r.name}: ノード ${r.nodes}、エッジ ${r.edges}、フロー ${r.flows}`
        : `  ${r.name}: ${STATUS_LABEL[r.status] ?? r.status}${r.error ? `（${r.error}）` : ''}`,
    );
  }
  lines.push(
    `結果: ノード ${graph.nodes.length}、エッジ ${graph.edges.length}、フロー ${graph.flows?.length ?? 0}、層 ${graph.layers.length}`,
  );
  if (!v1Only && graphV2) {
    const frames = new Set(graphV2.nodes.map((n) => n.host).filter((h): h is string => !!h));
    const a = res.v2Adapters;
    lines.push(
      `v2: 箱 ${graphV2.nodes.length}（うち枠 ${frames.size}）、線 ${graphV2.wires.length}、型 ${graphV2.types?.length ?? 0}、view ${graphV2.views?.length ?? 0}` +
        `（v2 の警告 ${res.v2Warnings.length} 件。${a ? '言語アダプタの無い所に' : '箱の単位の変換なので'}口の単位の線が残る。stack-atlas validate で一覧）`,
    );
    if (a) lines.push(...formatAdapterSummary(a));
  }
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  // info は数字の報告（画面のカバー率・消毒で落としたもの。8-3b）。問題の件数にも終了コードにも数えない
  const infos = issues.filter((i) => i.level === 'info');
  if (infos.length) {
    lines.push(`報告（issues.json の info）: ${infos.length} 件`);
    for (const i of infos) lines.push(`  ${i.path}: ${i.message}`);
  }
  lines.push(`問題: エラー ${errors.length} 件、警告 ${warnings.length} 件`);
  for (const i of [...errors, ...warnings]) {
    lines.push(`  [${i.level === 'error' ? 'エラー' : '警告'}] ${i.path}: ${i.message}`);
  }
  if (orphans.length) lines.push(`孤立メモ（graph に無いノード ID）: ${orphans.join(', ')}`);
  if (v1Only) lines.push(`出力: ${join(outDir, 'graph.json')}（v1）`);
  else {
    lines.push(`出力: ${join(outDir, 'graph.json')}（v2。配線図）`);
    lines.push(`      ${join(outDir, 'graph.v1.json')}（v1。3D の地図）`);
  }
  return lines.join('\n');
}

/**
 * 言語アダプタの自動率（docs/17 §4）: 項目（unknown）、線（項目の単位 / 箱の単位、うち呼び出しでない参照）、
 * links（exact / crude）と不透明な箱、合流（クライアント側・サーバー側・table と、結べないもの）と掃除の数
 */
export function formatAdapterSummary(a: V2AdapterReport): string[] {
  const c = a.coverage;
  const { client, server, table } = a.join;
  /** 内訳（0 のものは書かない。全部 0 なら括弧ごと書かない） */
  const detail = (parts: Array<[string, number]>) => {
    const xs = parts.filter(([, n]) => n > 0).map(([what, n]) => `${what} ${n}`);
    return xs.length ? `（${xs.join('、')}）` : '';
  };
  const lines = [
    `言語アダプタ（${a.adapters.join(', ') || 'なし'}）${a.contracts.length ? `・契約（${a.contracts.join(', ')}）` : ''}: 項目 ${c.items}（unknown ${c.unknownItems}）、` +
      `線 ${c.wires}（項目 ${c.itemWires} / 箱の単位 ${c.boxWires}、うち呼び出しでない参照 ${c.refWires}）、` +
      `links ${c.links}（exact ${c.exactLinks} / crude ${c.crudeLinks}）・不透明な箱 ${c.opaqueBoxes}`,
    `  合流: クライアント側 ${client.matched + client.direct}` +
      detail([
        ['endpoint', client.direct ? client.matched : 0],
        ['handler へ直接', client.direct],
        ['結べない', client.unmatched.length],
        ['必須の役割の欠け', client.missing],
      ]) +
      `、サーバー側 ${server.matched}` +
      detail([
        ['endpoint に無い handler のルート', server.unmatched.length],
        ['handler の無い endpoint', server.withoutHandler.length],
        ['login の分岐', server.login],
      ]) +
      `、table ${table.matched}` +
      detail([['テーブルの無い SQL', table.unmatched.length]]),
    `  掃除: group にした v1 の箱 ${a.groups}、項目の線で置き換えた箱の単位の線 ${a.replaced}` +
      `、付け替え先を決められない線 ${a.undetermined}${a.undetermined ? '（group の中の全部へ）' : ''}、食い違いのある線 ${a.broken}`,
  ];
  return lines;
}

const isSymlink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true;

/**
 * スクショの書き出し先（config.screenshots.outDir。PNG は <ここ>/shots/ に書く）を決める。
 * 値は config のあるディレクトリ（repo）基準の相対パスで、build の出力先 outDir **そのもの**だけを受け付ける。
 * 無ければ outDir。絶対パス・文字列でない・出力先の外（`..` で出るものも）・出力先の下のディレクトリは警告して outDir にする
 * （解析対象の repo の設定で、PNG を出力先の外の任意の場所に書かせない。2026-11-09（8-3b のレビュー）: 出力先の下も
 * 受け付けていたが、スクショ抽出器は graph.json からの参照を shots/<slug>.png と書くので、下のディレクトリでは画像が開けなかった）
 */
export function confineShotsOutDir(
  repo: string,
  outDir: string,
  value: unknown,
  log?: Logger,
): string {
  if (value === undefined) return outDir;
  const fallback = (why: string) => {
    log?.warn(
      `screenshots.outDir ${JSON.stringify(value)} ${why}ので使いません（スクショは出力先 ${outDir} の shots/ に書きます）`,
    );
    return outDir;
  };
  if (typeof value !== 'string' || !value) return fallback('は文字列でない');
  if (isAbsolute(value)) return fallback('は絶対パスな');
  const abs = resolve(repo, value);
  if (!pathWithin(outDir, abs, true)) return fallback('は build の出力先の外を指す');
  if (abs !== resolve(outDir))
    return fallback('は build の出力先の下のディレクトリ（graph.json は shots/… で参照する）な');
  return outDir;
}

/**
 * build が書く・消すパスのうち、シンボリックリンクになっているもの（解析対象の repo が置いたリンクで、repo の外の
 * ファイルを書き換えないため）。調べるのは:
 * - 出力先が repo の中なら、repo から出力先までの各ディレクトリ（`.stack-atlas` や `out` 自体のリンク）。
 *   repo の外の出力先（-o で利用者が選んだ場所）は、それ自体がリンクでも調べない
 * - graph.json・graph.v1.json・issues.json・memos.json（--v1 で消す graph.v1.json も。消すのはリンクそのものだが、
 *   リンクがある出力先は信用しない）
 * - スクショの置き場 shots/ とその中の項目（スクショ抽出器は <outDir>/shots/<slug>.png に書く）
 * - screens が true のとき（この build が screens/ を消すか書く。印のある screens/ か、screens を設定していて印の無い
 *   ディレクトリでないとき）だけ、画面の置き場 screens/ と、その中の全部。2026-11-09（8-3b のレビュー）: 以前は
 *   触らない screens/ の中まで調べ、利用者のディレクトリのリンクで build を止めていた
 * - --with-viewer で写すビューアの各ファイル・ディレクトリの写し先（cpSync は写し先のリンクをたどって書く）
 */
export function unsafeOutputs(
  repo: string,
  outDir: string,
  viewerDist?: string,
  screens = false,
): string[] {
  const found: string[] = [];
  const check = (p: string) => {
    if (isSymlink(p)) found.push(p);
  };
  const rel = relative(repo, outDir);
  if (pathWithin(repo, outDir)) {
    let p = repo;
    for (const seg of rel.split(sep)) {
      p = join(p, seg);
      check(p);
    }
  }
  if (found.length) return found; // 出力先そのものがリンクなら、中は見ない（リンクの先を調べることになる）
  for (const f of ['graph.json', 'graph.v1.json', 'issues.json', 'memos.json'])
    check(join(outDir, f));
  const shots = join(outDir, 'shots');
  check(shots);
  if (!found.includes(shots) && existsSync(shots) && statSync(shots).isDirectory()) {
    for (const d of readdirSync(shots)) check(join(shots, d));
  }
  const screensDir = join(outDir, SCREENS_DIR);
  if (screens) check(screensDir);
  if (screens && !found.includes(screensDir)) {
    const walk = (dir: string) => {
      if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isSymbolicLink()) found.push(p);
        else if (d.isDirectory()) walk(p);
      }
    };
    walk(screensDir);
  }
  if (viewerDist) {
    const walk = (src: string, dest: string) => {
      for (const d of readdirSync(src, { withFileTypes: true })) {
        const to = join(dest, d.name);
        if (isSymlink(to)) found.push(to);
        else if (d.isDirectory() && existsSync(to)) walk(join(src, d.name), to);
      }
    };
    if (existsSync(outDir)) walk(viewerDist, outDir);
  }
  return found;
}

/**
 * 成功した build の画面を出力先に置く: 前回の screens/（印 screens/.stack-atlas-screens があるものだけ）を消し、
 * stage（この build の一時ディレクトリ）の screens/ を印があれば screens/ に移す（rename。同じ出力先の中なので一度に入れ替わる）。
 * stage が無い（screens を設定していない・印の無い screens/ で書かなかった）ときは前回の分を消すだけ。
 * 印の無い screens/ には触らない。中のシンボリックリンクは unsafeOutputs で先に止めてある（rmSync はリンクを辿らずに消す）。
 * 2026-11-09（8-3b のレビュー）: 以前は抽出の前に消していたので、失敗した build の後の graph.json（前回の分）が消した画面を指した
 */
export function swapScreens(outDir: string, stage: string | undefined, log?: Logger): void {
  const dir = join(outDir, SCREENS_DIR);
  const before = screensDirState(outDir);
  if (before === 'ours') rmSync(dir, { recursive: true, force: true });
  else if (before !== 'absent')
    log?.debug(`${dir} は screens 抽出器が書いたものではない（印が無い）ので消さない`);
  if (!stage) return;
  const fresh = join(stage, SCREENS_DIR);
  if (!lstatSync(join(fresh, SCREENS_MARKER), { throwIfNoEntry: false })?.isFile()) return;
  if (screensDirState(outDir) !== 'absent') {
    log?.warn(screensSkipMessage('foreign'));
    return;
  }
  renameSync(fresh, dir);
}

export async function runBuild(opts: BuildOptions): Promise<number> {
  const log = opts.log ?? createConsoleLogger();
  const repo = resolve(opts.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    log.error(`リポジトリ ${repo} がありません`);
    return 2;
  }
  const outDir = resolve(opts.outDir ?? join(repo, '.stack-atlas', 'out'));
  const viewerDist = opts.viewerDist ?? VIEWER_DIST;
  if (opts.withViewer && !existsSync(join(viewerDist, 'index.html'))) {
    log.error(
      `ビューアのビルド成果物（${viewerDist}）がありません。先に pnpm build を実行してください`,
    );
    return 2;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(repo, log);
  } catch (e) {
    if (e instanceof AtlasConfigError) {
      log.error(e.message);
      return 2;
    }
    throw e;
  }
  // スクショ抽出器は <shotsOutDir>/shots/<slug>.png に書き、graph.json からは shots/… で参照する。
  // そのため graph.json と同じディレクトリ。設定ファイルの値は出力先そのものだけ（confineShotsOutDir）
  const shotsOutDir = confineShotsOutDir(repo, outDir, config.screenshots?.outDir, log);

  // 画面（screens）: 出力先の screens/ が印の無いディレクトリなら、この build では書かない（消しもしない）
  const screensState = screensDirState(outDir);
  const screensBlocked = !!config.screens && screensState === 'foreign';
  if (screensBlocked) log.warn(`screens: ${screensSkipMessage('foreign')}`);
  const touchesScreens = screensState === 'ours' || (!!config.screens && !screensBlocked);

  const unsafe = unsafeOutputs(
    repo,
    outDir,
    opts.withViewer ? viewerDist : undefined,
    touchesScreens,
  );
  if (unsafe.length) {
    log.error(
      `出力先にシンボリックリンクがあるので書きません（リンクの先のファイルを書き換えないため）: ${unsafe.join(', ')}。` +
        'リンクを消すか、-o で別の出力先を指定してください',
    );
    return 2;
  }

  let res: BuildGraphResult;
  // screens 抽出器の書き出し先（出力先の中の一時ディレクトリ。成功したら swapScreens で screens/ に入れ替える）
  let stage: string | undefined;
  try {
    config.screenshots = { ...config.screenshots, outDir: shotsOutDir };
    // screens 抽出器は <stage>/screens/ に書き、graph.json からは screens/… で参照する（設定ファイルの outDir は
    // checkConfig が外す。repo の設定で出力先の外に書かせない）。印の無い screens/ があれば outDir を渡さない（書かない）
    if (config.screens && !screensBlocked) {
      mkdirSync(outDir, { recursive: true });
      stage = mkdtempSync(join(outDir, '.screens-staging-'));
      config.screens = { ...config.screens, outDir: stage };
    }
    log.info(`解析中: ${repo}`);
    const repoEntries = Object.entries(config.repos ?? {});
    if (repoEntries.length) {
      log.info(`repo（${repoEntries.length}）:`);
      for (const [name, p] of repoEntries) log.info(`  - ${name}: ${resolve(repo, p)}`);
    }
    const extractors =
      opts.extractors ??
      (await loadExtractors(log, { skip: opts.screenshots === false ? ['screenshots'] : [] }));
    res = await buildGraph({
      root: repo,
      extractors,
      log,
      config,
      ...(opts.v1Only ? { v1Only: true } : {}),
    });
  } catch (e) {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (e instanceof AtlasConfigError) {
      log.error(e.message);
      return 2;
    }
    throw e;
  }

  mkdirSync(outDir, { recursive: true });
  try {
    swapScreens(outDir, stage, log);
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
  if (screensBlocked)
    res.issues.push({ level: 'warning', path: 'screens', message: screensSkipMessage('foreign') });
  if (opts.withViewer) cpSync(viewerDist, outDir, { recursive: true });
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  if (opts.v1Only) {
    writeFileSync(join(outDir, 'graph.json'), json(res.graph));
    // 前回の build の graph.v1.json が残ると、ビューアの「配線図」の行き来が古い組み合わせを指す
    rmSync(join(outDir, 'graph.v1.json'), { force: true });
  } else {
    writeFileSync(join(outDir, 'graph.json'), json(res.graphV2!));
    writeFileSync(join(outDir, 'graph.v1.json'), json(res.graph));
  }
  writeFileSync(join(outDir, 'issues.json'), json(res.issues));
  let orphans: string[] = [];
  if (existsSync(memosFile(repo))) {
    const memos = loadMemos({ root: repo, log });
    writeFileSync(join(outDir, 'memos.json'), serializeMemos(memos));
    orphans = orphanMemos(memos, res.graph);
  } else {
    // リポジトリの memos.json が無くなったら、前回の build の memos.json も消す（古いメモが残らないように）
    rmSync(join(outDir, 'memos.json'), { force: true });
  }

  console.log(formatBuildSummary(res, outDir, orphans, opts.v1Only));
  return res.issues.some((i) => i.level === 'error') ? 1 : 0;
}
