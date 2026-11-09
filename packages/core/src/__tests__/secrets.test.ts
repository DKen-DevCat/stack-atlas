// 秘密らしいファイルの判定（8-4 のセキュリティレビュー S2）。箱は残し code だけを外す対象。
// 2026-11-10: `id_*` を全部秘密にすると id_generator.ts などのソースの code まで外れたので、ssh の鍵の名前だけにした
import { describe, expect, it } from 'vitest';
import { isSecretFile } from '../secrets.js';

describe('isSecretFile', () => {
  it.each([
    '.env',
    'web/.env.local',
    'certs/server.pem',
    'keys/app.key',
    'id_rsa',
    'home/.ssh/config',
    'deploy/id_ed25519.pub',
    'id_ecdsa_sk',
    'config/client_secret.json',
    'aws/credentials',
    '../outside/x.ts',
    '/etc/passwd',
  ])('%s は秘密らしい', (f) => {
    expect(isSecretFile(f)).toBe(true);
  });

  it.each(['src/id_generator.ts', 'lib/identity.ts', 'web/src/app/page.tsx', 'platform/internal/api/today.go'])(
    '%s は秘密らしくない',
    (f) => {
      expect(isSecretFile(f)).toBe(false);
    },
  );
});
