/**
 * build で使う抽出器の一覧（docs/09 §3.2・docs/12 §2.2 の順番）:
 * files（ノードを作るだけ）→ インフラ（cdktf / terraform / cloudformation）→ 画面（nextjs-app）
 * → コード（ts-imports / ts-types / go / go-types）→ 契約（openapi / sql）→ 結線（api-link）→ cache → screenshots → screens。
 * ts-types と go-types は言語アダプタ（v2 の部分グラフだけを出す。docs/17）。ts-types は ts-imports の分類と ID を共有するので
 * ts-imports の後、go-types は go 抽出器のパッケージの箱（refs の宛先）と入口を使うので go の後（8-2b）。
 * screens（ビルド成果物の HTML を写して消毒する。docs/18 §3.3）は screenshots の後（同じ route の screen に html を足す）。
 * パイプラインは抽出器ごとに全 repo を回すので、後続は先行の全 repo 分の結果を upstream で読める。
 * 各パッケージは `export const extractor: Extractor`（と default export）を出す。
 * まだ無いパッケージもあるので、1 つずつ動的 import して、見つからなければスキップする。
 */
import type { Extractor, Logger } from '@stack-atlas/core';

export const EXTRACTOR_PACKAGES = [
  '@stack-atlas/extractor-files',
  '@stack-atlas/extractor-cdktf',
  '@stack-atlas/extractor-terraform',
  '@stack-atlas/extractor-cloudformation',
  '@stack-atlas/extractor-nextjs-app',
  '@stack-atlas/extractor-ts-imports',
  '@stack-atlas/extractor-ts-types',
  '@stack-atlas/extractor-go',
  '@stack-atlas/extractor-go-types',
  '@stack-atlas/extractor-openapi',
  '@stack-atlas/extractor-sql',
  '@stack-atlas/extractor-api-link',
  '@stack-atlas/extractor-cache',
  '@stack-atlas/extractor-screenshots',
  '@stack-atlas/extractor-screens',
] as const;

type ExtractorModule = { extractor?: Extractor; default?: Extractor };

const isExtractor = (v: unknown): v is Extractor =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Extractor).name === 'string' &&
  typeof (v as Extractor).detect === 'function' &&
  typeof (v as Extractor).extract === 'function';

export interface LoadExtractorsOptions {
  /** 読まないパッケージ名（例: --no-screenshots） */
  skip?: string[];
  /** import 関数の差し替え（テスト用） */
  importer?: (spec: string) => Promise<unknown>;
}

export async function loadExtractors(
  log: Logger,
  opts: LoadExtractorsOptions = {},
): Promise<Extractor[]> {
  const importer = opts.importer ?? ((spec: string) => import(spec) as Promise<unknown>);
  const out: Extractor[] = [];
  for (const spec of EXTRACTOR_PACKAGES) {
    const short = spec.replace('@stack-atlas/extractor-', '');
    if (opts.skip?.includes(short)) {
      log.info(`- ${short}: オプションで無効（スキップ）`);
      continue;
    }
    let mod: ExtractorModule;
    try {
      mod = (await importer(spec)) as ExtractorModule;
    } catch (e) {
      const code = (e as { code?: string }).code;
      const missing = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
      if (missing && (e as Error).message.includes(spec)) {
        log.info(`- 抽出器 ${short} は見つかりません（スキップ）`);
      } else {
        log.warn(`抽出器 ${short} を読み込めません（スキップ）: ${(e as Error).message}`);
      }
      continue;
    }
    const ex = isExtractor(mod.extractor)
      ? mod.extractor
      : isExtractor(mod.default)
        ? mod.default
        : undefined;
    if (!ex) {
      log.warn(`抽出器 ${short} は Extractor を export していません（スキップ）`);
      continue;
    }
    out.push(ex);
  }
  return out;
}
