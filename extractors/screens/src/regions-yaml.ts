/**
 * `.stack-atlas/screens/<slug>.regions.yaml`（docs/19 §3.7）: HTML の `data-component` で測れない部品の領域を手で補う。
 * 形は `[{ ref: "comp:TotalCard", x, y, w, h }]`（か `{ regions: [...] }`）。座標は screens の viewport（既定 1280×800）。
 *
 * - **計測で取れなかった ref だけ**を補う: HTML の data-component で解ける部品（ビューアが測る）は使わない（info を出す）。
 *   ビューアも ref ごとに合わせ、DOM の計測が勝つ（wiring の regionsOf）
 * - 足す領域は `source: "yaml"`。ref は箱 id（`resolveRegionRef` と同じ規則で名前も可）。解けない ref・数でない座標・画面の
 *   外に出るものは警告して捨てる。ビューポートで切り詰める
 * - 上限: 256KB・500 件。YAML の別名は 100 まで。`.stack-atlas`・`screens`・ファイルのどれかがシンボリックリンクなら読まない
 */
import {
  HARNESS_DIR,
  clipRegion,
  parseLocalYaml,
  readLocalFile,
  resolveRegionRef,
  whyText,
  type BuildIssue,
} from '@stack-atlas/core';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const REGIONS_DIR = 'screens';
export const REGIONS_YAML_LIMITS = { bytes: 256 * 1024, regions: 500 } as const;

export interface YamlRegion {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
  source: 'yaml';
}

type Issue = BuildIssue & { level: 'warning' | 'info' };

/** regions.yaml のファイル名（config のディレクトリからの相対） */
export const regionsYamlPath = (slug: string) =>
  `${HARNESS_DIR}/${REGIONS_DIR}/${slug}.regions.yaml`;

/**
 * slug の regions.yaml を読む。measured は HTML の data-component で解けた箱 id（使わない）、ids は graph の箱 id
 */
export function readRegionsYaml(
  configDir: string,
  slug: string,
  opts: {
    pattern: string;
    viewport: { width: number; height: number };
    ids: ReadonlySet<string>;
    measured: ReadonlySet<string>;
  },
): { regions: YamlRegion[]; issues: Issue[] } {
  const out: { regions: YamlRegion[]; issues: Issue[] } = { regions: [], issues: [] };
  const file = regionsYamlPath(slug);
  const path = `screens:${opts.pattern}`;
  const warn = (message: string) =>
    out.issues.push({ level: 'warning', path, message: `${file}: ${message}` });
  const read = readLocalFile(
    configDir,
    [HARNESS_DIR, REGIONS_DIR, `${slug}.regions.yaml`],
    REGIONS_YAML_LIMITS.bytes,
  );
  if ('why' in read) {
    if (read.why !== 'missing') warn(`${whyText(read.why)}`);
    return out;
  }
  const parsed = parseLocalYaml(read.text);
  if ('error' in parsed) {
    warn(`YAML として読めません（${parsed.error}）`);
    return out;
  }
  const raw = parsed.value;
  const list = Array.isArray(raw)
    ? raw
    : isPlainObject(raw) && Array.isArray(raw.regions)
      ? raw.regions
      : undefined;
  if (!list) {
    if (raw !== null && raw !== undefined)
      warn('領域の配列（[{ ref, x, y, w, h }]）で書いてください');
    return out;
  }
  if (list.length > REGIONS_YAML_LIMITS.regions)
    warn(`領域が ${list.length} 件あります。最初の ${REGIONS_YAML_LIMITS.regions} 件だけ読みます`);
  const skipped: string[] = [];
  for (const [k, r] of list.slice(0, REGIONS_YAML_LIMITS.regions).entries()) {
    if (!isPlainObject(r) || typeof r.ref !== 'string') {
      warn(`[${k}] に ref がありません`);
      continue;
    }
    const ref = resolveRegionRef(r.ref, opts.ids);
    if (!ref) {
      warn(`[${k}] の ref ${r.ref} が箱に解けません`);
      continue;
    }
    if (opts.measured.has(ref)) {
      skipped.push(ref);
      continue;
    }
    const nums = [r.x, r.y, r.w, r.h];
    if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      warn(`[${k}]（${ref}）の x・y・w・h は数で書いてください`);
      continue;
    }
    const c = clipRegion(
      { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number },
      opts.viewport,
    );
    if (!c) {
      warn(`[${k}]（${ref}）は画面（${opts.viewport.width}×${opts.viewport.height}）の外です`);
      continue;
    }
    out.regions.push({ ref, ...c, source: 'yaml' });
  }
  if (skipped.length)
    out.issues.push({
      level: 'info',
      path,
      message: `${file}: ${[...new Set(skipped)].join(', ')} は HTML の data-component で測れるので使いません（計測が勝つ）`,
    });
  return out;
}
