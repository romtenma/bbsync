# 複数端末から使う HTTP 保存構成

各端末に独立した `LocalStateStore` と deviceId を持たせ、`synchronizeWith(new HttpStateStore(...))` で1つのサーバーへ接続する。サーバーは専用ディレクトリを単独所有し、文書の読み取り・統合・保存を直列化する。

## 起動

ビルド済みパッケージの `examples/server.mjs` を実行するか、公開 API を使う。

```ts
import { startStateStoreServer } from "@romtenma/bbsync/http";

const server = await startStateStoreServer({
  rootDirectory: "./server-data/user-1",
  token: process.env.BBSYNC_TOKEN!,
  host: "127.0.0.1",
  port: 8787,
});
// 終了時に await server.close()
```

リポジトリでの PowerShell の起動例：

```powershell
npm run build
$env:BBSYNC_TOKEN = [guid]::NewGuid().ToString('N')
node examples/server.mjs ./server-data/user-1
```

同じトークンを接続する端末へ設定する。利用者・同期領域ごとに別の root/token/サーバーを用意する。サーバーは既定でループバックへバインドする。端末間で利用するときは、HTTPS のリバースプロキシからこのポートへ転送する。例えば公開 URL に `/user-1` を付ける場合、プロキシがこのプレフィックスを除いて `/documents` 等へ転送する。Bearer トークンを HTTP のまま外部ネットワークへ流さない構成にする。

```ts
import { HttpStateStore } from "@romtenma/bbsync/http";
const remote = new HttpStateStore({
  url: "https://sync.example.net/user-1",
  token: process.env.BBSYNC_TOKEN!,
  timeoutMs: 30_000,
});
await sync.synchronizeWith(remote);
```

保存先の同時所有は `.bbsync-server.lock` の排他的作成で拒否する。正常終了時に解放する。異常終了で残った場合は、該当ディレクトリを使うプロセスがすべて停止していることと、ファイル内の hostname/pid を運用者が確認してから、このロックファイルだけを削除して起動する。経過時間だけで自動的にロックを奪わない。サーバー外から同じ保存先へ書き込まない。

## 初回取り込み

`getInitialization()` の状態は `empty`・`existing`・`active`・`complete`・`aborted`。通常の同期を先に行って文書が保存された領域も `existing` となり、初期化を開始できない。

1. 端末の DB にセッションIDと取り込む現在値を永続化する。
2. `beginInitialization(sessionId, deviceId)` を呼ぶ。空の領域で1つのセッションだけが取得できる。同じ引数で再開できる。
3. 準備済み文書を DB に記録してから、ローカルストアへ保存する。
4. `sync.synchronizeWith(remote.withInitialization(sessionId))` で転送する。
5. `finishInitialization(sessionId)` が成功したら、端末DBにも完了を保存する。

active の間、通常クライアントの文書の読み書きは InitializationError になる。所有セッションは所有 deviceId の文書だけを書ける。セッションは自動失効しない。

完了応答を失った場合は、同じ引数で begin を再実行すると complete が返る。古い値を取り込み直さず端末DBの完了処理へ進む。完了後のセッション付き書き込みは拒否する。

所有端末が回復不能な場合、運用者は `abortInitialization(sessionId)` で明示的に閉じる。途中の文書は保持し、通常の同期を再開できる状態にする。元の取り込みを勝手に再開・初期化し直さず、部分データを確認する。初期化メタデータは devices の外に保存し、他の端末へ文書として転送しない。

## 通信と保証

| 操作 | HTTP |
| --- | --- |
| 端末一覧 | GET `/documents` |
| 文書の取得・統合保存 | GET/PUT `/documents/:deviceId` |
| 初期化の確認 | GET `/initialization` |
| 初期化の開始・完了・中断 | POST `/initialization/begin`・`finish`・`abort` |

全操作に `Authorization: Bearer <token>`、所有セッションの文書操作には `X-Bbsync-Session` を付ける。セッションIDは1〜128文字のASCII英数字・`_`・`-`とし、保存したUUIDを推奨する。PUT は部分文書を受け取り、統合保存してから成功応答する。既定の最大リクエストは16MiBで、サーバーオプションで変更できる。

- 独立した端末・プロセスの異なるキーは保持する。同一キーの異なる端末は通常の `(revision, deviceId)` で収束する。同じ deviceId の更新元を複数作らない。
- 応答消失・部分転送後は同じ文書で再試行できる。多文書にまたがる同期全体は原子的ではない。
- `DocumentConflictError` は同一端末・キー・revision の分岐。`InitializationError` はセッションの競合。認証等は `HttpStateStoreError.status`、通信障害・タイムアウトは fetch のエラーとして返す。
- 保証対象はサーバーのローカルディスク。共有ファイルシステムやクラウド同期フォルダーへ保存先を置く構成の端末間排他は保証しない。
- プロセス停止後の再開を検証する。LocalStateStore は rename による置換を使うが、停電・ディスク障害後に直前の成功応答の内容が必ず永続化される保証は提供しない。バックアップはサーバー停止中にディレクトリ全体を取得する。
