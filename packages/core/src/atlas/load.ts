/**
 * `.stack-atlas/` の図を読む（docs/25 §3.1）。エージェントが書くファイルなので信用しない:
 * 読むのは決まった名前のファイルだけ、シンボリックリンクは辿らない、大きさと数に上限、YAML の別名の展開に上限（local-files）。
 * ここでは「形」だけを見る（箱と線の中身の検証と、参照・挙動の検査は check.ts）。形の違う要素は、その要素だけ捨てて指摘にする
 */
import { listLocalDir, parseLocalYaml, readLocalFile, whyText } from '../local-files.js';
import { isPlainObject } from '../util.js';
import {
  ATLAS_BEHAVIORS_FILE,
  ATLAS_DIR,
  ATLAS_GRAPH_DIR,
  ATLAS_LIMITS,
  ATLAS_PARTS_FILE,
  TRIGGER_ACTIONS,
  type AtlasIssue,
  type Behavior,
  type BehaviorEntry,
  type BehaviorStep,
  type LoadedAtlas,
  type Part,
  type TriggerAction,
  type WireRef,
} from './types.js';

const rel = (...segs: string[]) => [ATLAS_DIR, ...segs].join('/');
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
/** 箱・挙動・部品の id に使えない字（参照の区切りと、制御文字） */
const badId = (id: string) => id.includes('#') || [...id].some((c) => c.charCodeAt(0) < 0x20);

type Push = (issue: Omit<AtlasIssue, 'check' | 'level'> & { level?: AtlasIssue['level'] }) => void;

/** root/.stack-atlas/<segs> の YAML を読む。無ければ undefined（無いことは誤りではない）。読めなければ指摘して undefined */
function readYaml(root: string, segs: string[], push: Push): { value: unknown } | undefined {
  const file = rel(...segs);
  const read = readLocalFile(root, [ATLAS_DIR, ...segs], ATLAS_LIMITS.bytes);
  if ('why' in read) {
    if (read.why !== 'missing') push({ file, message: `${file} が${whyText(read.why)}` });
    return undefined;
  }
  const parsed = parseLocalYaml(read.text);
  if ('error' in parsed) {
    push({ file, message: `YAML として読めません: ${parsed.error}` });
    return undefined;
  }
  return { value: parsed.value };
}

/** トップが配列か `{ <key>: [...] }` のどちらでも受ける */
function listOf(value: unknown, key: string, file: string, push: Push): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value) && Array.isArray(value[key])) return value[key] as unknown[];
  if (value === null || value === undefined) return [];
  push({ file, message: `トップレベルは配列か { ${key}: [...] } にしてください` });
  return undefined;
}

function parseWhen(
  v: unknown,
  file: string,
  path: string,
  push: Push,
): Record<string, boolean> | undefined {
  if (v === undefined) return undefined;
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
    if (!isPlainObject(w) || !isStr(w.from) || !isStr(w.to)) {
      push({
        file,
        path: `${path}/${i}`,
        message: '線は { from: "<項目の参照>", to: "<項目の参照>" } で書いてください',
      });
      return undefined;
    }
    out.push({ from: w.from, to: w.to });
  }
  return out;
}

function parseStep(v: unknown, file: string, path: string, push: Push): BehaviorStep | undefined {
  if (!isPlainObject(v)) {
    push({ file, path, message: '段は { send: [...], back?: [...] } で書いてください' });
    return undefined;
  }
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
  const when = parseWhen(v.when, file, `${path}/when`, push);
  if (v.when !== undefined && !when) return undefined;
  if (when) step.when = when;
  return step;
}

