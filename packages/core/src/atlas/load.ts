/**
 * `.stack-atlas/` の図を読む（docs/25 §3.1、docs/26）。エージェントが書くファイルなので信用しない:
 * 読むのは決まった名前のファイルだけ、シンボリックリンクは辿らない、大きさと数に上限、YAML の別名の展開に上限（local-files）。
 *
 * ここでは「形」を見る。形の違う要素は、その要素だけ捨てて指摘にする（ほかの要素の検査を止めない）。
 * 返す箱・線・型・部品・挙動は、どれも契約のスキーマを通ったもの。参照（線の端が解けるか、など）と挙動の検査は check.ts。
 * 知らないキーは誤りにする（`back` を `bak` と打つと、返りの線が黙って消えるため）
 *
 * 形の決まりの正は、契約のスキーマ（@stack-atlas/schema）。部品と挙動は、その前に、ここの手書きの確かめ（parsePart・parseBehavior）を通す。
 * 手書きの確かめの役目は、指摘の文を、書いた人が直せる言葉にすること（スキーマの指摘は、入れ子の深い所で読みにくい）。
 * 手書きの確かめは、スキーマより緩くしない（緩い所があると、スキーマの読みにくい指摘が出る。atlas-check.test.ts が確かめる）。
 * 名指し（部品の box・screen、挙動の screen・部品・線・分岐のキー）の形は、どちらも問わない。解けるかどうかを、検査が確かめる
 */
import {
  isLocalId,
  validateGraphV2,
  type NamedType,
  type NodeV2,
  type WireV2,
} from '@stack-atlas/schema';
import { listLocalDir, parseLocalYaml, readLocalFile, whyText } from '../local-files.js';
import { isPlainObject } from '../util.js';
import {
  ATLAS_BEHAVIORS_FILE,
  ATLAS_DIR,
  ATLAS_GRAPH_DIR,
  ATLAS_LIMITS,
  ATLAS_PARTS_FILE,
  ATLAS_PATHS,
  TRIGGER_ACTIONS,
  type AtlasFileStatus,
  type AtlasIssue,
  type Behavior,
  type BehaviorEntry,
  type BehaviorStep,
  type LoadedAtlas,
  type Part,
  type TriggerAction,
  type WireRef,
} from './types.js';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const hasControl = (id: string) => [...id].some((c) => c.charCodeAt(0) < 0x20);

/**
 * JSON で表せる値だけか（文字列・有限の数・真偽・null・配列・ふつうのオブジェクト）。
 * YAML は、日付や集合などの値も作れる（`%YAML 1.1` と書いたファイル）。それらは、契約の形（JSON）に写すと別の値に変わる
 */
function isJsonValue(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || depth > 100) return false;
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v).every((x) => isJsonValue(x, depth + 1));
}

type Push = (issue: Omit<AtlasIssue, 'check' | 'level'> & { level?: AtlasIssue['level'] }) => void;

/** 知らないキーがあれば指摘して true（その要素は捨てる） */
function hasUnknownKeys(
  v: Record<string, unknown>,
  known: readonly string[],
  what: string,
  file: string,
  path: string,
  push: Push,
): boolean {
  const unknown = Object.keys(v).filter((k) => !known.includes(k));
  if (unknown.length === 0) return false;
  push({
    file,
    path,
    message: `${what}に、知らないキー ${unknown.join(', ')} があります（書けるのは ${known.join(', ')}）`,
  });
  return true;
}

