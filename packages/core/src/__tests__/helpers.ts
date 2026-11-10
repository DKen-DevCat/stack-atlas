import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE = fileURLToPath(
  new URL('../../../../examples/fixture-repo/', import.meta.url),
);
export const SAMPLE = fileURLToPath(
  new URL('../../../../examples/race-site.graph.json', import.meta.url),
);

/** 一時ディレクトリにファイルを並べる */
export function tmpRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-atlas-core-'));
  for (const [p, content] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}
