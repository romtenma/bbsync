# bbsync

掲示板クライアント間で、スレッドの閲覧位置、レス数、お気に入りレベル、書き込み位置を共有するためのNode.jsモジュールです。Siki固有のデータ変換はSiki側のアダプターが担当し、このパッケージはJSONLの読み書き、状態の統合、ストレージ間同期を担当します。

現在はローカルファイルストレージを実装しています。将来のGoogle Driveストレージも同じ`EventStore`インターフェースで追加できます。

## 基本例

```ts
import { BbsSync, LocalEventStore } from "bbsync";

const local = new LocalEventStore("./bbsync-data", {
  maxEventsPerSegment: 1_000,
  retainSegmentsPerDevice: 1,
});
const sync = new BbsSync({
  storage: local,
  deviceId: "desktop-main",
});

await sync.recordThreadView("5ch/software/1234567890", 125);
await sync.recordResponseCount("5ch/software/1234567890", 130);
await sync.setFavorite("5ch/software/1234567890", 3);
await sync.clearFavorite("5ch/software/1234567890");
await sync.recordPost("5ch/software/1234567890", 126);

// ミュート値はbbsyncでは解釈せず、scopeとともに同期する
await sync.setMute("5ch/software", "ID:ABCDEFG");
await sync.setMute("5ch/software", "BBSSLIP:xxxx-yyyy", {
  hitAt: "2026-09-20T01:22:00.000Z",
});
await sync.setMute("5ch/software", "TEXT:NGワード");
const mutes = await sync.getMutes("5ch/software");
await sync.clearMute("5ch/software", "ID:ABCDEFG");

const state = await sync.getThreadState("5ch/software/1234567890");

// 現在状態をスナップショット化し、古い自端末セグメントを整理する
await sync.compact();
```

`threadId`はこのモジュールにとって不透明な文字列です。URLやSiki内部のキーをどのように正規化するかはアダプター側で決定します。

ミュートも同様に、`scope`と`value`を不透明な文字列として保存します。`scope`には`5ch/software`のようなサイト・板キーを指定します。`value`の`ID:`、`BBSSLIP:`、`TEXT:`などの形式や、端末ごとにどの種類を適用するかはクライアント側で決定し、bbsyncは解釈しません。

ミュート情報には必須の`updatedAt`と、条件がスレッド内に現れた日時を表す任意の`hitAt`があります。`updatedAt`を省略した場合はローカル時計から自動設定されます。解除も同期され、古いオフライン端末の更新によって復活しないように扱われます。

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
{"v":1,"id":"...","deviceId":"desktop-main","occurredAt":"2026-09-20T01:23:45.000Z","threadId":"5ch/software/1234567890","type":"thread.viewed","position":125}
{"v":1,"id":"...","deviceId":"desktop-main","occurredAt":"2026-09-20T01:24:00.000Z","type":"mute.set","scope":"5ch/software","value":"ID:ABCDEFG","updatedAt":"2026-09-20T01:24:00.000Z","hitAt":"2026-09-20T01:23:59.000Z"}
```

## 統合規則

- 閲覧位置: 最大の位置を採用
- 閲覧日時: `thread.viewed`の`occurredAt`が新しい日時を採用
- レス数: 端末間で観測した最大値を採用
- お気に入り: 1〜5のレベルで管理。省略時はレベル1。`occurredAt`が新しい操作を採用し、同時刻の場合は端末IDとイベントIDで決定
- 書き込み位置: 全端末の位置を重複なしで統合
- イベント: イベントIDで重複排除。同じIDで内容が異なる場合はエラー
- セグメント: `maxEventsPerSegment`件で次のファイルへローテーション
- ミュート: `scope`と`value`の組をキーに、`updatedAt`が新しい状態を採用
- スナップショット: 現在状態、お気に入り、ミュートの最終更新情報を端末別に保存

`clearFavorite()`はお気に入り解除を記録します。解除後に古い端末のレベル設定が復活しないよう、解除も最終更新情報としてスナップショットへ保存されます。
`clearMute()`も同様に解除情報を保存します。

セグメントは追記方向にだけ更新できます。同じセグメントの両側が異なる内容へ分岐した場合は、データを暗黙に選ばず同期エラーにします。1つの`deviceId`に対する書き込み元は常に1端末に限定してください。

`compact()`は自動では実行されません。Siki側で同期の区切りなどに呼び出してください。スナップショット作成後も、既定では最新セグメントを1つ保持します。お気に入りの競合解決は端末時計に依存します。Google Drive対応前に、時計ずれへの対策が必要かを検討します。

## EventStore契約テスト

ストレージ実装を追加する場合は、`src/event-store.contract.ts`の`registerEventStoreContractTests`へ実装用fixtureを渡すことで、ローカル実装と同じ契約テストを実行できます。Google Drive版では、ファイル一覧、取得、作成・更新、スナップショット、整理処理がこの契約を満たす必要があります。
