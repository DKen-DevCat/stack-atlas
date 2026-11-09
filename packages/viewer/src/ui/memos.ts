/**
 * ノードのメモ。
 * - Phase 1: localStorage（docs/08 D8）→ LocalMemoStore
 * - Phase 5: 共有メモ（graph.json と同じディレクトリの memos.json、`serve` の GET /api/memos）を土台にし、
 *   このブラウザでの編集（localStorage）をノード ID ごとに上書きする → SharedMemoStore（docs/09 §3.5、D13）
 */

/**
 * id のメモ（自分のプロパティで文字列のときだけ）。`constructor`・`toString`・`__proto__` など継承したプロパティを拾わない
 * （箱 id や group は graph.json の文字列。拾うと文字列でない値に `.trim()` して配線図ごと落ちる）
 */
export function memoOf(memos: Readonly<Record<string, string>>, id: string): string | undefined {
  if (!Object.hasOwn(memos, id)) return undefined;
  const t: unknown = memos[id];
  return typeof t === 'string' ? t : undefined;
}

export interface MemoStore {
  get(id: string): string;
  /** 空文字（空白のみ）なら削除 */
  set(id: string, text: string): void;
  all(): Readonly<Record<string, string>>;
}

/** graph ごとの保存キー（project.name、なければ graph の URL / ファイル名） */
export function storageScope(projectName: string | undefined, source: string): string {
  return projectName?.trim() || source;
}

export const memoKey = (scope: string) => `stack-atlas-memos:${scope}`;
export const shotKey = (scope: string, id: string) => `stack-atlas-shot:${scope}:${id}`;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class LocalMemoStore implements MemoStore {
  private memos: Record<string, string> = {};

  constructor(
    private readonly scope: string,
    private readonly storage: StorageLike | null = safeStorage(),
  ) {
    try {
      const s = this.storage?.getItem(memoKey(scope));
      if (s) {
        const parsed: unknown = JSON.parse(s);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') this.memos[k] = v;
        }
      }
    } catch {
      /* 壊れたデータは無視する */
    }
  }

  get(id: string): string {
    return memoOf(this.memos, id) ?? '';
  }

  set(id: string, text: string): void {
    if (text.trim()) this.memos[id] = text;
    else delete this.memos[id];
    try {
      this.storage?.setItem(memoKey(this.scope), JSON.stringify(this.memos));
    } catch {
      /* 容量超過などは無視（表示上は保持） */
    }
  }

  all(): Readonly<Record<string, string>> {
    return this.memos;
  }
}

/** パネルの「差し替え」で貼ったスクショ（data URL）の保存 */
export class LocalShotStore {
  constructor(
    private readonly scope: string,
    private readonly storage: StorageLike | null = safeStorage(),
  ) {}

  get(id: string): string | null {
    try {
      return this.storage?.getItem(shotKey(this.scope, id)) ?? null;
    } catch {
      return null;
    }
  }

  /** 保存できたら true */
  set(id: string, dataUrl: string): boolean {
    try {
      this.storage?.setItem(shotKey(this.scope, id), dataUrl);
      return !!this.storage;
    } catch {
      return false;
    }
  }

  remove(id: string): void {
    try {
      this.storage?.removeItem(shotKey(this.scope, id));
    } catch {
      /* noop */
    }
  }
}

// ---------------------------------------------------------------- 共有メモ（Phase 5）

export type Memos = Record<string, string>;

/** memos.json / API の応答を `Record<id, string>` にする（文字列以外・空文字は捨てる）。形が違えば null */
export function parseMemos(json: unknown): Memos | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const out: Memos = {};
  for (const [k, v] of Object.entries(json)) if (typeof v === 'string' && v.trim()) out[k] = v;
  return out;
}

/** キーを昇順に並べた JSON（memos.json の書き出し・保存用。Git の差分が安定する） */
export function serializeMemos(m: Readonly<Memos>): string {
  const sorted: Memos = {};
  for (const k of Object.keys(m).sort()) sorted[k] = m[k]!;
  return JSON.stringify(sorted, null, 2) + '\n';
}

