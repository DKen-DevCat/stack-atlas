/**
 * 手書きの部分グラフ `.stack-atlas/graph/*.v2.yaml`（docs/19 §3.1）。PartialGraphV2 の形（nodes・wires・types）で、
 * 言語アダプタ `hand` として mergeV2 に入る（外部 API の `external:` の箱、アダプタの無い言語の handler（`meta.route` を
 * 書けば OpenAPI と自動で合流する）、cron の中身など）。
 *
 * - 箱 id が別のアダプタ（ts-types・go-types）か契約（openapi・sql）の箱と同じなら、アダプタが勝つ: 効くのは「アダプタの
 *   項目に子が無いか wireType unknown のとき」の子の追加だけ（crude・`meta.by: "hand"`）。ほかの違いは警告して捨てる
 * - それ以外の箱はそのまま足す（`meta.by: "hand"`・`meta.handFile`）。runtime は必須（言語アダプタと違い推せない）
 * - 形は validateGraphV2 の schema と箱の中の参照で確かめる（線の参照は他の箱を指すので最後の検証に任せる）。
 *   壊れたファイルはファイルごと捨て、解けない補い（kind hand）にする
 * - 上限: ファイル 64、1 ファイル 1MB、箱は全部で 2000、項目は全部で 20000。YAML の別名は 100 まで。シンボリックリンクは読まない
 */
import { validateGraphV2, type ItemV2, type NamedType, type WireV2 } from '@stack-atlas/schema';
import {
  HARNESS_DIR,
  listLocalDir,
  parseLocalYaml,
  readLocalFile,
  whyText,
} from './local-files.js';
import type { SupplementResult } from './supplements.js';
import type { BuildIssue, PartialGraphV2, PartialNodeV2 } from './types.js';
import { clone, isPlainObject } from './util.js';
import { mergeItemLists, walkItems } from './v2-parts.js';

export const HAND_ADAPTER = 'hand';
export const HAND_DIR = 'graph';
export const HAND_LIMITS = { files: 64, bytes: 1024 * 1024, nodes: 2000, items: 20000 } as const;

export interface HandGraphResult {
  /** 足す部分グラフ（新しい箱・線・型）。何も無ければ undefined */
  part?: PartialGraphV2;
  /** 読んだファイル（config のディレクトリからの相対） */
  files: string[];
  /** ファイルごとの結果（kind hand） */
  results: SupplementResult[];
  issues: BuildIssue[];
}

const rel = (name: string) => `${HARNESS_DIR}/${HAND_DIR}/${name}`;

/**
 * `.stack-atlas/graph/*.v2.yaml` を読み、owned（別のアダプタ・契約が出した箱 id → その箱）に子を足し、残りを部分グラフにする。
 * owned の箱は書き換える
 */