/** root/.stack-atlas/<name> の YAML を読む。無いことは誤りではない。読めなければ指摘する */
function readYaml(
  root: string,
  segs: string[],
  file: string,
  push: Push,
): { status: AtlasFileStatus; value?: unknown } {
  const read = readLocalFile(root, [ATLAS_DIR, ...segs], ATLAS_LIMITS.bytes);
  if ('why' in read) {
    if (read.why === 'missing') return { status: 'missing' };
    push({ file, message: `${file} が${whyText(read.why)}` });
    return { status: 'unreadable' };
  }
  const parsed = parseLocalYaml(read.text);
  if ('error' in parsed) {
    push({ file, message: `YAML として読めません: ${parsed.error}` });
    return { status: 'unreadable' };
  }
  if (!isJsonValue(parsed.value)) {
    push({
      file,
      message:
        '文字列・数・true / false・配列・{ キー: 値 } のほかの値（日付・集合・無限大など）があるので読みません。' +
        '日付に見える値は引用符で囲み、先頭の %YAML の行は消してください',
    });
    return { status: 'unreadable' };
  }
  return { status: 'ok', value: parsed.value };
}

/** トップが配列か `{ <key>: [...] }` のどちらでも受ける */
function listOf(value: unknown, key: string, file: string, push: Push): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (isPlainObject(value) && Array.isArray(value[key])) {
    hasUnknownKeys(value, [key], 'トップレベル', file, '/', push);
    return value[key] as unknown[];
  }
  push({ file, message: `トップレベルは配列か { ${key}: [...] } にしてください` });
  return [];
}

function parseWhen(
  v: unknown,
  file: string,
  path: string,
  push: Push,
): Record<string, boolean> | undefined {
  if (!isPlainObject(v) || Object.values(v).some((x) => typeof x !== 'boolean')) {
    push({
      file,
      path,
      message: 'when は { "<箱 id>#<分岐 id>": true か false } の形にしてください',
    });
    return undefined;
  }
  return v as Record<string, boolean>;
}

function parseWireRefs(v: unknown, file: string, path: string, push: Push): WireRef[] | undefined {
  if (!Array.isArray(v)) {
    push({ file, path, message: '線の列（[{ from, to }, ...]）にしてください' });
    return undefined;
  }
  const out: WireRef[] = [];
  for (const [i, w] of v.entries()) {
    const here = `${path}/${i}`;
    if (!isPlainObject(w) || !isStr(w.from) || !isStr(w.to)) {
      push({
        file,
        path: here,
        message: '線は { from: "<項目の参照>", to: "<項目の参照>" } で書いてください',
      });
      return undefined;
    }
    if (hasUnknownKeys(w, ['from', 'to'], '線の名指し', file, here, push)) return undefined;
    out.push({ from: w.from, to: w.to });
  }
  return out;
}

function parseStep(v: unknown, file: string, path: string, push: Push): BehaviorStep | undefined {
  if (!isPlainObject(v)) {
    push({ file, path, message: '段は { send: [...], back?: [...] } で書いてください' });
    return undefined;
  }
  if (hasUnknownKeys(v, ['send', 'back', 'say', 'when'], '段', file, path, push)) return undefined;
  const send = parseWireRefs(v.send, file, `${path}/send`, push);
  if (!send) return undefined;
  if (send.length === 0) {
    push({
      file,
      path: `${path}/send`,
      message: '段の send が空です（送る線を 1 本以上書いてください）',
    });
    return undefined;
  }
  const step: BehaviorStep = { send };
  if (v.back !== undefined) {
    const back = parseWireRefs(v.back, file, `${path}/back`, push);
    if (!back) return undefined;
    step.back = back;
  }
  if (v.say !== undefined) {
    if (typeof v.say !== 'string') {
      push({ file, path: `${path}/say`, message: 'say は文字列にしてください' });
      return undefined;
    }
    step.say = v.say;
  }
  if (v.when !== undefined) {
    const when = parseWhen(v.when, file, `${path}/when`, push);
    if (!when) return undefined;
    step.when = when;
  }
  return step;
}

