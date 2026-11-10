import { fileURLToPath } from 'node:url';

/**
 * ワークスペース内のビューアのビルド成果物（packages/viewer/dist）。
 * src/ からも dist/ からも 2 つ上が packages/ になる。
 */
export const VIEWER_DIST = fileURLToPath(new URL('../../viewer/dist/', import.meta.url));

/**
 * ワークスペースのハーネスの skill（harness/skill。`init --skill` のコピー元。docs/19 §3.6）。CLI は npm に出していないので、
 * ビューアの dist と同じく import.meta.url で解く（src/ からも dist/ からも 3 つ上がワークスペースの根）
 */
export const HARNESS_SKILL = fileURLToPath(new URL('../../../harness/skill/', import.meta.url));
