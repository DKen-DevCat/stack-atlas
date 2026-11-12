/**
 * 「手元」の判定（docs/27 §5.2、D232）。手元とは: ループバックのアドレスそのもの・`localhost`・`*.localhost`・
 * 利用者が名指しして、ブラウザの中でループバックに固定した名前だけ。**名前を解いた結果では決めない**
 * （道具が解いた結果と、ブラウザが実際につなぐ先は、別になりうる）
 */

/** ブラウザの中継の設定で、中継を通さずに直に出す宛先（これ以外は、行き先の無い中継に回る） */
export const LOOPBACK_BYPASS = ['127.0.0.0/8', '[::1]', 'localhost', '*.localhost'] as const;

/** 名指しできる名前の形（英小文字・数字・`-` の段を `.` でつないだもの。IP アドレスの形は名指しできない） */
const NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** URL の hostname（URL が正規化したもの）が、ループバックか */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && Number(m[1]) === 127 && m.slice(1).every((x) => Number(x) <= 255);
}

/** 手元か（ループバックか、名指しした名前） */
export function isLocalHost(hostname: string, localNames: readonly string[] = []): boolean {
  return isLoopbackHost(hostname) || localNames.includes(hostname.toLowerCase());
}

/** 名指しの名前を確かめる。誤りなら、その理由の文 */
export function checkLocalName(name: string): string | undefined {
  const n = name.toLowerCase();
  if (!NAME.test(n))
    return `--local-name "${name}" は、名前の形ではありません（英字・数字・- と . だけ）`;
  if (/^[\d.]+$/.test(n)) return `--local-name に、アドレスは書けません（"${name}"）`;
  return undefined;
}

/**
 * ライブで開く URL を確かめる。http か https で、宛先が手元のときだけ通す（D207・D231。名指しで外につなぐ道は作らない）
 */
export function checkLiveUrl(
  raw: string,
  localNames: readonly string[] = [],
): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `--url "${raw}" は、URL として読めません` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { error: `--url は http か https にしてください（"${url.protocol}"）` };
  if (url.username || url.password)
    return { error: '--url に、利用者の名前やパスワードを書かないでください' };
  if (!isLocalHost(url.hostname, localNames))
    return {
      error:
        `--url の宛先 "${url.hostname}" は、手元ではありません。ライブは、手元で起動したアプリだけを開きます` +
        '（127.0.0.1・localhost・*.localhost。開発用に決めた名前は --local-name で名指しすると、手元に固定して使えます）',
    };
  return { url };
}

/** ブラウザの起動の引数: 名指しした名前を、ブラウザの中でループバックに固定する */
export function resolverRules(localNames: readonly string[]): string[] {
  const names = localNames.filter((n) => !isLoopbackHost(n));
  return names.length
    ? [`--host-resolver-rules=${names.map((n) => `MAP ${n} 127.0.0.1`).join(', ')}`]
    : [];
}

/** 中継を通さずに直に出す宛先の一覧（ブラウザの中継の設定の書き方） */
export const proxyBypass = (localNames: readonly string[]): string =>
  [...LOOPBACK_BYPASS, ...localNames].join(',');
