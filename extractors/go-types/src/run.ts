/**
 * helper（標準ライブラリだけの Go プログラム。`helper/`）を動かす（docs/17 §3.3・§7 #7、D48・D51）。
 *
 * - 1 回だけ `go build` して、実行ファイルを利用者ごとのキャッシュ（`$XDG_CACHE_HOME`・`~/Library/Caches`・`~/.cache`
 *   の下の `stack-atlas/go-helper`。作れなければ一時ディレクトリの `stack-atlas-go-<uid>`、それも駄目なら mkdtemp）に
 *   置き、実行ファイルを直接動かす。名前は helper のソースと go のバージョン・GOROOT のハッシュ
 *   （`stack-atlas-go-helper-<hash>`）。ディレクトリは 0700 で、持ち主が自分であること・シンボリックリンクでないことを確かめる
 *   （2026-11-09 8-2b レビュー S1・S6: `go run` だと時間の上限で `go` だけが止まり、helper の子が残っていた。
 *   共有の固定の `/tmp/stack-atlas-go-cache` は他の利用者が先に作れた）
 * - シェルを通さない（execFile と引数の配列）。解析対象のモジュールは `-root` の引数で渡す（絶対パスにする）
 * - 環境: `GOFLAGS=-mod=readonly GOPROXY=off GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0`（ビルドはネットワークも
 *   ツールチェーンの取得もしない。cwd は helper のディレクトリ）。GOOS / GOARCH は外す（helper は手元で動く）。
 *   HOME も GOCACHE も無い環境では GOCACHE を上の利用者ごとのディレクトリの `gocache` に置く。動かすときは GOROOT を
 *   今の go のものにする（helper は標準ライブラリのソースを GOROOT から読む）
 * - 時間の上限（既定 120 秒）は実行ファイルに掛け、超えたら SIGKILL。helper 自身も `-timeout` で止まる（最後の守り。
 *   終了コード 3）。標準出力の上限（既定 64 MiB）を超えても SIGKILL。ビルドは別に上限（既定 120 秒か、それより長い
 *   timeoutMs）
 * - go が無い（ENOENT・go.mod の go 行より古い）ときは GoMissingError
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** helper のディレクトリ（src/ からも dist/ からも ../helper） */
export const HELPER_DIR = fileURLToPath(new URL('../helper/', import.meta.url));

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
/** ビルドの時間の上限の既定（timeoutMs がこれより長ければそちら） */
export const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
/** helper が -timeout に着いたときの終了コード（helper/main.go の exitTimeout） */
export const EXIT_TIMEOUT = 3;

/** go が無い（か、helper の go.mod の go 行より古い） */
export class GoMissingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GoMissingError';
  }
}

export interface RunHelperOptions {
  /** go の実行ファイル（既定 `go`。PATH から探す） */
  goBin?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** 元にする環境（既定 process.env） */
  env?: NodeJS.ProcessEnv;
  /** helper のディレクトリ（テスト用） */
  helperDir?: string;
  /** helper の実行ファイルを置くディレクトリ（既定は helperCacheDir。テスト用） */
  cacheDir?: string;
  /** 標準入力に渡す文字列（`-schema-stdin` の SQL のスキーマ） */
  input?: string;
}

const getuid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

/** 利用者のキャッシュの置き場（Go の os.UserCacheDir と同じ考え方）。決められなければ undefined */
function userCacheBase(env: NodeJS.ProcessEnv): string | undefined {
  const xdg = env['XDG_CACHE_HOME'];
  if (xdg && isAbsolute(xdg)) return xdg;
  if (process.platform === 'win32') {
    const local = env['LocalAppData'] ?? env['LOCALAPPDATA'];
    return local && isAbsolute(local) ? local : undefined;
  }
  const home = env['HOME'];
  if (!home || !isAbsolute(home)) return undefined;
  return process.platform === 'darwin' ? join(home, 'Library', 'Caches') : join(home, '.cache');
}