export function loadHandGraphs(
  configDir: string,
  owned: ReadonlyMap<string, PartialNodeV2>,
): HandGraphResult {
  const out: HandGraphResult = { files: [], results: [], issues: [] };
  const dir = listLocalDir(configDir, [HARNESS_DIR, HAND_DIR]);
  if ('why' in dir) {
    if (dir.why !== 'missing')
      out.issues.push({
        level: 'warning',
        path: `hand:${rel('')}`,
        message: `${rel('')} が${whyText(dir.why)}`,
      });
    return out;
  }
  const names = dir.names.filter((n) => n.endsWith('.v2.yaml'));
  if (names.length > HAND_LIMITS.files)
    out.issues.push({
      level: 'warning',
      path: `hand:${rel('')}`,
      message: `手書きの部分グラフが ${names.length} ファイルあります。最初の ${HAND_LIMITS.files} だけ読みます`,
    });
  const nodes: PartialNodeV2[] = [];
  const wires: WireV2[] = [];
  const types: NamedType[] = [];
  const ids = new Set<string>();
  let items = 0;
  names.slice(0, HAND_LIMITS.files).forEach((name, index) => {
    const file = rel(name);
    out.files.push(file);
    const result = (status: SupplementResult['status'], message?: string): SupplementResult => {
      const r: SupplementResult = { kind: 'hand', index, status, target: file };
      if (message) r.message = message;
      out.results.push(r);
      return r;
    };
    const read = readLocalFile(configDir, [HARNESS_DIR, HAND_DIR, name], HAND_LIMITS.bytes);
    if ('why' in read) return result('unresolved', `${file} が${whyText(read.why)}`);
    const parsed = parseLocalYaml(read.text);
    if ('error' in parsed) return result('unresolved', `YAML として読めません: ${parsed.error}`);
    const raw = parsed.value;
    if (!isPlainObject(raw) || !Array.isArray(raw.nodes))
      return result(
        'unresolved',
        'トップレベルは { nodes: [...], wires?: [...], types?: [...] } にしてください',
      );
    const unknownKeys = Object.keys(raw).filter((k) => !['nodes', 'wires', 'types'].includes(k));
    if (raw.wires !== undefined && !Array.isArray(raw.wires))
      return result('unresolved', 'wires は配列で書いてください');
    if (raw.types !== undefined && !Array.isArray(raw.types))
      return result('unresolved', 'types は配列で書いてください');
    const rawNodes = raw.nodes as unknown[];
    const rawWires = (raw.wires ?? []) as unknown[];
    const rawTypes = (raw.types ?? []) as unknown[];
    // 形の検査（schema と箱の中の参照）。アダプタの箱と同じ id の箱は子の追加にしか使わないので、runtime の欠けは問わない。
    // host（文字列）は他の箱（インフラ）を指すので、ここでは外して最後の検証に任せる（文字列でなければ schema が断る）
    const probeNodes = rawNodes.map((n) => {
      if (!isPlainObject(n)) return n;
      const rest: Record<string, unknown> = { ...n };
      if (typeof n.host === 'string') delete rest.host;
      return typeof n.id === 'string' && owned.has(n.id) && n.runtime === undefined
        ? { ...rest, runtime: 'browser' }
        : rest;
    });
    const v = validateGraphV2({ version: 2, nodes: probeNodes, wires: rawWires, types: rawTypes });
    const fatal = v.graph
      ? v.errors.filter((e) => e.path.startsWith('/nodes/') || e.path.startsWith('/types/'))
      : v.errors;
    if (fatal.length)
      return result(
        'unresolved',
        `形が違います: ${fatal
          .slice(0, 5)
          .map((e) => `${e.path} ${e.message}`)
          .join('、')}${fatal.length > 5 ? ` ほか ${fatal.length - 5} 件` : ''}`,
      );
    const fileNodes = (v.graph!.nodes as PartialNodeV2[]).map((n, k) => {
      const host = (rawNodes[k] as Record<string, unknown>).host;
      return host === undefined ? n : { ...n, host: host as string };
    });
    let fileItems = 0;
    for (const n of fileNodes) for (const p of n.ports) walkItems(p.items, () => fileItems++);
    if (
      nodes.length + fileNodes.length > HAND_LIMITS.nodes ||
      items + fileItems > HAND_LIMITS.items
    )
      return result(
        'unresolved',
        `上限（箱 ${HAND_LIMITS.nodes}・項目 ${HAND_LIMITS.items}。全部のファイルの合計）を超えるので読みません`,
      );
    const dup = fileNodes.find((n) => ids.has(n.id));
    if (dup) return result('unresolved', `箱 ${dup.id} が別の手書きのファイルにもあります`);
    items += fileItems;
    const notes: string[] = [];
    if (unknownKeys.length) notes.push(`未知のキー ${unknownKeys.join(', ')} は無視します`);
    for (const n of fileNodes) {
      ids.add(n.id);
      const target = owned.get(n.id);
      if (target) {
        notes.push(...addChildren(target, n));
        continue;
      }
      const copy = clone(n);
      copy.meta = { ...(copy.meta ?? {}), by: HAND_ADAPTER, handFile: file };
      nodes.push(copy);
    }
    for (const w of v.graph!.wires)
      wires.push({ ...clone(w), meta: { ...(w.meta ?? {}), by: HAND_ADAPTER } });
    for (const t of v.graph!.types ?? []) types.push(clone(t));
    result('applied', notes.length ? notes.join('。') : undefined);
    for (const m of notes) out.issues.push({ level: 'warning', path: `hand:${file}`, message: m });
  });
  if (nodes.length || wires.length || types.length) {
    out.part = { nodes, wires };
    if (types.length) out.part.types = types;
  }
  return out;
}

/**
 * アダプタの箱（target）に、手書きの箱の項目の子を足す（アダプタの項目に子が無いか unknown のとき）。target を書き換え、
 * 効かなかったものの文を返す
 */
function addChildren(target: PartialNodeV2, hand: PartialNodeV2): string[] {
  const notes: string[] = [];
  for (const hp of hand.ports) {
    const tp = target.ports.find((p) => p.id === hp.id);
    for (const hi of hp.items) {
      const ti = tp?.items.find((x) => x.id === hi.id);
      if (!ti) {
        notes.push(
          `${target.id}#${hp.id}/${hi.id} はアダプタの箱に無いので足しません（アダプタが勝つ）`,
        );
        continue;
      }
      if (!hi.children?.length) continue;
      if (ti.children?.length && ti.wireType !== 'unknown') {
        notes.push(`${target.id}#${hp.id}/${hi.id} にはアダプタの子があるので足しません`);
        continue;
      }
      ti.children = mergeItemLists(ti.children ?? [], stamp(hi.children));
    }
  }
  const extra = (['links', 'variants'] as const).filter((k) => hand[k]?.length);
  if (extra.length)
    notes.push(
      `${target.id} の ${extra.join('・')} はアダプタの箱には足しません（overrides の v2: で書いてください）`,
    );
  return notes;
}

/** 足す子に crude と by を付ける */
function stamp(items: ItemV2[]): ItemV2[] {
  return items.map((it) => {
    const c: ItemV2 = { ...clone(it), confidence: it.confidence ?? 'crude' };
    c.meta = { ...(it.meta ?? {}), by: HAND_ADAPTER };
    if (it.children) c.children = stamp(it.children);
    return c;
  });
}
