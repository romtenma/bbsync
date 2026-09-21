# bbsync

掲示板クライアント間で、スレッドのタイトル、遷移先URL、閲覧位置、レス数、お気に入りレベル、書き込み位置を共有するためのNode.jsモジュールです。クライアント固有のデータ変換は各クライアント側のアダプターが担当し、このパッケージはJSONLの読み書き、状態の統合、ストレージ間同期を担当します。

現在はローカルファイルストレージを実装しています。将来のGoogle Driveストレージも同じ`EventStore`インターフェースで追加できます。

専用ブラウザのアダプターを実装する場合は、識別子の正規化、イベントの発火条件、同期状態の反映方法を定めた[アダプターイベント仕様 v2](docs/adapter-event-protocol-v2.md)を参照してください。

## インストール

```sh
npm install @romtenma/bbsync
```

## 基本例

```ts
import { BbsSync, LocalEventStore } from "@romtenma/bbsync";

const local = new LocalEventStore("./bbsync-data", {
  maxEventsPerSegment: 1_000,
  retainSegmentsPerDevice: 1,
});
const sync = new BbsSync({
  storage: local,
  deviceId: "desktop-main",
});

await sync.recordThreadView("@5ch/software/1234567890", 125);
await sync.setThreadMetadata(
  "@5ch/software/1234567890",
  "ソフトウェア板のスレッド",
  "https://egg.5ch.net/test/read.cgi/software/1234567890/",
);
await sync.recordResponseCount("@5ch/software/1234567890", 130);
await sync.setFavorite("@5ch/software/1234567890", 3);
await sync.clearFavorite("@5ch/software/1234567890");
await sync.recordPost("@5ch/software/1234567890", 126);

// フィルターは対象種別・対象文字列・表示効果を分けて同期する
await sync.setFilter("@5ch/software", "ID", "ABCDEFG", "OMIT");
await sync.setFilter("@5ch/software", "SLIP", "xxxx-yyyy", "NOP", {
  hitAt: "2026-09-20T01:22:00.000Z",
});
await sync.setFilter("@5ch/software", "WORD", "NGワード", "HIGHLIGHT");
const filters = await sync.getFilters("@5ch/software");
await sync.clearFilter("@5ch/software", "ID", "ABCDEFG");

const state = await sync.getThreadState("@5ch/software/1234567890");

// 現在状態をスナップショット化し、古い自端末セグメントを整理する
await sync.compact();
```

`threadId`はこのモジュールにとって不透明な文字列です。タイトルやURLはキーに使いません。URLやクライアント内部のキーをどのように正規化して`threadId`にするかはアダプター側で決定します。

shitaraba のように板キーに`/`を含むサイトでは、`/`を`.`に置換した値を板キーとして扱います。ただし、この変換は bbsync 本体では行わず、アダプター側で正規化してください。

サイトキーをURLから作る場合は、`normalizeSiteKey()`を使用できます。規定サイトは`@5ch`、`@bbspink`、`@open2ch`、`@machi`、`@shitaraba`、`@2chan`へ正規化され、サブドメインも同じキーになります。未知サイトは正規化したホスト名（サブドメインを含む）になります。

```ts
import { normalizeSiteKey } from "@romtenma/bbsync";

normalizeSiteKey("https://egg.5ch.net/test/read.cgi/software/123/");
// "@5ch"
normalizeSiteKey("https://may.2chan.net/b/");
// "@2chan"
normalizeSiteKey("https://sub.testtest.net/board/");
// "sub.testtest.net"
```

フィルターは、`scope`、`targetType`、`target`の組で対象を識別し、`effect`で一致時の表示効果を指定します。`targetType`と`effect`の値は専用ブラウザが定義します。推奨値の例は、`targetType`が`ID`、`SLIP`、`SLIP-PRE`、`SLIP-SUF`、`MAIL`、`NAME`、`TRIP`、`WORD`、`effect`が`OMIT`、`NOP`、`HIGHLIGHT`です。`scope`には`@5ch/software`のようなサイト・板キーを指定します。

フィルター情報には必須の`updatedAt`と、条件がスレッド内に現れた日時を表す任意の`hitAt`があります。`updatedAt`を省略した場合はローカル時計から自動設定されます。解除も同期され、古いオフライン端末の更新によって復活しないように扱われます。