/** 自分だけが書けるディレクトリにする（作る・0700・持ち主が自分・シンボリックリンクでない）。駄目なら例外 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Error(`${dir} がディレクトリではありません`);
  const uid = getuid();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} の持ち主が自分ではありません`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * helper の実行ファイル（と GOCACHE の代わり）を置く、利用者ごとのディレクトリ。利用者のキャッシュ → 一時ディレクトリの
 * `stack-atlas-go-<uid>` → mkdtemp の順に、自分だけが書けるものを選ぶ
 */
export function helperCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = userCacheBase(env);
  const candidates = [
    base ? join(base, 'stack-atlas', 'go-helper') : undefined,
    join(tmpdir(), `stack-atlas-go-${getuid() ?? 'user'}`),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      ensurePrivateDir(dir);
      return dir;
    } catch {
      /* 次の候補 */
    }
  }
  return mkdtempSync(join(tmpdir(), 'stack-atlas-go-'));
}

/** helper を動かす環境（D48） */
export function helperEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env['GOOS'];
  delete env['GOARCH'];
  delete env['GOFLAGS'];
  Object.assign(env, {
    GOFLAGS: '-mod=readonly',
    GOPROXY: 'off',
    GOWORK: 'off',
    GOTOOLCHAIN: 'local',
    CGO_ENABLED: '0',
  });
  if (!env['GOCACHE'] && !env['HOME'] && !env['XDG_CACHE_HOME'] && !env['LocalAppData'])
    env['GOCACHE'] = join(helperCacheDir(base), 'gocache');
  return env;
}

const TOO_OLD = /go\.mod requires go >=|go: cannot find GOROOT|toolchain not available/;

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecError = Omit<NodeJS.ErrnoException, 'code'> & {
  killed?: boolean;
  signal?: string | null;
  code?: string | number;
  stdout?: string;
  stderr?: string;
};

function run(
  file: string,
  args: string[],
  opts: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    input?: string;
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: opts.env,
        timeout: opts.timeout,
        killSignal: 'SIGKILL',
        maxBuffer: opts.maxBuffer,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout, stderr });
          reject(err);
        } else resolve({ stdout, stderr });
      },
    );
    // 止めた子の標準入力への書き込みの失敗（EPIPE）は捨てる（結果は上のコールバックで分かる）
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });
}

const firstLine = (s: string | undefined) => (s ?? '').trim().split('\n')[0] ?? '';

