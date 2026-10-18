# bbsync

掲示板クライアントの閲覧状態・お気に入り・書き込み位置・フィルターを端末間で共有する Node.js モジュールです。
端末ごとの現在値を JSON に保存し、項目ごとに新しい更新を採用します。仕様は [同期プロトコル v3](docs/protocol.md) にまとめています。

## 使い方

```sh
npm install @romtenma/bbsync
```

```ts
import { BbsSync, LocalStateStore } from "@romtenma/bbsync";

const sync = new BbsSync({
  storage: new LocalStateStore("./bbsync-v3"),
  deviceId: "desktop-main", // 初回に生成して保存。端末ごとに別の値を使う
});
const threadId = "egg.5ch.net/software/1234567890";

await sync.setThreadMetadata(threadId, "スレッドのタイトル",
  "https://egg.5ch.net/test/read.cgi/software/1234567890/");
await sync.recordThreadView(threadId, 125, 110); // 最後と最初の表示レス番号
await sync.recordResponseCount(threadId, 130);
await sync.setFavorite(threadId, 3);
await sync.recordPost(threadId, 126);
await sync.setFilter("egg.5ch.net/software", "ID", "ABCDEFG", "OMIT");

await sync.synchronizeWith(new LocalStateStore("./shared-bbsync-v3"));
const threads = await sync.getStates();
const filters = await sync.getFilters();
```

同期結果をクライアントへ反映する間は、変更通知から同じ更新を再送しないようにしてください。

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
| 状態の取得 | `getStates()` / `getThreadState(threadId)` / `getFilters(scope?)` |
| 一括更新 | `update(changes)`。同じキーの重複はエラー、空配列は何もしない |
| 双方向同期 | `synchronizeWith(store)`。コピーした文書数を `{ copiedToLeft, copiedToRight }` で返す |

更新メソッドは `Promise<void>` を返します。フィルターの `options` は `isRegex`（既定 `false`）、`updatedAt`（既定は現在時刻）、`hitAt`（任意）です。日時は表示用で、更新の競合判定には使いません。

## 保存と拡張

ファイルは `<root>/devices/<deviceId>.json` です。同じ項目の更新は置き換えるためイベント履歴は増えません。削除情報は残し、自動期限切れや件数制限は設けません。容量と転送量は端末数と、一度でも記録したキーの数に応じて増えます。

1つのディレクトリには1つの `LocalStateStore` インスタンスを使い、同じ `deviceId` の更新元も1つにします。端末IDには保存した UUID を推奨します。端末の複製やデータの作り直し時には新しいIDを生成してください。

独自ストレージは `StateStore` の3操作を実装します。共通契約テストは [src/state-store.contract.ts](src/state-store.contract.ts) にあります。ファイルの分岐・過去のキーの欠落は `DocumentConflictError`、不正なデータは `TypeError` または JSON パースエラーとして報告します。

## v2 からの変更

v3 は旧プロトコル・保存データ・API と互換性がありません。新しい保存先を使い、必要な現在値だけをクライアントから取り込んでください。旧ディレクトリを指定するとエラーになり、旧データは変更しません。

- イベント・JSONL・セグメント・スナップショット・`compact()` を廃止しました。
- 全項目を論理カウンターによる最新更新優先に統一しました。閲覧位置とレス数は小さい値にも更新できます。
- `LocalEventStore` / `EventStore` は `LocalStateStore` / `StateStore` に置き換えました。一括更新は `append()` から `update()` に変更しました。
- `addFilter()` / `removeFilter()` の別名APIと、旧保持設定は廃止しました。

```sh
npm test
```
