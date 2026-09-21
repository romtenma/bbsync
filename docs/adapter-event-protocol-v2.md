# bbsync 専用ブラウザ・アダプターイベント仕様 v2

- 状態: Current
- 仕様バージョン: `2`
- 対象: 掲示板専用ブラウザと bbsync を接続するアダプター

## 1. 目的

本仕様は、異なる専用ブラウザがスレッドのタイトル、遷移先URL、閲覧状態、レス数、お気に入り、書き込み位置、フィルターを同じ意味で交換し、同じ入力から同じ状態へ収束するための共通イベントプロトコルを定義する。

アダプターは、ブラウザ固有のデータを本仕様の識別子とイベントへ変換し、同期後の射影状態をブラウザ固有のデータへ反映する。bbsync コアはイベントの永続化、重複排除、統合、ストレージ間コピーを担当する。

```text
ブラウザ A ─ アダプター A ─┐
                            ├─ bbsync イベント／共有ストレージ
ブラウザ B ─ アダプター B ─┘
```

本仕様で「MUST」「MUST NOT」「SHOULD」「SHOULD NOT」「MAY」は、それぞれ必須、禁止、推奨、非推奨、任意を表す。

## 2. 適用範囲

v2 が同期する状態は次のとおりである。

| 状態 | イベント | 統合方式 |
| --- | --- | --- |
| スレッドタイトル・遷移先URL | `thread.metadata.updated` | `(occurredAt, deviceId, id)`の最新 |
| 最終既読位置・最終閲覧日時 | `thread.viewed` | 位置は最大値、日時は最新イベント |
| 閲覧履歴の削除マーカー | `thread.history.cleared` | `(occurredAt, deviceId, id)`の最新。これより前の閲覧状態を無効化 |
| 観測済みレス数 | `thread.response-count.observed` | 最大値 |
| お気に入りとレベル | `thread.favorite.set` / `thread.favorite.cleared` | 最終更新優先 |
| 自分の書き込み位置 | `thread.post.recorded` / `thread.post.cleared` | 位置ごとの最終更新優先。削除はトゥームストーンとして保持 |
| フィルター | `filter.set` / `filter.cleared` | 最終更新優先 |

スレッド本文、画像、Cookie、認証情報、板一覧、UI 設定は v2 の対象外である。

## 3. 用語

- **アダプター**: 専用ブラウザ固有のモデルと bbsync のモデルを相互変換する実装。
- **端末**: 1つのブラウザープロファイルまたはアプリケーションインストール。1つの永続的な `deviceId` を持つ。
- **イベント**: 端末で起きた状態変更を表す、不変な JSON オブジェクト。
- **射影状態**: すべてのイベントとスナップショットを統合して得られる現在状態。
- **サーバーキー**: URL のホスト名を正規化した値。スレッドとフィルターの識別子にそのまま使用する。
- **ローカル操作**: 利用者またはブラウザ自身が発生させた変更。
- **同期反映**: bbsync から取得した射影状態をブラウザへ適用する変更。

## 4. アダプターの処理モデル

アダプターは次の順序で動作しなければならない。

1. ローカル操作を検出する。
2. 識別子と値を正規化する。
3. 対応するイベントを bbsync へ追加する。
4. 任意のタイミングで共有ストレージと同期する。
5. bbsync から射影状態を取得する。
6. 前回適用済みの状態との差分をブラウザへ反映する。

同期反映中にブラウザから届く変更通知を、アダプターはローカル操作として再送信してはならない（MUST NOT）。再送信するとお気に入りなどの最終更新優先フィールドでイベントループや意図しない上書きが発生する。

アダプターは、同期反映中フラグ、更新元トークン、または適用前後の値の比較によって再発火を抑止しなければならない（MUST）。同じ射影状態を複数回適用しても結果が変わらない実装にすべきである（SHOULD）。

## 5. 共通識別子

### 5.1 `deviceId`

`deviceId` は端末ごとに生成して永続化する。同じ利用者の複数端末でも共有してはならない（MUST NOT）。1つの `deviceId` に対するイベント書き込み元は常に1つでなければならない（MUST）。プロファイルを複製した場合は、複製先で新しい ID を生成する。

