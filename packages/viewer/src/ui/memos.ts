/**
 * ノードのメモ。Phase 1 は localStorage（docs/08 D8）。
 * 保存先は MemoStore インターフェースで差し替えられるようにしておく（Phase 5 で memos.json へ）。
 */

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
    return this.memos[id] ?? '';
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
