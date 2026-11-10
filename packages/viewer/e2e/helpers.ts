import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const SAMPLE_URL = '?graph=samples/race-site.graph.json';

export function loadSample(): {
  nodes: { id: string; position?: unknown }[];
  [k: string]: unknown;
} {
  return JSON.parse(
    readFileSync(new URL('../../../examples/race-site.graph.json', import.meta.url), 'utf8'),
  );
}

/**
 * 共有メモは「あれば読む」ので 404 は正常（memos.json が無い、serve ではない）。
 * ブラウザが console に出す「Failed to load resource」はこの 2 つに限って無視する
 */
const OPTIONAL_RESOURCES = /\/(memos\.json|api\/memos)(\?|$)/;

/** ページのエラー（例外・console.error）を集める */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text()) && OPTIONAL_RESOURCES.test(m.location().url)) {
      return;
    }
    errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** graph.json の URL を差し替えて開く */
export async function openWithGraph(page: Page, graph: unknown, name = 'test.graph.json') {
  await page.route(`**/${name}`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) }),
  );
  await page.goto(`?graph=${name}`);
  await waitReady(page);
}

export async function waitReady(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-status', 'ready');
  // 数フレーム描画させる
  await page.waitForTimeout(400);
}