形式は次の正規表現に一致しなければならない。

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
```

UUID、またはアプリ名とUUIDを組み合わせた値を推奨する。表示名、ユーザー名、端末名などの個人情報を直接含めるべきではない。

例: `siki-550e8400-e29b-41d4-a716-446655440000`

### 5.2 `id`

`id` はイベントを全端末・全期間で一意に識別する。同じ正規表現を使用し、UUID を推奨する。一度保存したイベントの `id` と内容は変更してはならない（MUST NOT）。

同じ `id` のイベントは重複として1件にまとめられる。同じ `id` で内容が異なるイベントはデータ破損として扱われ、同期または状態構築は失敗する。

通常、アダプターは `id` を指定せず bbsync コアに生成させる。

### 5.3 `threadId`

異なるアダプターが同じスレッドに同じ `threadId` を生成することは、相互運用の必須条件である。

```text
<server-key>/<board-key>/<thread-key>
```

- `server-key` は URL のホスト名を小文字化し、末尾のドットを除去した値をそのまま使用する。サイト別の固定キーやエイリアスは定義しない。
- `board-key` と `thread-key` は表示名ではなく、サイト上で永続的な識別子を使用する。
- URL のスキーム、ポート、パス、クエリ、フラグメントはキーに含めない。
- 大文字小文字、末尾ドットの扱いは共通のホスト名正規化規則に従う。サブドメイン、旧ドメイン、ミラーはそれぞれ別の `server-key` とする。

5ch の `board-key` と `thread-key` は次の規則で生成する。

| 要素 | 規則 |
| --- | --- |
| `board-key` | `test/read.cgi/` の直後にある板キーをそのまま使用 |
| `thread-key` | その次にある数字のスレッドキー。先頭のゼロは除去 |
| サーバー名 | URL のホスト名を正規化して `server-key` として使用 |

shitaraba のように `board-key` に `/` を含むサイトでは、`/` を `.` に置換した値を `board-key` として扱う。これはアダプター側で正規化する前提であり、bbsync 本体はこの変換を行わない。

例:

```text
https://egg.5ch.net/test/read.cgi/software/1750000000/
→ egg.5ch.net/software/1750000000
```

URL 以外の内部データから生成する場合も同じ結果にならなければならない。復元時は `server-key` をそのままサーバー名として使用できる。

ホスト名は小文字化し、末尾のドットを除去する。例えば `https://sub.testtest.net/board/` は `sub.testtest.net` を `server-key` とする。`not5ch.net` のようなホスト名も、入力された文字列のとおり別のサーバーキーとして扱う。

### 5.4 `scope`

`scope` はフィルターが属する範囲を表す。v2 では板単位とし、対応する `threadId` からスレッド部分を除いた次の形式を使用する。

```text
<server-key>/<board-key>
```

例: `egg.5ch.net/software`

`scope`、`targetType`、`target` の組が1つのフィルター項目のキーになる。すべて空文字列は禁止する。

## 6. 共通イベント形式

永続化されるイベントは UTF-8 の JSON オブジェクトである。JSONL では1行に1イベントを格納する。数値は JSON number、時刻は文字列で表現する。

すべてのイベントは次のフィールドを持つ。

| フィールド | 型 | 必須 | 意味 |
| --- | --- | --- | --- |
| `v` | integer | Yes | スキーマバージョン。v2 では常に `2` |
| `id` | string | Yes | イベントID |
| `deviceId` | string | Yes | 発生元端末ID |
| `occurredAt` | string | Yes | 操作が発生した日時 |
| `type` | string | Yes | イベント種別 |

送信側は日時を UTC の RFC 3339 形式 `YYYY-MM-DDTHH:mm:ss.sssZ` で出力しなければならない（MUST）。例: `2026-09-20T01:23:45.000Z`。

すべての整数は JavaScript の安全な整数範囲内でなければならない。`NaN`、`Infinity`、小数、数値を表す文字列は無効である。

異なる言語の実装間でイベントを安定して複製できるよう、イベントは生成後に再構成せず、元のフィールドと値を保持する（MUST）。新規生成時のフィールド順は、共通フィールド、`threadId`、`type`、種別固有フィールドの順を推奨する。フィルターイベントは共通フィールド、`type`、`scope`、`targetType`、`target`、`effect`、日時フィールドの順とする。