/**
 * 共有メモとローカルの編集を合わせる。
 * - shared が土台。local（空でない上書き）と deleted（ローカルで消したもの）がノード ID ごとに勝つ
 */
export function mergeMemos(
  shared: Readonly<Memos>,
  local: Readonly<Memos>,
  deleted: ReadonlySet<string> = new Set(),
): Memos {
  const out: Memos = { ...shared };
  for (const id of deleted) delete out[id];
  for (const [id, t] of Object.entries(local)) if (t.trim()) out[id] = t;
  return out;
}

/** graph に無いノード ID のメモ（孤立メモ）。ID 昇順 */
export function orphanIds(memos: Readonly<Memos>, nodeIds: ReadonlySet<string>): string[] {
  return Object.keys(memos)
    .filter((id) => !nodeIds.has(id))
    .sort();
}

export type MemoStatus = 'none' | 'shared' | 'local';

const deletedKey = (scope: string) => `stack-atlas-memos-deleted:${scope}`;

/**
 * 共有メモ ＋ ローカルの上書き。
 * ローカルの上書きは LocalMemoStore（従来と同じ localStorage のキー）に、
 * 共有メモをローカルで消したことは別キー（ID の配列）に持つ。
 */
export class SharedMemoStore implements MemoStore {
  private shared: Memos;
  private readonly local: LocalMemoStore;
  private readonly deleted = new Set<string>();
  private merged: Memos = {};

  constructor(
    private readonly scope: string,
    shared: Readonly<Memos> = {},
    private readonly storage: StorageLike | null = safeStorage(),
  ) {
    this.shared = { ...shared };
    this.local = new LocalMemoStore(scope, storage);
    try {
      const s = storage?.getItem(deletedKey(scope));
      const arr: unknown = s ? JSON.parse(s) : [];
      if (Array.isArray(arr))
        for (const id of arr) if (typeof id === 'string') this.deleted.add(id);
    } catch {
      /* 壊れたデータは無視する */
    }
    this.prune();
  }

  get(id: string): string {
    return memoOf(this.merged, id) ?? '';
  }

  set(id: string, text: string): void {
    const sharedText = memoOf(this.shared, id);
    if (!text.trim()) {
      this.local.set(id, '');
      if (sharedText !== undefined) this.deleted.add(id);
    } else {
      this.deleted.delete(id);
      // 共有と同じ文面に戻したら上書きを消す（未保存の印も消える）
      this.local.set(id, text === sharedText ? '' : text);
    }
    this.persistDeleted();
    this.recompute();
  }

  all(): Readonly<Memos> {
    return this.merged;
  }

  sharedMemos(): Readonly<Memos> {
    return this.shared;
  }

  /** 'local' = このブラウザでの編集が共有と違う（未保存）、'shared' = 共有のまま、'none' = メモなし */
  status(id: string): MemoStatus {
    if (this.isLocal(id)) return 'local';
    return memoOf(this.merged, id) ? 'shared' : 'none';
  }

  /** 未保存（ローカルの上書き・削除）のノード ID */
  unsavedIds(): string[] {
    const ids = new Set([...Object.keys(this.local.all()), ...this.deleted]);
    return [...ids].filter((id) => this.isLocal(id)).sort();
  }

  /** text を to のメモに移す（to に既にあれば改行で続ける）。from は消す */
  move(from: string, to: string): void {
    if (from === to) return;
    const text = this.get(from);
    if (!text) return;
    const cur = this.get(to);
    this.set(to, cur ? `${cur}\n${text}` : text);
    this.set(from, '');
  }

  /**
   * 共有メモを差し替える（サーバーへの保存に成功したとき・あとから共有メモを読み込んだとき）。
   * 共有と同じになったローカルの上書き・削除は消す。
   */
  setShared(shared: Readonly<Memos>): void {
    this.shared = { ...shared };
    this.prune();
  }

