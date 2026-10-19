# Changelog

## 3.1.0

- 削除・revision・deviceId を含む `getApplicationSnapshot()` を追加。
- レベル2以上の view/count/metadata の明示削除は履歴期間で失効させず、反映・転送する。有効値の期間制限とレベル外データの保持は継続。
- `updateWithJournal()` と `commitPreparedUpdate()` による同じ revision の再試行を追加。
- `@romtenma/bbsync/http` に単一書き込みサーバー、HTTP StateStore、永続的な初期化セッションを追加。
- `@romtenma/bbsync/testing` に基本契約と独立クライアントの共有契約を同梱。
- トランザクション・未送信操作・反映済み番号を扱う接続例、アダプター規約、配布物の外部導入試験、ベンチマークを追加。

文書形式は v3 のまま。3.0 を含む同期経路では、期間外の削除だけが残るケースに従来の転送制限がある。