## 7. イベント種別

### 7.1 `thread.viewed`

スレッドを閲覧したことと、その時点の最終既読位置を表す。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `threadId` | string | 5.3節の共通キー |
| `position` | integer | `0` 以上 |

`position` は表示行番号ではなく、サイト上のレス番号を使用する。あぼーん、フィルター、折りたたみなどで非表示のレスも元の番号体系に含める。`0` は既読レスなしを表す。

アダプターは少なくとも、利用者がスレッドを明示的に開いたとき、および最終既読位置が進んだときにイベントを記録すべきである。同じ閲覧セッション中のスクロール通知は間引いてよいが、セッション終了時または短いデバウンス後に最新位置を記録する。

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440001","deviceId":"desktop-main","occurredAt":"2026-09-20T01:23:45.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.viewed","position":125}
```

### 7.1.1 `thread.history.cleared`

端末から意図的にスレッドの閲覧履歴を削除したことを表す。削除イベント自体は対象スレッドが現在の射影に存在しなくても必ず保存する（MUST）。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `threadId` | string | 5.3節の共通キー |

同じ `threadId` の `thread.history.cleared` と履歴イベントを `(occurredAt, deviceId, id)` で比較する。削除マーカー以前の `thread.viewed` と `thread.response-count.observed` は射影から除外し、削除後の `thread.viewed` は新しい閲覧履歴として採用する。古いオフライン端末から削除前のイベントが後から届いても、履歴を復活させてはならない（MUST NOT）。

お気に入りと書き込み位置は閲覧履歴とは独立しており、このイベントでは削除しない。履歴だけが残っていたスレッドは通常の状態一覧から除外する。お気に入りまたは書き込み位置が残る場合は、それらの状態を保持する。

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440009","deviceId":"desktop-main","occurredAt":"2026-09-20T01:30:00.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.history.cleared"}
```

### 7.2 `thread.response-count.observed`

端末が観測したスレッドのレス数を表す。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `threadId` | string | 5.3節の共通キー |
| `responseCount` | integer | `0` 以上 |

`responseCount` はフィルター適用後の表示件数ではなく、サイト上の番号体系で観測できたレス数とする。同期状態は最大値を保持するため、サイト側の削除などによる件数減少は v2 では伝播しない。

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440002","deviceId":"desktop-main","occurredAt":"2026-09-20T01:24:00.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.response-count.observed","responseCount":130}
```

### 7.3 `thread.favorite.set`

スレッドをお気に入りに設定し、その重要度を指定する。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `threadId` | string | 5.3節の共通キー |
| `level` | integer | `1` から `5` |

レベルは `1` が最低、`5` が最高の順序尺度である。名称、色、フォルダー等への表示方法はアダプターが決めてよい。お気に入りが真偽値だけのブラウザは、ローカルで新規設定するとき `1` を送信し、受信した `1` から `5` はすべて「お気に入り」として表示する。そのブラウザで利用者が変更していない受信レベルを `1` で上書きしてはならない。

入力 API で `level` を省略した場合は `1` になるが、永続化イベントでは必須である。

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440003","deviceId":"desktop-main","occurredAt":"2026-09-20T01:25:00.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.favorite.set","level":3}
```

### 7.4 `thread.favorite.cleared`

スレッドのお気に入りを解除する。解除も状態変更イベントであり、省略または物理削除してはならない。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `threadId` | string | 5.3節の共通キー |

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440004","deviceId":"desktop-main","occurredAt":"2026-09-20T01:26:00.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.favorite.cleared"}
```

### 7.5 `thread.post.recorded`

利用者が書き込んだレスの位置を表す。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `threadId` | string | 5.3節の共通キー |
| `position` | integer | `1` 以上 |

投稿要求時の予測番号ではなく、サーバー応答または再取得によって確定したレス番号を記録すべきである。

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440005","deviceId":"desktop-main","occurredAt":"2026-09-20T01:27:00.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.post.recorded","position":126}
```

### 7.6 `thread.post.cleared`

利用者が自分の書き込み位置を削除したことを表す。`position` は削除対象のレス番号であり、`1` 以上とする。対象位置が現在の射影に存在しなくてもイベントを保存しなければならない（MUST）。

