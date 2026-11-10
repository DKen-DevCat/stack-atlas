// 分岐の表の出し入れ（docs/15 §3.4b）。箱に入ったら出し、箱からも表からも離れたら少し待って消す。
// 表は箱の右に少し離れて出るので、箱 → 表へポインタを動かす間に隙間（SVG の地や線）を通る。すぐ消すと表に届かない
// （2026-11-09 のレビュー指摘）。待つ間に箱か表へ入れば消さない。DOM に触らない（単体テストできる）

/** 消すまで待つ時間 */
export const TABLE_HIDE_DELAY_MS = 150;

export interface TableHoverDeps {
  hasVariants: (id: string) => boolean;
  /** 表を出している箱（無ければ null） */
  tableNode: () => string | null;
  showTable: (id: string) => void;
  hideTable: () => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TableHover {
  /**
   * ポインタが乗ったもの。box は乗っている箱の id（無ければ null）、inTable は分岐の表（と箱との間の橋）の上か
   */
  over(box: string | null, inTable: boolean): void;
  /** ポインタが配線図の外へ出た */
  leave(): void;
  /** 待っている消去を取り消す（片付け） */
  dispose(): void;
}

export function createTableHover(d: TableHoverDeps): TableHover {
  const delay = d.delayMs ?? TABLE_HIDE_DELAY_MS;
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: unknown = null;

  const cancel = () => {
    if (pending === null) return;
    clearTimer(pending);
    pending = null;
  };
  const hideLater = () => {
    if (pending !== null || d.tableNode() === null) return;
    pending = setTimer(() => {
      pending = null;
      d.hideTable();
    }, delay);
  };

  return {
    over(box, inTable) {
      if (inTable) return cancel();
      if (box !== null) {
        cancel();
        if (box === d.tableNode()) return;
        // 別の箱へ移ったらすぐ切り替える（分岐の無い箱なら表を消す）
        if (d.hasVariants(box)) d.showTable(box);
        else d.hideTable();
        return;
      }
      hideLater();
    },
    leave: hideLater,
    dispose: cancel,
  };
}
