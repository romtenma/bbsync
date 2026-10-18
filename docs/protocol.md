# bbsync 同期プロトコル v3

端末ごとに「各項目の最後の更新」を保存する。同じ項目は `(revision, deviceId)` が大きい更新を採用する。削除も同じ規則で扱う。

## 識別子

- `deviceId`：端末・プロファイルごとに永続化する。一意な小文字 UUID を推奨。同じIDの書き込み元は1つに限定し、端末の複製や保存データの作り直しでは新しいIDを使う。
- `threadId`：`<host>/<board>/<thread>`。ホスト名は小文字化し末尾のドットを除く。サブドメインや別ホストを統合しない。`normalizeHostname()` を利用できる。
- `scope`：`<host>/<board>`。フィルターは板単位で扱う。

板・スレッドのキーはサイト上の識別子を使う。5ch は `test/read.cgi/` に続く板キーと数字のスレッドキー（先頭のゼロを除く）。板キー内の `/` は `.` に置き換える。これらの変換はクライアント側で行い、コアは `threadId` と `scope` を空でない文字列として扱う。

`deviceId` は `^[a-z0-9][a-z0-9_-]{0,63}$` に一致し、予約ファイル名 `con`, `prn`, `aux`, `nul`, `com0`〜`com9`, `lpt0`〜`lpt9` を除く。

## 文書と値

UTF-8 の JSON を `<root>/devices/<deviceId>.json` に保存する。

```json
{
  "v": 3,
  "deviceId": "desktop",
  "revision": 7,
  "entries": [
    { "key": ["favorite", "egg.5ch.net/software/123"], "value": 3, "revision": 5 },
    { "key": ["post", "egg.5ch.net/software/123", 126], "value": null, "revision": 7 }
  ]
}
```

`entries` は空でない配列で、同じキーを重複させない。文書の `revision` は各項目の `revision` の最大値とする。

| `key` | `value`（`null` なら削除） |
| --- | --- |
| `["metadata", threadId]` | `{ "title": string, "url": string }`。空でないタイトルと絶対URL |
| `["view", threadId]` | `{ "position": integer, "viewedAt": string, "firstPosition"?: integer }` |
| `["count", threadId]` | 観測したレス数。0以上の整数 |
| `["favorite", threadId]` | お気に入りレベル。1〜5の整数 |
| `["post", threadId, position]` | `true`。自分が投稿した、確定済みのレス番号 |
| `["filter", scope, targetType, target]` | `{ "effect": string, "isRegex": boolean, "updatedAt": string, "hitAt"?: string }` |

位置はフィルター後の表示順ではなくサイト上のレス番号。`view.position` は0以上、`firstPosition` は0以上かつ `position` 以下、`post` の位置は1以上。整数はすべて安全な範囲（最大 `2^53 - 1`）、revision は1以上。日時は実在するUTC日時 `YYYY-MM-DDTHH:mm:ss.sssZ` に統一する。

キー内の文字列と `effect` は空にしない。`targetType` と `effect` はクライアントが定義する。例：`ID` / `SLIP` / `WORD`、`OMIT` / `NOP` / `HIGHLIGHT`。正規表現の解釈はクライアントが担当する。未対応のフィルターは適用を省略できるが、保存値は変更しない。

省略できるのは `firstPosition` と `hitAt` だけ。項目全体の `value: null` が削除を意味し、キーの省略は削除を意味しない。未対応のバージョン・キー種別・余分なフィールド・不正値はエラーとする。JSONオブジェクトのフィールド順と `entries` の列挙順には意味を持たせない。キー配列内の要素順は保持する。

## 更新と統合

1. 保存先にある全端末の文書を読む。
2. 文書の `revision` の最大値に1を加え、今回の更新番号にする。文書がなければ1。安全な整数を超えたら更新を拒否する。
3. 自端末の文書の対象キーだけを置き換え、項目と文書に今回の番号を付けて保存する。他のキーの値と番号は変えない。一括更新は同じ番号で保存する。

状態の取得では、各キーについて全端末の項目を `(項目の revision, 文書の deviceId)` で比較し、最大のものを選ぶ。端末IDはASCIIコード順で比較する。文書全体の revision を個々の項目の比較に使わない。

勝った値が `null` なら非表示。後から明示的に更新すれば再表示できる。削除情報を含むキーと端末文書は物理削除しない。これにより観測済みの古い値が再同期だけで復活するのを防ぐ。

例：Aの設定が revision 5 なら、それを同期したBの解除は6以上となり、Aの古い設定より優先される。未同期の操作どうしはカウンター、同値なら端末IDで決まり、実時間順とは限らない。`viewedAt`、`updatedAt`、`hitAt` は表示用であり、競合判定に使わない。

タイトルとURL、閲覧位置・表示範囲・閲覧日時、フィルターの値はそれぞれ一組で置き換える。閲覧位置とレス数も最新更新を採用し、最大値の保持は行わない。`firstPosition` のない更新で以前の値を引き継がない。

## 公開状態とクライアントの接続

`getStates()` は有効な項目が1つでもあるスレッドを返す。`metadata` は `title` / `url`、`view` は `lastReadPosition` / `firstReadPosition` / `lastViewedAt`、`count` は `responseCount`、`favorite` は `favoriteLevel` に対応する。`postPositions` は有効な書き込み位置の重複なし昇順配列とする。`getFilters()` は有効なフィルターだけを返す。

`clearThreadHistory()` は `view` と `count` を一括で `null` にする。タイトル・URL・お気に入り・書き込み位置は保持するため、メタデータだけのスレッドも一覧に残る。全項目が削除済みなら一覧に含めない。

クライアントはローカル操作を更新として保存し、同期後に取得した状態との差分を反映する。反映中は変更通知の再送を抑止する。初回取り込みは一度だけ行い、再起動ごとに同じ値を書き直さない。日時を指定して取り込む場合は `update()` を使う。API の一覧は [README](../README.md#api) を参照。

## ストレージと同期

`StateStore` は次の3操作を提供する。

| 操作 | 契約 |
| --- | --- |
| `listDocuments()` | 保存済み端末IDを重複なく列挙する |
| `readDocument(deviceId)` | 検証済みの文書、または未存在を返す。文書内IDと保存先IDは一致させる |
| `writeDocument(document)` | 検証後、比較と置き換えを直列化し、文書を一括で保存する |

書き込みは、古い revision なら何もせず、同じ revision なら同内容だけを受理する。新しい文書は過去の全キーを含み、値や番号を変えた項目・追加項目の revision は保存済み文書の revision より大きくなければならない。違反は分岐エラーにする。同内容判定ではJSONオブジェクトのフィールド順と項目の列挙順を無視する。

同期は両側の文書を読み、端末ごとに新しい文書を反対側へコピーする。同 revision の異内容や不正な後継文書はエラー。同じ状態の再同期はコピー件数0となる。転送中の書き込み失敗は再実行できる。同期全体はトランザクションではないため、同時更新は次回同期で反映される場合がある。

ローカル保存は同じディレクトリの一時ファイルからrenameで置き換える。クラウド実装では条件付き書き込みを使う。同じ保存先への書き込みを複数プロセスから行わない。

独自ストレージは [共通契約テスト](../src/state-store.contract.ts) を利用できる。他言語の実装も、同時更新・削除と再追加・順不同の統合・繰り返し同期・文書の分岐を検証する。v2 との互換処理や自動移行は提供せず、新しい保存先から利用する。
