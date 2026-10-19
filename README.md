# bbsync

掲示板クライアントの閲覧状態・お気に入り・ミュート設定・タブ・書き込み履歴を端末間で共有する Node.js モジュールです。
端末ごとの現在値を JSON に保存し、項目ごとに新しい更新を採用します。仕様は [同期プロトコル v3](docs/protocol.md) にまとめています。

## 使い方

```sh
npm install @romtenma/bbsync
```

```ts
import { BbsSync, LocalStateStore } from "@romtenma/bbsync";
import { HttpStateStore } from "@romtenma/bbsync/http";

const sync = new BbsSync({
  storage: new LocalStateStore("./bbsync-v3"),
  deviceId: "desktop-main", // 初回に生成して保存。端末ごとに別の値を使う
  syncLevel: 3, // 必須。このクライアントはレベル1〜3を扱う
  historyRetentionMs: 30 * 24 * 60 * 60 * 1_000, // 省略時も30日
});
const threadId = "egg.5ch.net/software/1234567890";

await sync.setThreadMetadata(threadId, "スレッドのタイトル",
  "https://egg.5ch.net/test/read.cgi/software/1234567890/");
await sync.recordThreadView(threadId, 125, 110); // 最後と最初の表示レス番号
await sync.recordResponseCount(threadId, 130);
await sync.setFavorite(threadId, 3);
await sync.setFilter("egg.5ch.net/software", "ID", "ABCDEFG", "OMIT");

const remote = new HttpStateStore({
  url: process.env.BBSYNC_URL!,
  token: process.env.BBSYNC_TOKEN!,
});
await sync.synchronizeWith(remote);
const threads = await sync.getStates();
const filters = await sync.getFilters();
const snapshot = await sync.getApplicationSnapshot();
// snapshot.entries の value: null だけが削除指示。キーの欠落は削除ではない。
```

同期結果の反映は設定レベルの範囲だけに行い、変更通知から同じ更新を再送しないようにしてください。

## 同期レベル

レベルは累積です。レベル外のデータは更新・削除・転送せず、保存済みの値もそのまま保持します。有効値は履歴期間でも絞り込みます。3.1 からレベル2以上の view/count/metadata の明示削除は期間で失効させず、古い値の再反映を防ぎます。

| レベル | 追加される同期対象 |
| --- | --- |
| 1 | お気に入りと、そのスレッドの閲覧状態 |
| 2 | お気に入り以外も含む最近の閲覧履歴と閲覧状態 |
| 3 | ID・ワードなどのミュート設定（フィルター） |
| 4 | 開いているタブ・タブグループ |
| 5 | 書き込み履歴（自分の書き込み位置） |

最近の履歴は `historyRetentionMs` で指定し、既定は直近30日です。お気に入りの閲覧状態は期間で制限しません。期間外の保存データを削除する設定ではありません。お気に入り自体の重要度 `favoriteLevel`（1〜5）とは別の設定です。

## API

| 操作 | メソッド |
| --- | --- |
| タイトル・URL | `setThreadMetadata(threadId, title, url)` |
| 閲覧位置 | `recordThreadView(threadId, position, firstPosition?)` |
| レス数 | `recordResponseCount(threadId, count)` |
| 閲覧位置・日時とレス数を削除 | `clearThreadHistory(threadId)` |
| お気に入りの設定・解除 | `setFavorite(threadId, level = 1)` / `clearFavorite(threadId)` |
| 自分の書き込み位置の記録・削除 | `recordPost(threadId, position)` / `clearPost(threadId, position)` |
| フィルターの設定・解除 | `setFilter(scope, targetType, target, effect, options?)` / `clearFilter(scope, targetType, target)` |
| タブ・グループの設定・取得・解除 | `setTabs({ tabs, groups })` / `getTabs()` / `clearTabs()` |
| 状態の取得 | `getStates()` / `getThreadState(threadId)` / `getFilters(scope?)` |
| 削除・更新元を含む反映用状態 | `getApplicationSnapshot()` → `{ evaluatedAt, policy, entries }` |
| 一括更新 | `update(changes)`。同じキーの重複はエラー、空配列は何もしない |
| 再試行可能な更新 | `updateWithJournal(changes, persistDocument)` / `commitPreparedUpdate(document)` |
| 双方向同期 | `synchronizeWith(store)`。コピーした文書数を `{ copiedToLeft, copiedToRight }` で返す |