/** go のバージョンと GOROOT（go が無ければ GoMissingError） */
async function goInfo(goBin: string, env: NodeJS.ProcessEnv) {
  try {
    const { stdout } = await run(goBin, ['env', 'GOVERSION', 'GOROOT'], {
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const [version = '', goroot = ''] = stdout.trim().split('\n');
    return { version: version.trim(), goroot: goroot.trim() };
  } catch (e) {
    const err = e as ExecError;
    if (err.code === 'ENOENT')
      throw new GoMissingError(`go が見つかりません（${goBin}）`, { cause: e });
    if (TOO_OLD.test(err.stderr ?? ''))
      throw new GoMissingError(`go が古いか使えません: ${firstLine(err.stderr)}`, { cause: e });
    throw new Error(`go-types: go env が失敗しました: ${firstLine(err.stderr) || err.message}`, {
      cause: e,
    });
  }
}

/** helper のソース（*.go・go.mod・go.sum）のハッシュ */
function sourceHash(helperDir: string): string {
  const h = createHash('sha256');
  const names = readdirSync(helperDir)
    .filter((n) => n.endsWith('.go') || n === 'go.mod' || n === 'go.sum')
    .sort();
  for (const n of names) {
    h.update(n);
    h.update('\0');
    h.update(readFileSync(join(helperDir, n)));
    h.update('\0');
  }
  return h.digest('hex');
}

interface BuiltHelper {
  bin: string;
  goroot: string;
}

/** 同じプロセスの中のビルドのメモ（失敗はメモしない） */
const builds = new Map<string, Promise<BuiltHelper>>();

async function buildHelper(o: {
  goBin: string;
  helperDir: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}): Promise<BuiltHelper> {
  const { version, goroot } = await goInfo(o.goBin, o.env);
  const key = createHash('sha256')
    .update([sourceHash(o.helperDir), version, goroot, process.platform, process.arch].join('\0'))
    .digest('hex')
    .slice(0, 20);
  const bin = join(
    o.cacheDir,
    `stack-atlas-go-helper-${key}${process.platform === 'win32' ? '.exe' : ''}`,
  );
  if (existsSync(bin)) {
    const st = lstatSync(bin);
    if (st.isFile() && !st.isSymbolicLink()) return { bin, goroot };
    rmSync(bin, { force: true, recursive: true });
  }
  const tmp = `${bin}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await run(o.goBin, ['build', '-o', tmp, '.'], {
      cwd: o.helperDir,
      env: o.env,
      timeout: o.timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    renameSync(tmp, bin);
  } catch (e) {
    rmSync(tmp, { force: true });
    const err = e as ExecError;
    if (err.code === 'ENOENT')
      throw new GoMissingError(`go が見つかりません（${o.goBin}）`, { cause: e });
    if (TOO_OLD.test(err.stderr ?? ''))
      throw new GoMissingError(`go が古いか使えません: ${firstLine(err.stderr)}`, { cause: e });
    if (err.killed || err.signal)
      throw new Error(
        `go-types: helper のビルドが ${Math.round(o.timeout / 1000)} 秒の上限で止まりました`,
        { cause: e },
      );
    const msg = (err.stderr ?? '').trim().split('\n').slice(-5).join(' / ') || err.message;
    throw new Error(`go-types: helper のビルドに失敗しました: ${msg}`, { cause: e });
  }
  return { bin, goroot };
}

/** helper の実行ファイル（無ければビルドする）。go が無ければ GoMissingError */
export function ensureHelper(opts: RunHelperOptions = {}): Promise<BuiltHelper> {
  const goBin = opts.goBin ?? 'go';
  const helperDir = opts.helperDir ?? HELPER_DIR;
  const env = helperEnv(opts.env);
  const cacheDir = opts.cacheDir ?? helperCacheDir(opts.env ?? process.env);
  if (opts.cacheDir) ensurePrivateDir(cacheDir);
  const memo = [goBin, helperDir, cacheDir].join('\0');
  let p = builds.get(memo);
  if (!p) {
    p = buildHelper({
      goBin,
      helperDir,
      cacheDir,
      env,
      timeout: Math.max(DEFAULT_BUILD_TIMEOUT_MS, opts.timeoutMs ?? 0),
    });
    builds.set(memo, p);
    p.catch(() => builds.delete(memo));
  }
  return p;
}

/** helper を動かして標準出力（JSON の文字列）を返す。`-root` の相対パスは呼んだ側の cwd で解く（helper の cwd ではなく） */
export async function runHelper(rawArgs: string[], opts: RunHelperOptions = {}): Promise<string> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = rawArgs.map((a, i) => (rawArgs[i - 1] === '-root' ? resolvePath(a) : a));
  const { bin, goroot } = await ensureHelper(opts);
  const env = helperEnv(opts.env);
  if (goroot) env['GOROOT'] = goroot;
  const timeoutError = (cause: unknown) =>
    new Error(
      `go-types: helper が ${Math.round(timeout / 1000)} 秒の上限で止まりました（STACK_ATLAS_GO_TIMEOUT_MS で延ばせます）`,
      { cause },
    );
  try {
    const { stdout } = await run(bin, ['-timeout', `${timeout}ms`, ...args], {
      cwd: opts.helperDir ?? HELPER_DIR,
      env,
      timeout,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
    return stdout;
  } catch (e) {
    const err = e as ExecError;
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw new Error('go-types: helper の出力が上限を超えました', { cause: e });
    if (err.killed || err.signal || err.code === EXIT_TIMEOUT) throw timeoutError(e);
    const msg = (err.stderr ?? '').trim().split('\n').slice(-5).join(' / ') || err.message;
    throw new Error(`go-types: helper が失敗しました: ${msg}`, { cause: e });
  }
}
