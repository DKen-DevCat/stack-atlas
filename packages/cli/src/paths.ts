import { fileURLToPath } from 'node:url';

/**
 * ワークスペース内のビューアのビルド成果物（packages/viewer/dist）。
 * src/ からも dist/ からも 2 つ上が packages/ になる。
 */
export const VIEWER_DIST = fileURLToPath(new URL('../../viewer/dist/', import.meta.url));