/** 段の列（途中に `{ parallel: [[段...], [段...]] }` を書ける） */
function parseSteps(
  v: unknown,
  file: string,
  path: string,
  push: Push,
): BehaviorEntry[] | undefined {
  if (!Array.isArray(v) || v.length === 0) {
    push({ file, path, message: 'steps は 1 つ以上の段の列にしてください' });
    return undefined;
  }
  const entries: BehaviorEntry[] = [];
  let count = 0;
  for (const [i, e] of v.entries()) {
    const here = `${path}/${i}`;
    if (isPlainObject(e) && e.parallel !== undefined) {
      // 並んだ列と、ふつうの段のキーを混ぜて書くと、片方が黙って捨てられるので、誤りにする
      if (hasUnknownKeys(e, ['parallel'], '同時に呼ぶ所（parallel）', file, here, push))
        return undefined;
      const lanes = e.parallel;
      if (
        !Array.isArray(lanes) ||
        lanes.length < 2 ||
        lanes.some((l) => !Array.isArray(l) || l.length === 0)
      ) {
        push({
          file,
          path: `${here}/parallel`,
          message: 'parallel は、2 つ以上の「段の列」を並べてください（[[段, ...], [段, ...]]）',
        });
        return undefined;
      }
      const parsedLanes: BehaviorStep[][] = [];
      for (const [li, lane] of (lanes as unknown[][]).entries()) {
        const steps: BehaviorStep[] = [];
        for (const [si, s] of lane.entries()) {
          const step = parseStep(s, file, `${here}/parallel/${li}/${si}`, push);
          if (!step) return undefined;
          steps.push(step);
          count++;
        }
        parsedLanes.push(steps);
      }
      entries.push({ parallel: parsedLanes });
    } else {
      const step = parseStep(e, file, here, push);
      if (!step) return undefined;
      entries.push(step);
      count++;
    }
  }
  if (count > ATLAS_LIMITS.steps) {
    push({
      file,
      path,
      message: `段が ${count} あります。1 つの挙動は ${ATLAS_LIMITS.steps} 段までにしてください`,
    });
    return undefined;
  }
  return entries;
}

function parseBehavior(v: unknown, file: string, path: string, push: Push): Behavior | undefined {
  if (!isPlainObject(v)) {
    push({ file, path, message: '挙動は { id, name, screen, trigger, steps } で書いてください' });
    return undefined;
  }
  const keys = ['id', 'name', 'screen', 'trigger', 'steps', 'result', 'when'];
  if (hasUnknownKeys(v, keys, '挙動', file, path, push)) return undefined;
  for (const key of ['id', 'name', 'screen'] as const) {
    if (!isStr(v[key])) {
      push({ file, path: `${path}/${key}`, message: `挙動の ${key} がありません（文字列）` });
      return undefined;
    }
  }
  const id = v.id as string;
  if (!isLocalId(id)) {
    push({
      file,
      path: `${path}/id`,
      message: `挙動の id "${id}" に使えない字（# や制御文字）があります`,
    });
    return undefined;
  }
  const t = v.trigger;
  if (!isPlainObject(t) || !TRIGGER_ACTIONS.includes(t.action as TriggerAction)) {
    push({
      file,
      path: `${path}/trigger`,
      message: `trigger は { action: ${TRIGGER_ACTIONS.join(' | ')}, part?: "<部品の id>" } で書いてください`,
    });
    return undefined;
  }
  if (hasUnknownKeys(t, ['action', 'part'], 'trigger ', file, `${path}/trigger`, push))
    return undefined;
  const action = t.action as TriggerAction;
  if (action === 'open' ? t.part !== undefined : !isStr(t.part)) {
    push({
      file,
      path: `${path}/trigger/part`,
      message:
        action === 'open'
          ? 'action が open のとき、part は書きません（画面を開くことが始まりです）'
          : `action が ${action} のとき、part（部品の id）が要ります`,
    });
    return undefined;
  }
  const steps = parseSteps(v.steps, file, `${path}/steps`, push);
  if (!steps) return undefined;
  const out: Behavior = {
    id,
    name: v.name as string,
    screen: v.screen as string,
    trigger: action === 'open' ? { action } : { action, part: t.part as string },
    steps,
  };
  if (v.result !== undefined) {
    const r = v.result;
    if (
      !isPlainObject(r) ||
      (r.say !== undefined && typeof r.say !== 'string') ||
      (r.part !== undefined && !isStr(r.part))
    ) {
      push({
        file,
        path: `${path}/result`,
        message: 'result は { say?: "<文>", part?: "<変わる部品の id>" } で書いてください',
      });
      return undefined;
    }
    if (hasUnknownKeys(r, ['say', 'part'], 'result ', file, `${path}/result`, push))
      return undefined;
    out.result = {};
    if (typeof r.say === 'string') out.result.say = r.say;
    if (isStr(r.part)) out.result.part = r.part;
  }
  if (v.when !== undefined) {
    const when = parseWhen(v.when, file, `${path}/when`, push);
    if (!when) return undefined;
    out.when = when;
  }
  return out;
}

