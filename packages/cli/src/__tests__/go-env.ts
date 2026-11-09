// go（go-types の helper）が使えるか（docs/17 D51）。無ければ Go の側（関数の箱・サーバー側と table の合流）を確かめる
// テストを飛ばす。STACK_ATLAS_REQUIRE_GO=1（CI）なら go が無いことを失敗にする（黙って飛ばさない）
import { execFileSync } from 'node:child_process';

export const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    if (process.env['STACK_ATLAS_REQUIRE_GO'] === '1')
      throw new Error('go が見つかりません（STACK_ATLAS_REQUIRE_GO=1）');
    return false;
  }
})();

/** go-types の関数の箱（fixture-poly の platform。v1 のパッケージの箱を group にする） */
export const POLY_GO_FNS = [
  'fn:cmd/api.main',
  'fn:cmd/gmail-webhook.main',
  'fn:cmd/notify.main',
  'fn:internal/api.handleDays',
  'fn:internal/api.handleEntries',
  'fn:internal/api.handleSubscribe',
  'fn:internal/api.handleUnsubscribe',
  'fn:internal/api.NewServer',
  'fn:internal/api.Handler',
  'fn:internal/api.handleToday',
  'fn:internal/api.handleCreateTransaction',
  'fn:internal/api.handleDeleteTransaction',
  'fn:internal/auth.NewVerifier',
  'fn:internal/auth.Middleware',
  'fn:internal/domain.ToTransaction',
  'fn:internal/domain.Sum',
  'fn:internal/inbound.NewHandler',
  'fn:internal/inbound.ServeHTTP',
  'fn:internal/parser.New',
  'fn:internal/parser.Parse',
  'fn:internal/push.Send',
  'fn:internal/store.New',
  'fn:internal/store.ListByDate',
  'fn:internal/store.ListRecent',
  'fn:internal/store.DailyTotals',
  'fn:internal/store.InsertTransaction',
  'fn:internal/store.DeleteTransaction',
  'fn:internal/store.SaveSubscription',
  'fn:internal/store.ListSubscriptions',
  'fn:internal/store.RemoveSubscription',
];

/** go-types の関数の箱が置き換える v1 のパッケージの箱（group。internal/domain は classify で type なので types[] にある） */
export const POLY_GO_GROUPS = [
  'handler:cmd/api',
  'handler:cmd/gmail-webhook',
  'handler:cmd/notify',
  'handler:internal/api',
  'lib:internal/auth',
  'lib:internal/inbound',
  'lib:internal/parser',
  'lib:internal/push',
  'schema:internal/store',
];