削除は位置ごとのトゥームストーンである。`thread.post.recorded` と `thread.post.cleared` を `(occurredAt, deviceId, id)` で比較し、より新しいイベントが `cleared` なら位置を非表示にする。削除後に同じ位置を新しい `thread.post.recorded` で記録した場合は、位置を再表示する。

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440010","deviceId":"desktop-main","occurredAt":"2026-09-20T01:28:00.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.post.cleared","position":126}
```

### 7.7 `thread.metadata.updated`

スレッドの表示用タイトルと遷移先URLを一組として記録する。タイトルやURLは`threadId`の主キーには使わない。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `threadId` | string | 5.3節の共通キー |
| `title` | string | 空でない表示用タイトル |
| `url` | string | 空でない絶対URL |

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440008","deviceId":"desktop-main","occurredAt":"2026-09-20T01:27:30.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.metadata.updated","title":"ソフトウェア板のスレッド","url":"https://egg.5ch.net/test/read.cgi/software/1750000000/"}
```

アダプターはスレッドを開いたとき、またはタイトルもしくは遷移先URLの変化を検出したときにイベントを記録する。同じ値の高頻度通知は抑止してよい。ホスト名が変わった場合は `server-key` が変わるため、移転前後は別の `threadId` として扱う。

### 7.8 `filter.set`

フィルターを設定する。フィルターは `scope`、`targetType`、`target` の組で識別し、`effect` で一致時の表示効果を指定する。

| フィールド | 型 | 必須 | 制約・意味 |
| --- | --- | --- | --- |
| `scope` | string | Yes | 5.4節の共通キー |
| `targetType` | string | Yes | 専用ブラウザが定義する対象の種類。推奨値の例: `ID`、`SLIP`、`SLIP-PRE`、`SLIP-SUF`、`MAIL`、`NAME`、`TRIP`、`WORD` |
| `target` | string | Yes | 対象の文字列。空は禁止 |
| `effect` | string | Yes | 専用ブラウザが定義する一致時の表示効果。推奨値の例: `OMIT`、`NOP`、`HIGHLIGHT` |
| `updatedAt` | string | Yes | このフィルターの意味上の更新日時 |
| `hitAt` | string または `null` | No | 条件がスレッド内で最後に検出された日時 |