  /**
   * 共有メモと同じになった上書き・意味のない削除の印を消す。
   * 共有メモが空のとき（ファイルをドロップして開いた、memos.json を読めなかった）は
   * 「共有を知らない」だけなので、削除の印は残す。消すと次に serve で開いたとき削除したメモが戻ってくる
   */
  private prune(): void {
    for (const [id, t] of Object.entries(this.local.all())) {
      if (memoOf(this.shared, id) === t) this.local.set(id, '');
    }
    if (Object.keys(this.shared).length > 0) {
      for (const id of [...this.deleted])
        if (memoOf(this.shared, id) === undefined) this.deleted.delete(id);
    }
    this.persistDeleted();
    this.recompute();
  }

  private isLocal(id: string): boolean {
    const l = memoOf(this.local.all(), id);
    const sharedText = memoOf(this.shared, id);
    if (l !== undefined) return l !== sharedText;
    return this.deleted.has(id) && sharedText !== undefined;
  }

  private recompute(): void {
    this.merged = mergeMemos(this.shared, this.local.all(), this.deleted);
  }

  private persistDeleted(): void {
    try {
      if (this.deleted.size)
        this.storage?.setItem(deletedKey(this.scope), JSON.stringify([...this.deleted].sort()));
      else this.storage?.removeItem(deletedKey(this.scope));
    } catch {
      /* noop */
    }
  }
}

// ---------------------------------------------------------------- 読み込み・保存（fetch）

export interface SharedMemoSource {
  memos: Memos;
  /** `GET /api/memos` が JSON を返した（serve で開いている） */
  api: boolean;
  /** API の URL（api が true のとき） */
  apiUrl?: string;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
  if (!res.ok) return undefined;
  // SPA のフォールバックで index.html が返ることがあるので、JSON として読めるときだけ使う
  try {
    return JSON.parse(await res.text());
  } catch {
    return undefined;
  }
}

/**
 * 共有メモを集める。
 * - graph.json と同じディレクトリの memos.json（無ければ無視）
 * - graph をページと同じオリジンから読んだときは `GET /api/memos`（serve。失敗は無視）。
 *   読めたら API だけを正とする（memos.json と混ぜない。古い build の memos.json に残ったメモが
 *   リポジトリから消したあとも表示され、次の保存で書き戻されてしまうため）
 */
export async function loadSharedMemos(
  graphUrl: string | undefined,
  pageHref: string,
): Promise<SharedMemoSource> {
  if (!graphUrl) return { memos: {}, api: false };
  let fileMemos: Memos = {};
  try {
    fileMemos = parseMemos(await fetchJson(new URL('memos.json', graphUrl).href)) ?? {};
  } catch {
    /* 404・ネットワークエラーは無視 */
  }
  try {
    const page = new URL(pageHref);
    if (new URL(graphUrl).origin === page.origin) {
      const apiUrl = new URL('/api/memos', page.origin).href;
      const api = parseMemos(await fetchJson(apiUrl));
      if (api) return { memos: api, api: true, apiUrl };
    }
  } catch {
    /* API なし */
  }
  return { memos: fileMemos, api: false };
}

export type SaveResult =
  { ok: true; count: number } | { ok: false; unsupported: boolean; message: string };

export const UNSUPPORTED_SAVE_MESSAGE =
  'このサーバーは書き込みに対応していません（--repo なしで serve）';

/** `POST /api/memos` でリポジトリの .stack-atlas/memos.json に書き戻す */
export async function saveMemosToServer(
  apiUrl: string,
  memos: Readonly<Memos>,
): Promise<SaveResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serializeMemos(memos),
    });
  } catch (e) {
    return { ok: false, unsupported: false, message: `保存できませんでした: ${String(e)}` };
  }
  if (res.status === 405 || res.status === 404) {
    return { ok: false, unsupported: true, message: UNSUPPORTED_SAVE_MESSAGE };
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === 'string') msg = j.error;
    } catch {
      /* noop */
    }
    return { ok: false, unsupported: false, message: `保存できませんでした: ${msg}` };
  }
  return { ok: true, count: Object.keys(memos).length };
}

/** memos.json としてダウンロードさせる */
export function downloadMemos(memos: Readonly<Memos>, filename = 'memos.json'): void {
  const blob = new Blob([serializeMemos(memos)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
