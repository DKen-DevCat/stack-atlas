/**
 * Lambda 上のファイルシステム ISR の警告。
 *
 * 判定: インフラノードが `meta.cdktf.type === 'aws_lambda_function'` かつ `meta.deployApp === 'next'`
 *   （= Next.js を素の Lambda に載せている。incrementalCache は既定で /tmp）
 *   かつ cache がまだ無い（cache 抽出器や overrides が先に決めていれば尊重する）
 * → `{ tone: 'warn', badge: 'ISR /tmp', rules, note }` を付ける。
 *
 * `meta.next.cacheHandler`（または `meta.cacheHandler`）が真なら、共有キャッシュがあるとみなして何もしない。
 */
import { getCdktfMeta, getDeployApp } from '../meta.js';
import type { Rule } from './types.js';

export const LAMBDA_FS_ISR_NOTE =
  'インスタンスごとに別キャッシュになるため、古いページが混在しうる（revalidatePath も実行したインスタンスにしか効かない）→ S3 / DynamoDB などの共有キャッシュ（cacheHandler）に寄せたい';

export const lambdaFsIsr: Rule = {
  id: 'lambda-fs-isr',
  description:
    'Next.js を Lambda に載せていて ISR キャッシュが /tmp（インスタンスごと）になる構成を警告する',
  apply(graph) {
    for (const n of graph.nodes) {
      if (n.cache) continue;
      if (getCdktfMeta(n)?.type !== 'aws_lambda_function' || getDeployApp(n) !== 'next') continue;
      const next = n.meta?.next as { cacheHandler?: unknown } | undefined;
      if (next?.cacheHandler || n.meta?.cacheHandler) continue;
      n.cache = {
        tone: 'warn',
        badge: 'ISR /tmp',
        rules: [
          { key: 'incrementalCache', value: 'Lambda の /tmp（インスタンスごと）' },
          { key: 'revalidatePath', value: '実行したインスタンスにしか効かない' },
        ],
        note: LAMBDA_FS_ISR_NOTE,
      };
    }
  },
};