同じ `(scope, targetType, target)` に新しい `effect` を設定した場合は、同じフィルターの表示効果を更新する。`updatedAt` は競合解決に使われ、通常は `occurredAt` と同じ値にする。

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440006","deviceId":"desktop-main","occurredAt":"2026-09-20T01:28:00.000Z","type":"filter.set","scope":"egg.5ch.net/software","targetType":"ID","target":"ABCDEFG","effect":"OMIT","updatedAt":"2026-09-20T01:28:00.000Z","hitAt":"2026-09-20T01:27:59.000Z"}
```

### 7.9 `filter.cleared`

`scope`、`targetType`、`target` が一致するフィルターを解除する。解除も保持し、古いオフライン端末の設定を復活させない。

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `scope` | string | 5.4節の共通キー |
| `targetType` | string | 解除対象の種類。値は専用ブラウザが定義する。推奨値の例: `ID`、`SLIP`、`SLIP-PRE`、`SLIP-SUF`、`NAME`、`MAIL`、`TRIP`、`URL`、`IMGHASH`、`WORD` |
| `target` | string | 解除対象と完全一致 |
| `updatedAt` | string | 意味上の更新日時 |

```json
{"v":2,"id":"550e8400-e29b-41d4-a716-446655440007","deviceId":"desktop-main","occurredAt":"2026-09-20T01:29:00.000Z","type":"filter.cleared","scope":"egg.5ch.net/software","targetType":"ID","target":"ABCDEFG","updatedAt":"2026-09-20T01:29:00.000Z"}
```

### 7.10 フィルター対象と表示効果

`targetType` と `target` の組で、条件とする対象を表す。`targetType`の値は専用ブラウザが定義する。以下は推奨値の例であり、これらに限定されない。

| `targetType` | 推奨する意味 | 比較 |
| --- | --- | --- |
| `ID` | 投稿者IDとの完全一致 | 大文字小文字を含めサイト表示値どおり |
| `SLIP` | BBS_SLIP 表示値との完全一致 | サイト表示値どおり |
| `SLIP-PRE` | BBS_SLIP の前半との一致 | サイト表示値どおり |
| `SLIP-SUF` | BBS_SLIP の後半との一致 | サイト表示値どおり |
| `NAME` | 名前欄との一致 | 専用ブラウザの仕様による |
| `MAIL` | メール欄との一致 | 専用ブラウザの仕様による |
| `TRIP` | トリップとの一致 | 専用ブラウザの仕様による |
| `URL`  | プロトコルを抜いたURLとの一致 | 専用ブラウザの仕様による |
| `IMGHASH` | 画像のハッシュ値 | 専用ブラウザの仕様による |
| `WORD` | 本文に含まれる文字列との一致 | Unicode NFC、文字列一致 |

`effect`の値も専用ブラウザが定義する。以下は推奨値の例であり、これらに限定されない。

| `effect` | 意味 |
| --- | --- |
| `OMIT` | 目立たない表示 |
| `NOP` | 完全に非表示 |
| `HIGHLIGHT` | 強調表示 |

### 7.11 `effect` の解釈

`effect` の具体的な色、透明度、アニメーションなどはクライアントが決定する。未対応の `targetType` または `effect` を受信したアダプターは、そのフィルターをローカルで適用しなくてもよい。

## 8. 状態の統合規則

イベントの到着順やセグメント列挙順は状態の結果に影響してはならない。比較で「辞書順」とある箇所は、Unicode コードポイントに基づく昇順で大きい側を新しいものとして選ぶ。

### 8.1 スレッド状態

| 射影フィールド | 統合規則 |
| --- | --- |
| `title`, `url` | 同じ`threadId`の`thread.metadata.updated`を`(occurredAt, deviceId, id)`で比較し、最大のイベントの組を採用 |
| `lastReadPosition` | 最新の `thread.history.cleared` より後に発生した `thread.viewed.position` の最大値 |
| `lastViewedAt` | 最新の `thread.history.cleared` より後に発生し、`(occurredAt, deviceId, id)` が最大の `thread.viewed` の `occurredAt` |
| 閲覧履歴削除 | `(occurredAt, deviceId, id)` が最大の `thread.history.cleared` より前の閲覧状態を無効化 |
| `responseCount` | 最新の `thread.history.cleared` より後に発生した `responseCount` の最大値 |
| `favoriteLevel` | 8.2節で勝ったイベントが `set` ならその `level`、`cleared` なら未設定 |
| `postPositions` | 位置ごとに最終更新が `thread.post.recorded` となった位置の重複なし昇順集合 |

最終閲覧日時と最終既読位置は独立して統合する。たとえば、位置100を読んだ古いイベントと、その後に位置80を再閲覧したイベントがある場合、`lastReadPosition` は100、`lastViewedAt` は後者の日時になる。

タイトルとURLは常に同じイベントから取得する。スナップショットには値に加えて、そのイベントの`occurredAt`、`deviceId`、`eventId`を保存し、コンパクション後も古いオフライン端末の更新で上書きされないようにする。メタデータ未取得のスレッドでは`title`と`url`を省略する。

スナップショットは、有効な`postPositions`に加えて、削除済み位置の最新マーカーを`postCleared`へ保存する。これにより、コンパクション後に古いオフライン端末の`thread.post.recorded`が届いても削除状態を維持する。

### 8.2 お気に入り

同じ `threadId` の `thread.favorite.set` と `thread.favorite.cleared` を、次のキーで昇順比較し、最大のイベントを採用する。

```text
(occurredAt の時刻, deviceId の辞書順, id の辞書順)
```

同時刻でも全実装が同じ結果を選べるよう、`deviceId` と `id` をタイブレークに使う。`set` と `cleared` の種類そのものに優先度はない。

### 8.3 フィルター

同じ `(scope, targetType, target)` の `filter.set` と `filter.cleared` を、次のキーで昇順比較し、最大のイベントを採用する。

```text
(updatedAt の時刻, deviceId の辞書順, id の辞書順)
```

勝ったイベントが `filter.set` なら有効、`filter.cleared` なら解除済みとなる。解除済み項目は通常のフィルター一覧には返さないが、競合解決情報として保持する。

### 8.4 重複と衝突

- 同じイベントが複数セグメントに存在しても `id` 単位で1件として扱う。
- 同じ `id` で内容が異なる場合は処理を停止し、データ破損として報告する。
- 無効なイベント、未対応の `v`、未対応の `type` を推測で補正してはならない。
- 部分的に壊れたセグメントを黙って読み飛ばしてはならない。利用者が診断できるエラーにする。

## 9. 発火と反映

### 9.1 ローカルイベントの発火条件

| ブラウザ側の操作 | 発火するイベント |
| --- | --- |
| スレッドを開く、またはタイトル・遷移先URLを取得・更新 | `thread.metadata.updated` |
| スレッドを開く、または既読位置が進む | `thread.viewed` |
| 利用者がスレッドの閲覧履歴を削除 | `thread.history.cleared` |
| サーバーからレス一覧を取得し件数が判明 | `thread.response-count.observed` |
| お気に入りを追加、またはレベルを変更 | `thread.favorite.set` |
| お気に入りを解除 | `thread.favorite.cleared` |
| 投稿したレス番号が確定 | `thread.post.recorded` |
| 自分の書き込み位置を削除 | `thread.post.cleared` |
| フィルターを追加、または同じキーを更新 | `filter.set` |
| フィルターを解除 | `filter.cleared` |

同一値の高頻度通知はデバウンスまたは重複抑止してよい。ただし、お気に入りとフィルターの解除を「現在一覧に存在しない」という理由で省略してはならない。

### 9.2 射影状態の反映

アダプターは同期後、`getStates()` と `getFilters()` に相当する射影結果を取得してブラウザへ反映する。

- 既読位置、レス数、書き込み位置はブラウザ固有の表示番号ではなくサイト上のレス番号へ変換する。
- `thread.post.cleared`を受信した位置は、ブラウザ側の自分の書き込み位置から削除する。
- お気に入りは解除状態も含め、最後に適用した射影との差分を反映する。
- フィルターはアダプターが対応する対象種別と表示効果だけを動作へ反映してよい。
- 対応できないレベルやフィルターがあっても、同期データ自体を削除または上書きしない。
- 反映に失敗した項目は記録し、他の正常な項目の反映を可能な範囲で継続すべきである。

### 9.3 初回導入

既存ブラウザーデータを初回に取り込む場合、アダプターは正規化後の現在値を1回だけイベント化する。再起動のたびに全件を再インポートしてはならない。インポート完了をアダプター側で永続的に記録する。

元データに更新日時がないお気に入りはインポート時刻を `occurredAt` とする。フィルターの更新日時が不明な場合も、インポート時刻を `updatedAt` とする。これらの時刻は既存の別端末状態を上書きし得るため、初回同期でリモート状態を取得してからインポートすることを推奨する。

## 10. 時計と順序

閲覧位置とレス数は単調な統合のため時計ずれの影響を受けない。書き込み位置は記録と削除を位置ごとのイベント時刻で比較するため、削除の競合解決は端末時計に依存する。お気に入り、フィルター、最終閲覧日時も端末時計に依存する。

アダプターは次を満たすべきである。

- OS の時計同期を利用する。
- 同一プロセスで生成する時刻が後退した場合、直前に生成した時刻未満にならないよう補正する。
- 外部データの日時が明らかに未来である場合、無条件に採用せず診断情報を残す。
- 受信イベントの時刻を書き換えない。

v2 はベクトル時計やサーバー時刻による補正を定義しない。

## 11. bbsync API との対応

| イベント | 推奨 API |
| --- | --- |
| `thread.metadata.updated` | `setThreadMetadata(threadId, title, url)` |
| `thread.viewed` | `recordThreadView(threadId, position)` |
| `thread.history.cleared` | `clearThreadHistory(threadId)` |
| `thread.response-count.observed` | `recordResponseCount(threadId, responseCount)` |
| `thread.favorite.set` | `setFavorite(threadId, level)` |
| `thread.favorite.cleared` | `clearFavorite(threadId)` |
| `thread.post.recorded` | `recordPost(threadId, position)` |
| `thread.post.cleared` | `clearPost(threadId, position)` |
| `filter.set` | `setFilter(scope, targetType, target, effect, options)` |
| `filter.cleared` | `clearFilter(scope, targetType, target, options)` |

履歴日時を明示する初回インポートや複数イベントの一括追加には `append(inputs)` を使用する。永続化済みイベントの `v`、`id`、`deviceId` はコアが付与する。

同期と反映の基本形は次のとおりである。

```ts
await sync.synchronizeWith(remoteStore);