function parsePart(v: unknown, file: string, path: string, push: Push): Part | undefined {
  if (!isPlainObject(v)) {
    push({ file, path, message: '部品は { id, box, screen, selector } で書いてください' });
    return undefined;
  }
  if (hasUnknownKeys(v, ['id', 'name', 'box', 'screen', 'selector'], '部品', file, path, push))
    return undefined;
  for (const key of ['id', 'box', 'screen', 'selector'] as const) {
    if (!isStr(v[key])) {
      push({ file, path: `${path}/${key}`, message: `部品の ${key} がありません（文字列）` });
      return undefined;
    }
  }
  if (!isLocalId(v.id as string)) {
    push({
      file,
      path: `${path}/id`,
      message: `部品の id "${String(v.id)}" に使えない字（# や制御文字）があります`,
    });
    return undefined;
  }
  if (v.name !== undefined && typeof v.name !== 'string') {
    push({ file, path: `${path}/name`, message: 'name は文字列にしてください' });
    return undefined;
  }
  const part: Part = {
    id: v.id as string,
    box: v.box as string,
    screen: v.screen as string,
    selector: v.selector as string,
  };
  if (typeof v.name === 'string') part.name = v.name;
  return part;
}

type GraphKey = 'nodes' | 'wires' | 'types' | 'parts' | 'behaviors';
const WHAT: Record<GraphKey, string> = {
  nodes: '箱',
  wires: '線',
  types: '型',
  parts: '部品',
  behaviors: '挙動',
};

/** 1 つの箱・線・型・部品・挙動を、契約のスキーマに掛ける。合わなければ指摘して undefined（その要素だけ捨てる） */
function validElement<T>(
  key: GraphKey,
  raw: unknown,
  file: string,
  index: number,
  push: Push,
): T | undefined {
  let what = `${WHAT[key]} ${index + 1} 番め`;
  if (isPlainObject(raw)) {
    if (key !== 'wires' && typeof raw.id === 'string') what = `${WHAT[key]} "${raw.id}"`;
    if (key === 'wires' && typeof raw.from === 'string' && typeof raw.to === 'string')
      what = `線 "${raw.from}" → "${raw.to}"`;
  }
  const doc: Record<GraphKey, unknown[]> & { version: 2 } = {
    version: 2,
    nodes: [],
    wires: [],
    types: [],
    parts: [],
    behaviors: [],
  };
  doc[key] = [raw];
  const v = validateGraphV2(doc);
  if (!v.graph) {
    // スキーマに合わない。場所は `/nodes/0/ports/…` の形で来るので、頭を「どの箱・線・型か」に替える
    for (const e of v.errors.slice(0, 5))
      push({ file, path: `${what}${e.path.replace(`/${key}/0`, '')}`, message: e.message });
    if (v.errors.length > 5)
      push({ file, path: what, message: `ほかに ${v.errors.length - 5} 件、形の誤りがあります` });
    return undefined;
  }
  // 箱 id の `#` は、契約のスキーマが断る（項目の参照と、分岐のキーで解けなくなるため）。ここでは、制御文字を足して断る
  if (key === 'nodes' && hasControl((raw as { id: string }).id)) {
    push({ file, path: what, message: '箱 id に使えない字（制御文字）があります' });
    return undefined;
  }
  return (v.graph[key] as T[] | undefined)?.[0];
}

