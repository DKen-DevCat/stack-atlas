import type { Graph } from '@stack-atlas/schema';
import type { Logger } from '../types.js';

/**
 * キャッシュのルール 1 つ（docs/09 §3.2「ルールエンジン」）。1 判定 1 ファイル。
 * マージ・overrides・層の割り当てが済んだ Graph を受け取り、ノードの `cache` を書き換える。
 */
export interface Rule {
  id: string;
  /** 何を判定するか（ログ・ドキュメント用） */
  description?: string;
  apply(graph: Graph, log: Logger): void;
}