const threads = await sync.getStates();
const filters = await sync.getFilters();

await adapter.applyProjectedState({ threads, filters }, {
  suppressOutboundEvents: true,
});
```

`compact()` はイベントの意味を変えず、現在状態をスナップショットへまとめる保守操作である。アダプターは同期成功後などの安全な区切りで実行してよい。

## 12. 永続化と同期の不変条件

通常のアダプターは `EventStore` 実装へ直接イベントを書かず、`BbsSync` API を使う。別言語の実装または新しいストレージ実装は、次の条件も満たさなければならない。

- 保存文字コードは UTF-8 とし、JSONL は1行1イベントとする。
- セグメントは `(deviceId, segmentId)` で識別する。
- セグメントへの変更は末尾への追記だけを許可する。
- 同じセグメントの短い側が長い側の完全な接頭辞なら長い側を採用する。
- 両側が異なる内容へ分岐した場合は、どちらかを自動選択せず同期を失敗させる。
- スナップショットは端末ごとに単調増加する `revision` を持つ。
- 同じ端末・同じ `revision` で内容が違うスナップショットは衝突とする。
- スナップショットが被覆すると明記したイベントだけを整理対象にする。

ストレージ実装は `registerEventStoreContractTests` の共通契約テストを通過しなければならない。

## 13. バージョンと拡張

- v2 のイベントは `v: 2` を必須とする。
- 受信側は未対応のバージョンまたはイベント種別を黙って解釈してはならない。
- 既存フィールドの意味、型、統合規則を変える変更は新しい `v` を必要とする。
- フィルター対象の追加は、既存の意味を変えず識別子衝突がなければ仕様文書の後方互換な追加としてよい。

## 14. 適合チェックリスト

アダプターを相互運用対応とする前に、少なくとも次を確認する。

- [ ] `deviceId` を永続化し、プロファイル複製時に再生成する。
- [ ] 同じ URLから `<server>/<board>/<thread>` の同じキーを生成し、サーバー名を保持する。
- [ ] レス番号はフィルター後の表示位置ではなく元の番号を使う。
- [ ] 全10イベントを正しい制約で発火する。
- [ ] 同期反映からイベントを再発火しない。
- [ ] 同じ射影を複数回適用しても結果が変わらない。
- [ ] お気に入り解除とフィルター解除を状態として保持する。
- [ ] 閲覧履歴削除を状態として保持し、古いオフライン端末の履歴を復活させない。
- [ ] 未対応のレベルやフィルターを勝手に変換・解除しない。
- [ ] UTC の RFC 3339 日時を生成する。
- [ ] オフラインの両端末で更新後、順不同で同期しても同じ射影状態になる。
- [ ] イベントID衝突、分岐セグメント、未対応バージョンを利用者へ報告する。

## 付録 A. 最小相互運用シナリオ

1. 端末 A が位置120を閲覧し、お気に入りレベル3を設定する。
2. 同期前に端末 B が位置125を閲覧し、同じスレッドへレス126を投稿する。
3. A と B のイベントを任意の順序で交換する。
4. 両端末の射影は次の状態へ収束しなければならない。

```json
{
  "threadId": "egg.5ch.net/software/1750000000",
  "lastReadPosition": 125,
  "favoriteLevel": 3,
  "postPositions": [126]
}
```

`lastViewedAt` は B の `thread.viewed.occurredAt` が A より新しければ B の日時になる。

## 付録 B. 競合解決例

次のお気に入りイベントがある場合、時刻が新しい解除が勝つ。

```jsonl
{"v":2,"id":"a-set","deviceId":"desktop","occurredAt":"2026-09-20T01:00:00.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.favorite.set","level":5}
{"v":2,"id":"b-clear","deviceId":"mobile","occurredAt":"2026-09-20T01:01:00.000Z","threadId":"egg.5ch.net/software/1750000000","type":"thread.favorite.cleared"}
```

結果には `favoriteLevel` が存在しない。イベントを逆順に受信しても結果は同じである。