/**
 * root/.stack-atlas/ の図を読む。形の違う所は指摘（check: form）にして、形の合うものだけ返す
 */
export function loadAtlas(root: string): { atlas: LoadedAtlas; issues: AtlasIssue[] } {
  const issues: AtlasIssue[] = [];
  const push: Push = (i) => issues.push({ level: 'error', check: 'form', ...i });
  const atlas: LoadedAtlas = {
    root,
    nodes: [],
    wires: [],
    types: [],
    behaviors: [],
    parts: [],
    files: [],
    nodeFiles: [],
    wireFiles: [],
    typeFiles: [],
    partAt: [],
    behaviorAt: [],
    status: { parts: 'missing', behaviors: 'missing' },
  };

  // 名前の似たファイル（*.yml）は読まない。黙って読み飛ばすと、原因のわからない指摘が並ぶので、名指しで誤りにする
  const top = listLocalDir(root, [ATLAS_DIR]);
  if (!('why' in top)) {
    for (const want of [ATLAS_PARTS_FILE, ATLAS_BEHAVIORS_FILE]) {
      const name = want.replace(/\.yaml$/, '.yml');
      if (top.names.includes(name))
        push({
          file: `${ATLAS_DIR}/${name}`,
          message: `${name} は読みません。${want} という名前にしてください`,
        });
    }
  }

  // 箱と線: graph/*.yaml
  const dir = listLocalDir(root, [ATLAS_DIR, ATLAS_GRAPH_DIR]);
  if ('why' in dir) {
    push({
      file: ATLAS_PATHS.graph,
      message:
        dir.why === 'missing'
          ? `${ATLAS_PATHS.graph}/ がありません（箱と線を書く *.yaml を置いてください）`
          : `${ATLAS_PATHS.graph}/ が${whyText(dir.why)}`,
    });
  } else {
    const old = dir.names.filter((n) => n.endsWith('.v2.yaml'));
    const yml = dir.names.filter((n) => n.endsWith('.yml'));
    const names = dir.names.filter((n) => n.endsWith('.yaml') && !n.endsWith('.v2.yaml'));
    if (old.length)
      push({
        level: 'warning',
        file: ATLAS_PATHS.graph,
        message: `*.v2.yaml（${old.join(', ')}）は古い形のファイルなので読みません。*.yaml にしてください`,
      });
    if (yml.length)
      push({
        file: ATLAS_PATHS.graph,
        message: `*.yml（${yml.join(', ')}）は読みません。*.yaml という名前にしてください`,
      });
    if (names.length === 0)
      push({ file: ATLAS_PATHS.graph, message: `${ATLAS_PATHS.graph}/ に *.yaml がありません` });
    if (names.length > ATLAS_LIMITS.graphFiles)
      push({
        file: ATLAS_PATHS.graph,
        message: `${names.length} ファイルあります。${ATLAS_LIMITS.graphFiles} ファイルまでにしてください（最初の分だけ読みます）`,
      });
    let over = false;
    for (const name of names.slice(0, ATLAS_LIMITS.graphFiles)) {
      const file = `${ATLAS_PATHS.graph}/${name}`;
      const y = readYaml(root, [ATLAS_GRAPH_DIR, name], file, push);
      if (y.status !== 'ok') continue;
      atlas.files.push(file);
      const raw = y.value;
      if (!isPlainObject(raw)) {
        push({
          file,
          message: 'トップレベルは { nodes: [...], wires: [...], types?: [...] } にしてください',
        });
        continue;
      }
      hasUnknownKeys(raw, ['nodes', 'wires', 'types'], 'トップレベル', file, '/', push);
      for (const key of ['nodes', 'wires', 'types'] as const) {
        const list = raw[key];
        if (list === undefined || list === null) continue;
        if (!Array.isArray(list)) {
          push({ file, path: `/${key}`, message: `${key} は配列で書いてください` });
          continue;
        }
        for (const [i, item] of list.entries()) {
          if (key === 'nodes') {
            if (atlas.nodes.length >= ATLAS_LIMITS.nodes) {
              over = true;
              continue;
            }
            const n = validElement<NodeV2>(key, item, file, i, push);
            if (n) {
              atlas.nodes.push(n);
              atlas.nodeFiles.push(file);
            }
          } else if (key === 'wires') {
            if (atlas.wires.length >= ATLAS_LIMITS.wires) {
              over = true;
              continue;
            }
            const w = validElement<WireV2>(key, item, file, i, push);
            if (w) {
              atlas.wires.push(w);
              atlas.wireFiles.push(file);
            }
          } else {
            const t = validElement<NamedType>(key, item, file, i, push);
            if (t) {
              atlas.types.push(t);
              atlas.typeFiles.push(file);
            }
          }
        }
      }
    }
    if (over)
      push({
        file: ATLAS_PATHS.graph,
        message: `上限（箱 ${ATLAS_LIMITS.nodes}・線 ${ATLAS_LIMITS.wires}）を超えています。超えた分は読みません`,
      });
  }

  // 部品: parts.yaml
  const py = readYaml(root, [ATLAS_PARTS_FILE], ATLAS_PATHS.parts, push);
  atlas.status.parts = py.status;
  if (py.status === 'ok') {
    atlas.files.push(ATLAS_PATHS.parts);
    const list = listOf(py.value, 'parts', ATLAS_PATHS.parts, push);
    for (const [i, v] of list.slice(0, ATLAS_LIMITS.parts).entries()) {
      // 手書きの確かめ（直せる言葉の指摘）のあと、契約のスキーマにも掛ける（形の決まりの正。ここで落ちるのは、手書きの側の漏れ）
      const parsed = parsePart(v, ATLAS_PATHS.parts, `/parts/${i}`, push);
      const part = parsed && validElement<Part>('parts', parsed, ATLAS_PATHS.parts, i, push);
      if (part) {
        atlas.parts.push(part);
        atlas.partAt.push(i);
      }
    }
    if (list.length > ATLAS_LIMITS.parts)
      push({
        file: ATLAS_PATHS.parts,
        message: `部品は ${ATLAS_LIMITS.parts} までにしてください（超えた分は読みません）`,
      });
  }

  // 挙動: behaviors.yaml
  const by = readYaml(root, [ATLAS_BEHAVIORS_FILE], ATLAS_PATHS.behaviors, push);
  atlas.status.behaviors = by.status;
  if (by.status === 'ok') {
    atlas.files.push(ATLAS_PATHS.behaviors);
    const list = listOf(by.value, 'behaviors', ATLAS_PATHS.behaviors, push);
    for (const [i, v] of list.slice(0, ATLAS_LIMITS.behaviors).entries()) {
      const parsed = parseBehavior(v, ATLAS_PATHS.behaviors, `/behaviors/${i}`, push);
      const b =
        parsed && validElement<Behavior>('behaviors', parsed, ATLAS_PATHS.behaviors, i, push);
      if (b) {
        atlas.behaviors.push(b);
        atlas.behaviorAt.push(i);
      }
    }
    if (list.length > ATLAS_LIMITS.behaviors)
      push({
        file: ATLAS_PATHS.behaviors,
        message: `挙動は ${ATLAS_LIMITS.behaviors} までにしてください（超えた分は読みません）`,
      });
  }
  return { atlas, issues };
}