更新メソッドは `Promise<void>` を返し、レベル外の項目は一括更新でも無視します。レベル1で閲覧状態を記録する際は、先にお気に入りを設定するか、一括更新に含めてください。

レベル3未満の `getFilters()` とレベル4未満の `getTabs()` は `undefined` を返します。レベル5未満ではスレッドの `postPositions` を省略します。これらの欠落をクライアント側の削除指示と解釈しないでください。

フィルターの `options` は `isRegex`（既定 `false`）、`updatedAt`（既定は現在時刻）、`hitAt`（任意）です。日時は更新の競合判定に使いません。

`getApplicationSnapshot()` は1回収集した文書群と1つの基準時刻から、範囲内の値と明示削除を返します。各項目に `key`・`value`・`revision`・`deviceId` があり、再起動後やコピー件数0の同期後にも取得できます。DB 更新とキーごとの反映済み番号を同じトランザクションで保存してください。全端末文書の同時点の原子的読み取りは保証しません。

更新の永続記録と再送抑止を含む実行可能な例は [アダプター接続ガイド](docs/adapter-guide.md)、初期化とサーバーの起動は [HTTP 保存構成](docs/http-store.md) にあります。既存同期先へ接続する際、過去のローカル値を `update()` で一律に送り直さないでください。

## 保存と拡張

ファイルは `<root>/devices/<deviceId>.json` です。同期対象の項目だけを転送し、保存先では項目ごとに統合します。省略されたキーは削除しません。同じ項目の更新は置き換えるためイベント履歴は増えません。削除情報は残し、自動削除や件数制限は設けません。

1つのディレクトリには1つの `LocalStateStore` インスタンスを使い、同じ `deviceId` の更新元も1つにします。端末IDには保存した UUID を推奨します。端末の複製やデータの作り直し時には新しいIDを生成してください。

端末間の共有先には `@romtenma/bbsync/http` の `HttpStateStore` と `startStateStoreServer()` を利用できます。サーバーが専用のローカル保存先を単独で所有し、独立したクライアントからの書き込みを直列化します。共有フォルダーやクラウドのファイル同期フォルダーへ `LocalStateStore` で直接接続する構成は保証しません。

独自ストレージは `StateStore` の3操作を実装します。同じ端末・キー・revision の異なる値は `DocumentConflictError`、不正なデータは `TypeError` または JSON パースエラーとして報告します。バージョンに対応した契約テストは npm パッケージに同梱しています。

```ts
import {
  registerStateStoreContractTests,
  registerSharedStateStoreContractTests,
} from "@romtenma/bbsync/testing";

// createFixture: { store, cleanup } を返す
registerStateStoreContractTests("MyStore", createFixture);
// createSharedFixture: 同じ保存先への独立した clients: [left, right] と cleanup を返す
registerSharedStateStoreContractTests("MySharedStore", createSharedFixture);
```

基本契約の合格だけでは複数利用者の安全性を保証しません。共有構成は独立したクライアント・プロセスでも検証してください。規模の測定方法は [ベンチマーク](docs/benchmark.md) を参照してください。

## v2 からの変更

v3 は旧プロトコル・保存データ・API と互換性がありません。新しい保存先を使い、必要な現在値だけをクライアントから取り込んでください。旧ディレクトリを指定するとエラーになり、旧データは変更しません。

- イベント・JSONL・セグメント・スナップショット・`compact()` を廃止しました。
- 全項目を論理カウンターによる最新更新優先に統一しました。閲覧位置とレス数は小さい値にも更新できます。
- `LocalEventStore` / `EventStore` は `LocalStateStore` / `StateStore` に置き換えました。一括更新は `append()` から `update()` に変更しました。
- `addFilter()` / `removeFilter()` の別名APIと、旧保持設定は廃止しました。

```sh
npm test
npm run test:package
```
