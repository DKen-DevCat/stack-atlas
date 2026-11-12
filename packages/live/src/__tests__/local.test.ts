// 「手元」の判定（docs/27 §5.2、D232）。名前を解いた結果では決めない
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LOOPBACK_BYPASS,
  checkLiveUrl,
  checkLocalName,
  isLocalHost,
  isLoopbackHost,
  proxyBypass,
  resolverRules,
} from '../local.js';

describe('手元の判定', () => {
  it('ループバックのアドレス・localhost・*.localhost だけが、ループバック', () => {
    for (const h of [
      '127.0.0.1',
      '127.1.2.3',
      '127.255.255.255',
      'localhost',
      'app.localhost',
      '[::1]',
    ])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of [
      '128.0.0.1',
      '10.0.0.1',
      '192.168.1.5',
      '0.0.0.0',
      'localhost.',
      'localhost.example.com',
      'notlocalhost',
      '[::ffff:7f00:1]',
      '127.0.0.256',
      'example.com',
    ])
      expect(isLoopbackHost(h), h).toBe(false);
  });

  it('URL が正規化した形で比べる（短い書き方・16 進の書き方のアドレスも、正規化されてから判定される）', () => {
    for (const raw of ['http://127.1:3000/', 'http://0x7f.0.0.1/', 'http://LOCALHOST:3000/'])
      expect(checkLiveUrl(raw), raw).toHaveProperty('url');
  });

  it('名指しした名前は、手元に数える（名前の形だけ。アドレスは名指しできない）', () => {
    expect(isLocalHost('dev.test', ['dev.test'])).toBe(true);
    expect(isLocalHost('dev.test')).toBe(false);
    expect(checkLocalName('dev.test')).toBeUndefined();
    expect(checkLocalName('API-1.dev')).toBeUndefined();
    for (const bad of ['192.168.1.5', '10.0.0.1', 'a_b.test', 'a b', '', 'http://x', '-a.test'])
      expect(checkLocalName(bad), bad).toBeDefined();
    // 2026-11-12 追加（セキュリティのレビュー 2）: 数で終わる名前は、ブラウザがアドレスとして読む（16 進・8 進の書き方も）
    for (const bad of [
      '0xc0a80105',
      '0xc0.0xa8.1.5',
      '1.2.3.0x4',
      '0x7f000001',
      'dev.0x1',
      'a.08',
      'dev.1',
    ])
      expect(checkLocalName(bad), bad).toBeDefined();
  });

  it('checkLiveUrl: http・https で、宛先が手元のときだけ通す', () => {
    expect(checkLiveUrl('http://localhost:3000/a?b=1')).toMatchObject({
      url: new URL('http://localhost:3000/a?b=1'),
    });
    expect(checkLiveUrl('https://app.localhost/')).toHaveProperty('url');
    expect(checkLiveUrl('http://dev.test/', ['dev.test'])).toHaveProperty('url');
    const refuse = (raw: string) => (checkLiveUrl(raw) as { error: string }).error;
    expect(refuse('http://staging.example.com/')).toContain('手元ではありません');
    expect(refuse('http://192.168.1.5:3000/')).toContain('手元ではありません');
    expect(refuse('file:///etc/passwd')).toContain('http か https');
    expect(refuse('ftp://localhost/')).toContain('http か https');
    expect(refuse('http://user:pass@localhost/')).toContain('パスワード');
    expect(refuse('not a url')).toContain('URL として読めません');
  });

  it('ブラウザの起動の設定: 手元だけを直に出し、名指しした名前はループバックに固定する', () => {
    // 2026-11-12 変更（セキュリティのレビュー 1）: 先頭に <-loopback> を置く。ブラウザが暗黙に中継を外す宛先
    // （ループバックとリンクローカル）をいったん取り消し、ループバックだけを戻す。順序に意味がある（あとの規則が勝つ）
    expect(LOOPBACK_BYPASS).toEqual([
      '<-loopback>',
      '127.0.0.0/8',
      '[::1]',
      'localhost',
      '*.localhost',
    ]);
    expect(proxyBypass(['dev.test'])).toBe(
      '<-loopback>,127.0.0.0/8,[::1],localhost,*.localhost,dev.test',
    );
    expect(resolverRules(['dev.test', 'api.dev.test'])).toEqual([
      '--host-resolver-rules=MAP dev.test 127.0.0.1, MAP api.dev.test 127.0.0.1',
    ]);
    expect(resolverRules([])).toEqual([]);
    expect(resolverRules(['app.localhost'])).toEqual([]);
  });
});

describe('道具は、言語を選ばない（docs/24。docs/27 の条件 11）', () => {
  it('見張りと、最小のライブの画面のコードに、特定の言語やフレームワークの名前が無い', () => {
    // 名前の一覧は、手順書のテスト（packages/core の atlas-guide.test.ts）と同じもの
    const names =
      /\b(React|Vue|Svelte|Angular|Next\.?js|Nuxt|TypeScript|JavaScript|Python|Java|Kotlin|Swift|PHP|Ruby|Rails|Laravel|Django|Flask|FastAPI|Spring|Express|WordPress|Golang|Rust|Terraform|SQL|GraphQL|JSX|TSX)\b/i;
    const files = [
      ...['../', '../../page/'].flatMap((d) => {
        const dir = fileURLToPath(new URL(d, import.meta.url));
        return readdirSync(dir)
          .filter((f) => /\.(ts|js|html|css)$/.test(f))
          .map((f) => `${dir}${f}`);
      }),
    ];
    expect(files.length).toBeGreaterThan(8);
    // 道具が自分の画面のスクリプトを配るときの、内容の種類の書き方（text/javascript）は除く。
    // 対象のアプリの言語に依る処理ではなく、ブラウザに自分のファイルを渡すための決まった書き方
    for (const f of files)
      expect(
        readFileSync(f, 'utf8').replaceAll('text/javascript', '').match(names)?.[0],
        f,
      ).toBeUndefined();
  });
});
