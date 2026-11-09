/**
 * helper（標準ライブラリだけの Go プログラム。`helper/`）を `go run .` で動かす（docs/17 §3.3・§7 #7、D48・D51）。
 *
 * - シェルを通さない（execFile と引数の配列）。cwd は helper のディレクトリ。解析対象のモジュールは `-root` の引数で渡す
 * - 環境: `GOFLAGS=-mod=readonly GOPROXY=off GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0`（解析対象の go.mod / go.sum を
 *   書き換えず、ネットワークもツールチェーンの取得もしない）。GOOS / GOARCH は外す（helper は手元で動く）。
 *   HOME も GOCACHE も無い環境では GOCACHE を OS の一時ディレクトリに置く
 * - 時間の上限（既定 120 秒。最初の 1 回は helper のコンパイルが入る）と標準出力の上限（既定 64 MiB）
 * - go が無い（ENOENT・go.mod の go 行より古い）ときは GoMissingError
 */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** helper のディレクトリ（src/ からも dist/ からも ../helper） */
export const HELPER_DIR = fileURLToPath(new URL('../helper/', import.meta.url));

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** go が無い（か、helper の go.mod の go 行より古い） */
export class GoMissingError extends Error {
  constructor(message: string) {
    super(message);
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
    env['GOCACHE'] = join(tmpdir(), 'stack-atlas-go-cache');
  return env;
}

const TOO_OLD = /go\.mod requires go >=|go: cannot find GOROOT|toolchain not available/;

/** helper を動かして標準出力（JSON の文字列）を返す。`-root` の相対パスは呼んだ側の cwd で解く（helper の cwd ではなく） */
export function runHelper(rawArgs: string[], opts: RunHelperOptions = {}): Promise<string> {
  const goBin = opts.goBin ?? 'go';
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = rawArgs.map((a, i) => (rawArgs[i - 1] === '-root' ? resolvePath(a) : a));
  return new Promise((resolve, reject) => {
    execFile(
      goBin,
      ['run', '.', ...args],
      {
        cwd: opts.helperDir ?? HELPER_DIR,
        env: helperEnv(opts.env),
        timeout,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (e.code === 'ENOENT') {
          reject(new GoMissingError(`go が見つかりません（${goBin}）`));
          return;
        }
        if (TOO_OLD.test(stderr)) {
          reject(new GoMissingError(`go が古いか使えません: ${stderr.trim().split('\n')[0]}`));
          return;
        }
        if (e.killed || e.signal) {
          reject(
            new Error(
              `go-types: helper が ${Math.round(timeout / 1000)} 秒の上限で止まりました（STACK_ATLAS_GO_TIMEOUT_MS で延ばせます）`,
            ),
          );
          return;
        }
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new Error('go-types: helper の出力が上限を超えました'));
          return;
        }
        const msg = stderr.trim().split('\n').slice(-5).join(' / ') || e.message;
        reject(new Error(`go-types: helper が失敗しました: ${msg}`));
      },
    );
  });
}