## 同期

```ts
const remote = new LocalEventStore("./another-device-data");
const result = await sync.synchronizeWith(remote);
```

同期は、不足しているJSONLセグメントと端末別スナップショットを双方向にコピーします。書き込み中のセグメントが前回の同期後に伸びている場合は、既存内容が完全な接頭辞であることを検証して長い方へ更新します。同じ同期を繰り返しても新しいコピーは作られません。スナップショットが存在する端末の古いセグメントは、各ストレージの`retainSegmentsPerDevice`設定に従って整理されます。

## 保存形式

```text
bbsync-data/
  devices/
    desktop-main/
      snapshot.json
      events/
        <segment-id>.jsonl  # 既定で最大1,000イベント
```

各行はバージョン付きイベントです。

```json
{"v":2,"id":"...","deviceId":"desktop-main","occurredAt":"2026-09-20T01:23:40.000Z","threadId":"@5ch/software/1234567890","type":"thread.metadata.updated","title":"ソフトウェア板のスレッド","url":"https://egg.5ch.net/test/read.cgi/software/1234567890/"}
{"v":2,"id":"...","deviceId":"desktop-main","occurredAt":"2026-09-20T01:23:45.000Z","threadId":"@5ch/software/1234567890","type":"thread.viewed","position":125}
{"v":2,"id":"...","deviceId":"desktop-main","occurredAt":"2026-09-20T01:24:00.000Z","type":"filter.set","scope":"@5ch/software","targetType":"ID","target":"ABCDEFG","effect":"OMIT","updatedAt":"2026-09-20T01:24:00.000Z","hitAt":"2026-09-20T01:23:59.000Z"}
```

## 統合規則

- 閲覧位置: 最大の位置を採用
- タイトル・URL: 一組として扱い、`occurredAt`が新しい更新を採用。同時刻の場合は端末IDとイベントIDで決定
- 閲覧日時: `thread.viewed`の`occurredAt`が新しい日時を採用
- レス数: 端末間で観測した最大値を採用
- お気に入り: 1〜5のレベルで管理。省略時はレベル1。`occurredAt`が新しい操作を採用し、同時刻の場合は端末IDとイベントIDで決定
- 書き込み位置: 全端末の位置を重複なしで統合。スナップショット作成時（`compact()`）に全スレッドをまたいで最新1,000件（既定）を保持
- イベント: イベントIDで重複排除。同じIDで内容が異なる場合はエラー
- セグメント: `maxEventsPerSegment`件で次のファイルへローテーション
- フィルター: `scope`、`targetType`、`target`の組をキーに、`updatedAt`が新しい状態を採用。`effect`は対象の表示効果
- スナップショット: 現在状態、お気に入り、フィルターの最終更新情報を端末別に保存。お気に入りや書き込みがなく、最終閲覧・更新から30日経過したスレッドはスナップショットから自動的に除外

`clearFavorite()`はお気に入り解除を記録します。解除後に古い端末のレベル設定が復活しないよう、解除も最終更新情報としてスナップショットへ保存されます。
`clearFilter()`も同様に解除情報を保存します。

セグメントは追記方向にだけ更新できます。同じセグメントの両側が異なる内容へ分岐した場合は、データを暗黙に選ばず同期エラーにします。1つの`deviceId`に対する書き込み元は常に1端末に限定してください。

`compact()`は自動では実行されません。利用側クライアントで同期の区切りなどに呼び出してください。スナップショット作成時に `maxGlobalPostPositions`（既定1,000件）および `retentionPeriodMs`（既定30日）による保持ポリシーが適用され、古いセグメントも整理されます。スナップショット作成後も、既定では最新セグメントを1つ保持します。お気に入りの競合解決は端末時計に依存します。Google Drive対応前に、時計ずれへの対策が必要かを検討します。

## EventStore契約テスト

ストレージ実装を追加する場合は、`src/event-store.contract.ts`の`registerEventStoreContractTests`へ実装用fixtureを渡すことで、ローカル実装と同じ契約テストを実行できます。Google Drive版では、ファイル一覧、取得、作成・更新、スナップショット、整理処理がこの契約を満たす必要があります。