/** 段の列（途中に `{ parallel: [[段...], [段...]] }` を書ける）。段の数の合計も返す */
function parseSteps(
  v: unknown,
  file: string,
  path: string,
  push: Push,
): { entries: BehaviorEntry[]; count: number } | undefined {
  if (!Array.isArray(v) || v.length === 0) {
    push({ file, path, message: 'steps は 1 つ以上の段の列にしてください' });
    return undefined;
  }
  const entries: BehaviorEntry[] = [];
  let count = 0;
  for (const [i, e] of v.entries()) {
    const here = `${path}/${i}`;
    if (isPlainObject(e) && e.parallel !== undefined) {
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
  return { entries, count };
}

function parseBehavior(v: unknown, file: string, path: string, push: Push): Behavior | undefined {
  if (!isPlainObject(v)) {
    push({ file, path, message: '挙動は { id, name, screen, trigger, steps } で書いてください' });
    return undefined;
  }
  for (const key of ['id', 'name', 'screen'] as const) {
    if (!isStr(v[key])) {
      push({ file, path: `${path}/${key}`, message: `挙動の ${key} がありません（文字列）` });
      return undefined;
    }
  }
  const id = v.id as string;
  if (badId(id)) {
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
    steps: steps.entries,
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
    out.result = {};
    if (typeof r.say === 'string') out.result.say = r.say;
    if (isStr(r.part)) out.result.part = r.part;
  }
  const when = parseWhen(v.when, file, `${path}/when`, push);
  if (v.when !== undefined && !when) return undefined;
  if (when) out.when = when;
  return out;
}

function parsePart(v: unknown, file: string, path: string, push: Push): Part | undefined {
  if (!isPlainObject(v)) {
    push({ file, path, message: '部品は { id, box, screen, selector } で書いてください' });
    return undefined;
  }
  for (const key of ['id', 'box', 'screen', 'selector'] as const) {
    if (!isStr(v[key])) {
      push({ file, path: `${path}/${key}`, message: `部品の ${key} がありません（文字列）` });
      return undefined;
    }
  }
  if (badId(v.id as string)) {
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

/**
 * root/.stack-atlas/ の図を読む。形の違う所は指摘（check: form）にして、読めた分だけ返す。
 * 箱・線・型の中身（契約のスキーマ）は、ここでは見ない（check.ts が、全部を合わせてから検証する）
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
  };

  // 箱と線: graph/*.yaml
  const dir = listLocalDir(root, [ATLAS_DIR, ATLAS_GRAPH_DIR]);
  if ('why' in dir) {
    push({
      file: rel(ATLAS_GRAPH_DIR),
      message:
        dir.why === 'missing'
          ? `${rel(ATLAS_GRAPH_DIR)}/ がありません（箱と線を書く *.yaml を置いてください）`
          : `${rel(ATLAS_GRAPH_DIR)}/ が${whyText(dir.why)}`,
    });
  } else {
    const old = dir.names.filter((n) => n.endsWith('.v2.yaml'));
    const names = dir.names.filter((n) => n.endsWith('.yaml') && !n.endsWith('.v2.yaml'));
    if (old.length)
      push({
        level: 'warning',
        file: rel(ATLAS_GRAPH_DIR),
        message: `*.v2.yaml（${old.join(', ')}）は古い形のファイルなので読みません。*.yaml にしてください`,
      });
    if (names.length === 0)
      push({
        file: rel(ATLAS_GRAPH_DIR),
        message: `${rel(ATLAS_GRAPH_DIR)}/ に *.yaml がありません`,
      });
    if (names.length > ATLAS_LIMITS.graphFiles)
      push({
        file: rel(ATLAS_GRAPH_DIR),
        message: `${names.length} ファイルあります。${ATLAS_LIMITS.graphFiles} ファイルまでにしてください（最初の分だけ読みます）`,
      });
    for (const name of names.slice(0, ATLAS_LIMITS.graphFiles)) {
      const file = rel(ATLAS_GRAPH_DIR, name);
      const y = readYaml(root, [ATLAS_GRAPH_DIR, name], push);
      if (!y) continue;
      atlas.files.push(file);
      const raw = y.value;
      if (!isPlainObject(raw)) {
        push({
          file,
          message: 'トップレベルは { nodes: [...], wires: [...], types?: [...] } にしてください',
        });
        continue;
      }
      const unknown = Object.keys(raw).filter((k) => !['nodes', 'wires', 'types'].includes(k));
      if (unknown.length)
        push({ level: 'warning', file, message: `未知のキー ${unknown.join(', ')} は読みません` });
      for (const key of ['nodes', 'wires', 'types'] as const) {
        const list = raw[key];
        if (list === undefined || list === null) continue;
        if (!Array.isArray(list)) {
          push({ file, path: `/${key}`, message: `${key} は配列で書いてください` });
          continue;
        }
        // 中身の検証は check.ts（契約のスキーマ）。ここでは置き場所だけ覚える
        for (const item of list) {
          if (key === 'nodes') {
            (atlas.nodes as unknown[]).push(item);
            atlas.nodeFiles.push(file);
          } else if (key === 'wires') {
            (atlas.wires as unknown[]).push(item);
            atlas.wireFiles.push(file);
          } else (atlas.types as unknown[]).push(item);
        }
      }
    }
    if (atlas.nodes.length > ATLAS_LIMITS.nodes || atlas.wires.length > ATLAS_LIMITS.wires) {
      push({
        file: rel(ATLAS_GRAPH_DIR),
        message: `箱 ${atlas.nodes.length}・線 ${atlas.wires.length} は上限（箱 ${ATLAS_LIMITS.nodes}・線 ${ATLAS_LIMITS.wires}）を超えています。超えた分は読みません`,
      });
      atlas.nodes.length = Math.min(atlas.nodes.length, ATLAS_LIMITS.nodes);
      atlas.nodeFiles.length = atlas.nodes.length;
      atlas.wires.length = Math.min(atlas.wires.length, ATLAS_LIMITS.wires);
      atlas.wireFiles.length = atlas.wires.length;
    }
  }

  // 部品: parts.yaml
  const partsFile = rel(ATLAS_PARTS_FILE);
  const py = readYaml(root, [ATLAS_PARTS_FILE], push);
  if (py) {
    atlas.files.push(partsFile);
    const list = listOf(py.value, 'parts', partsFile, push);
    for (const [i, v] of (list ?? []).slice(0, ATLAS_LIMITS.parts).entries()) {
      const part = parsePart(v, partsFile, `/parts/${i}`, push);
      if (part) atlas.parts.push(part);
    }
    if ((list?.length ?? 0) > ATLAS_LIMITS.parts)
      push({
        file: partsFile,
        message: `部品は ${ATLAS_LIMITS.parts} までにしてください（超えた分は読みません）`,
      });
  }

  // 挙動: behaviors.yaml
  const behaviorsFile = rel(ATLAS_BEHAVIORS_FILE);
  const by = readYaml(root, [ATLAS_BEHAVIORS_FILE], push);
  if (by) {
    atlas.files.push(behaviorsFile);
    const list = listOf(by.value, 'behaviors', behaviorsFile, push);
    for (const [i, v] of (list ?? []).slice(0, ATLAS_LIMITS.behaviors).entries()) {
      const b = parseBehavior(v, behaviorsFile, `/behaviors/${i}`, push);
      if (b) atlas.behaviors.push(b);
    }
    if ((list?.length ?? 0) > ATLAS_LIMITS.behaviors)
      push({
        file: behaviorsFile,
        message: `挙動は ${ATLAS_LIMITS.behaviors} までにしてください（超えた分は読みません）`,
      });
  }
  return { atlas, issues };
}
