# bbsync 他言語実装ガイド v2

## 1. この文書の目的

この文書は、bbsync のイベント、スナップショット、同期結果を TypeScript 版と相互運用できる形で他言語に実装するためのガイドです。専用ブラウザがいつイベントを発行するかは[アダプターイベント仕様 v2](adapter-event-protocol-v2.md)を参照してください。この文書では、そのイベントをどう検証・保存・統合・同期するかを扱います。

互換実装では、次の3層を分けると作りやすくなります。

1. **プロトコル層**: JSON の型、検証、比較、状態射影
2. **ストレージ層**: 追記専用セグメントと端末別スナップショット
3. **利用API層**: イベント生成、状態取得、同期、compact

最初にメモリ上でプロトコル層と適合テストを完成させ、その後にローカルファイルやクラウド用のストレージを実装することを推奨します。

## 2. 互換性の単位

現在のスキーマバージョンは `2` です。イベントとスナップショットの `v` は必ず数値の `2` にします。未知のバージョンや未知のイベント種別を推測して処理してはいけません。

相互運用に必要な不変条件は次のとおりです。

- イベントは作成元の `deviceId` ごとに分離して保存する
- 同じ `deviceId` へ書き込むプロセスまたは端末は常に1つにする
- 既存セグメントは、同一内容の再書き込みか、完全な接頭辞への追記だけを許す
- イベントは `id` で重複排除し、同じ `id` で内容が異なる場合はエラーにする
- 削除は物理削除ではなく、より新しい削除イベントまたはスナップショット内の tombstone で表す
- 競合解決で使用する日時、`deviceId`、イベントIDをスナップショットにも残す
- 同期時に分岐を検出したら、一方を暗黙に正として選ばずエラーにする

## 3. 共通の型と検証

### 3.1 識別子

`deviceId`、イベントの `id`、`segmentId` は次の正規表現に一致させます。

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
```

つまり、1〜128文字のASCII英数字・ピリオド・アンダースコア・ハイフンです。先頭は英数字に限ります。UUIDはハイフン付きの通常形式のまま使用できます。

`threadId`、フィルターの `scope`、`targetType`、`target`、`effect` は空でない文字列です。`threadId` と `scope` の組み立て方はアダプターイベント仕様に従います。bbsync コアはこれらを不透明な文字列として扱い、自動正規化しません。

### 3.2 数値

位置、レス数、revision、件数は JSON number の整数です。TypeScript版との互換範囲は JavaScript の安全な整数、すなわち `-(2^53 - 1)` から `2^53 - 1` です。各フィールドにはさらに次の制約があります。

| フィールド | 制約 |
| --- | --- |
| `position` / `firstPosition` / `responseCount` | 0以上。ただし書き込み位置の `position` は1以上 |
| `firstPosition` | 同じ閲覧イベントの `position` 以下 |
| `level` | 1〜5 |
| snapshot `revision` | 1以上 |
| `eventCount` | 0以上 |

浮動小数、NaN、Infinityは使用できません。

### 3.3 日時

日時フィールドはパース可能な文字列として保存します。新規生成時は、UTCのRFC 3339形式をミリ秒3桁で出力してください。

```text
2026-09-20T01:23:40.000Z
```

比較時は文字列比較ではなく、UTCの時刻値へ変換して比較します。TypeScript版は JavaScript `Date.parse` を使用するため、移植版で受け入れる入力を同一にしにくい場合があります。相互運用データでは上記形式だけを生成すれば、この差を回避できます。無効な日時は読み込み時にエラーにします。

日時の役割は2種類あります。

- `occurredAt`: イベント自体の発生日時。スレッド状態、お気に入り、書き込み位置の競合に使う
- `updatedAt`: フィルター状態の競合に使う。`occurredAt` とは独立して比較する

### 3.4 JSONと省略可能フィールド

セグメントはUTF-8のJSON Linesです。1行に1イベントを書き、最後の行にも改行を付けます。空行は読み飛ばします。スナップショットは1つのJSONオブジェクトです。

- 「省略」と `null` を同一視しない
- この文書で `null` を許すのは入力APIの `filter.set.hitAt` だけ。保存イベントでは `null` のままでも現行版は受理し、射影時に値なしとして扱う
- `isRegex` の省略は `false`
- イベント生成APIでは `filter.set.updatedAt` の省略は `occurredAt`
- イベント生成APIではお気に入り `level` の省略は `1`

現行TypeScript版は、同じイベントや同じrevisionのスナップショットかどうかを、パース後のオブジェクトを `JSON.stringify` した結果で判定します。そのためJSON仕様上は順不同であるプロパティ順も、現行 v2 の衝突判定では実質的に意味を持ちます。他言語版からファイルを生成するときは、後述の順序でキーを出力してください。空白や改行形式は読み込み時に正規化されるため一致する必要はありません。

## 4. イベント形式

すべてのイベントは次の共通フィールドで始めます。

```json
{"v":2,"id":"event-1","deviceId":"desktop","occurredAt":"2026-09-20T00:00:00.000Z"}
```

スレッドイベントでは、推奨キー順は `v`, `id`, `deviceId`, `occurredAt`, `threadId`, `type`, 種別固有フィールドです。フィルターイベントでは `threadId` はありません。

| `type` | 必須の種別固有フィールド | 状態への作用 |
| --- | --- | --- |
| `thread.metadata.updated` | `threadId`, `title`, `url` | タイトルと絶対URLを一組で更新 |
| `thread.viewed` | `threadId`, `position`; 任意で `firstPosition` | 最終閲覧位置・日時を更新 |
| `thread.history.cleared` | `threadId` | 閲覧履歴のepochを更新 |
| `thread.response-count.observed` | `threadId`, `responseCount` | 観測レス数を更新 |
| `thread.favorite.set` | `threadId`, `level` | お気に入りレベルを設定 |
| `thread.favorite.cleared` | `threadId` | お気に入りを解除 |
| `thread.post.recorded` | `threadId`, `position` | 自分の書き込み位置を記録 |
| `thread.post.cleared` | `threadId`, `position` | 自分の書き込み位置を解除 |
| `filter.set` | `scope`, `targetType`, `target`, `effect`, `isRegex`, `updatedAt`; 任意で `hitAt` | フィルターを設定 |
| `filter.cleared` | `scope`, `targetType`, `target`, `updatedAt` | フィルターを解除 |

`title` は空でない文字列、`url` は空でない絶対URLです。フィルターの `targetType` と `effect` はアダプターが定義する文字列で、コアは列挙値を制限しません。

種別ごとの標準的なキー順の例です。

```jsonl
{"v":2,"id":"e1","deviceId":"desktop","occurredAt":"2026-09-20T00:00:00.000Z","threadId":"egg.5ch.net/software/123","type":"thread.metadata.updated","title":"title","url":"https://egg.5ch.net/test/read.cgi/software/123/"}
{"v":2,"id":"e2","deviceId":"desktop","occurredAt":"2026-09-20T00:01:00.000Z","threadId":"egg.5ch.net/software/123","type":"thread.viewed","position":120,"firstPosition":100}
{"v":2,"id":"e3","deviceId":"desktop","occurredAt":"2026-09-20T00:02:00.000Z","type":"filter.set","scope":"egg.5ch.net/software","targetType":"ID","target":"ABCDEFG","effect":"OMIT","isRegex":false,"updatedAt":"2026-09-20T00:02:00.000Z"}
```

イベントオブジェクトの推奨キー順は次の規則で一意に決められます。

1. 共通フィールド: `v`, `id`, `deviceId`, `occurredAt`
2. スレッドイベント: `threadId`, `type`、その後は上表に記載した順
3. フィルターイベント: `type`, `scope`, `targetType`, `target`, `effect`, `isRegex`, `updatedAt`, `hitAt`。clearedでは `effect`, `isRegex`, `hitAt` を除く
4. 省略可能フィールドがない場合、そのキー自体を出力しない

## 5. 状態射影

### 5.1 入力の集め方

状態を読むときは、ストレージ内の全端末のスナップショットをseedとして読み、各スナップショットがまだ被覆していないセグメントイベントを重ねます。スナップショットの `deviceId` と各 `coveredSegments.segmentId` から対象セグメントを特定し、先頭 `eventCount` 件はすでにseedへ反映済みとして再適用しません。セグメントが伸びている場合は、それより後ろのイベントだけを適用します。被覆件数が現在のセグメント件数を超えていたら、セグメントの短縮または破損としてエラーにします。

セグメントイベントは全端末・全セグメントを通じて `id` で重複排除します。同じ `id` のイベントが複数あり、キー順を含む正規化後JSONが一致しなければ衝突エラーです。

イベント適用前に、次の全順序で昇順に並べます。

```text
(parse(occurredAt), ordinal(deviceId), ordinal(id))
```

`ordinal` はロケールに依存しない辞書順です。`deviceId` と `id` はASCII制限があるため、ASCIIコード順で比較できます。大きい値を「新しい」とします。

### 5.2 スレッド状態

スレッドごとに次の規則を適用します。

- **metadata**: 履歴削除とは独立に、`(occurredAt, deviceId, eventId)` が最大の候補を採用する。`title` と `url` は分割しない
- **lastReadPosition**: 現在の閲覧履歴epoch内の `thread.viewed.position` の最大値
- **firstReadPosition**: 最新の `thread.viewed` の `firstPosition`。最新イベントで省略されていれば未設定に戻す
- **lastViewed**: `(occurredAt, deviceId, eventId)` が最大の `thread.viewed`
- **responseCount**: 現在の閲覧履歴epoch内の最大値
- **favorite**: set/clearedを合わせて `(occurredAt, deviceId, eventId)` が最大の操作を採用する
- **postPositions**: `(threadId, position)` ごとに recorded/clearedを合わせて最新の操作を採用する

metadata、viewed、history cleared、favoriteの「最新」はすべて同じ3要素の比較です。書き込み位置は最後に `threadId`, `position` も比較しますが、通常は先のイベントIDまでで決まります。

`thread.history.cleared` は `(occurredAt, deviceId, eventId)` が最大のものを現在の履歴epoch境界にします。境界以前または境界と同順序のviewed/response-countイベントを無視し、境界より新しいイベントを新しい履歴として扱います。metadata、お気に入り、書き込み位置は履歴削除の対象外です。

複数端末が独立してcompactしたスナップショットを統合するときは、最初に最新のhistory clear境界を決めます。スナップショットの `historyCleared` がその境界と一致する場合に加え、`lastViewed` が境界より新しい場合も、そのスナップショットの閲覧位置・閲覧日時・レス数を新しいepochの候補にします。これにより、別端末で履歴を削除した後、まだ同期していない端末で行われた新しい閲覧を保持します。history clearイベントを後から適用する場合も、すでに保持している `lastViewed` がその境界より新しければ閲覧状態を消しません。

履歴削除後に閲覧されておらず、お気に入りも書き込み位置もないスレッドは公開状態一覧から隠します。削除後に再閲覧すれば再び表示します。履歴削除マーカーを一度も持たない状態は、従来互換のため他の値が空でも残る場合があります。

### 5.3 書き込み位置

各位置の recorded/cleared は次の順で比較し、最大の操作を採用します。

```text
(parse(occurredAt), ordinal(deviceId), ordinal(eventId), ordinal(threadId), position)
```

最新がrecordedなら `postPositions` に含め、clearedなら含めず tombstone を保持します。同じ位置を後からrecordedすれば復活します。

### 5.4 フィルター

フィルターのキーは文字列連結ではなく、3要素の組 `(scope, targetType, target)` です。区切り文字を含む値でも衝突しないデータ構造を使ってください。

set/clearedを合わせて次の順が最大の候補を採用します。

```text
(parse(updatedAt), ordinal(deviceId), ordinal(eventId))
```

`filter.cleared` は `effect = "OMIT"`, `isRegex = false`, `cleared = true` の内部状態として保持します。これはスナップショット形状を一定にするための値で、解除済みフィルターを利用側へ返してはいけません。setの `hitAt` が `null` または省略なら、射影状態では省略します。

コレクションの列挙順は状態の意味に含めないでください。APIで安定順が必要なら、別途キーによるロケール非依存のソートを行います。

## 6. EventStore契約

ストレージ層は、言語に合った名前へ変えて構いませんが、次の操作と意味を保ちます。

| 操作 | 契約 |
| --- | --- |
| `appendEvents(deviceId, events)` | 指定端末のアクティブセグメントへ順序どおり追記し、上限でローテーション |
| `listSegments()` | 全端末の `{deviceId, segmentId}` を列挙 |
| `readSegment(ref)` | JSONLを検証してイベント列として返す。全イベントの `deviceId` はrefと一致必須 |
| `writeSegment(ref, events)` | 新規作成、同一内容、既存内容の完全な延長のみ許可 |
| `listSnapshots()` | スナップショットが存在する端末IDを列挙 |
| `readSnapshot(deviceId)` | 検証済みsnapshot、または未存在を返す |
| `writeSnapshot(snapshot)` | revisionが大きい場合だけ更新。同revision同内容は成功、異内容は衝突 |
| `pruneSegments(snapshot)` | snapshotが完全にcoverする当該端末のセグメントだけを保持設定に従い削除 |

`appendEvents` は1回の呼び出し内の順序を保存します。イベントの `deviceId` が引数と違う場合はエラーです。空配列は何もしません。

`writeSegment` で `existing` と `candidate` を比較するときは、次だけを許します。

```text
existing == candidate       -> 何もしない
candidate is prefix existing -> 何もしない（短い内容へ戻さない）
existing is prefix candidate -> candidateへ更新
otherwise                    -> 分岐エラー
```

ファイル、クラウドオブジェクトのどちらでも、セグメントとスナップショットの置換は可能な限りatomicにします。ローカル実装では同じディレクトリに一時ファイルを作成し、renameで置換します。クラウド実装ではETagやrevisionの条件付き更新を使うのが相当します。

## 7. 双方向同期

2つのEventStoreを同期する処理は次の順序です。

1. 両側のセグメント一覧を取得し、キー `(deviceId, segmentId)` で比較する
2. 端末ごとにスナップショットを同期する
   - 片側だけにあれば反対側へコピー
   - revisionが大きい方を小さい方へコピー
   - 同revisionで内容が異なれば衝突エラー
3. 片側だけにあるセグメントを反対側へコピーする
4. 両側にあるセグメントを比較する
   - 同一なら何もしない
   - 一方が他方の完全な接頭辞なら長い方へ揃える
   - それ以外は分岐エラー
5. 各端末の最新スナップショットを使い、両側でcover済みセグメントを整理する

同期結果の件数は、新規コピーと既存セグメントの延長をどちらも `copiedToLeft` / `copiedToRight` に数えます。スナップショットは別の `copiedSnapshotsToLeft` / `copiedSnapshotsToRight` に数えます。

同期は冪等です。同じ2ストレージを変更なしで再同期した場合、4つの件数はすべて0になります。

## 8. スナップショットとcompact

### 8.1 形状

スナップショットのトップレベルキー順は次のとおりです。

```text
v, deviceId, revision, createdAt, coveredSegments, threads, filters
```

各オブジェクトのキー順は次のとおりです。

```text
SegmentCoverage:
  segmentId, eventCount

SnapshotThreadState:
  threadId, metadata, lastReadPosition, firstReadPosition, responseCount,
  lastViewed, historyCleared, favorite, postPositions, postRecords, postCleared

metadata:
  title, url, occurredAt, deviceId, eventId

lastViewed:
  occurredAt, deviceId, eventId, firstPosition

historyCleared:
  occurredAt, deviceId, eventId

favorite:
  cleared, level, occurredAt, deviceId, eventId

postCleared item:
  position, occurredAt, deviceId, eventId

postRecords item:
  position, occurredAt, deviceId, eventId

filter:
  scope, targetType, target, effect, isRegex, updatedAt, hitAt,
  cleared, deviceId, eventId
```

省略可能な値がない場合はキーごと省略します。`postPositions` と `filters` は空でも必須です。各threadの `postPositions` も必須です。有効な書き込み位置のうち競合順序が分かるものは、同じ位置を `postRecords` にも記録します。`favorite.cleared` がtrueなら `level` は出力しません。

### 8.2 作成手順

compactは次の手順で実行します。

1. 全端末のsnapshotと全segmentを一度ずつ読み取り、現在状態を射影する
2. 自端末の既存snapshot revisionに1を加える。未存在なら1
3. `createdAt` を現在時刻として、手順1で読み取った自端末segmentの `segmentId` とイベント件数を `coveredSegments` に記録する
4. 保持ポリシーを適用してsnapshotを構築する
5. snapshotを保存する
6. 完全にcover済みの自端末segmentを整理する

状態射影後にsegmentを読み直してcoverageを作ると、その間に追記された未射影イベントまでcoverしたことになり得ます。状態とcoverageは必ず同じ読み取り結果から作ります。`coveredSegments.eventCount` が整理時点のセグメント行数と完全一致するときだけ、そのセグメントを削除候補にできます。読み取り後に同じセグメントへイベントが追記されて件数が増えた場合は削除してはいけません。

### 8.3 保持ポリシー

既定値は次のとおりです。

```text
maxGlobalPostPositions = 1000
retentionPeriod = 30 days
retainSegmentsPerDevice = 1
```

有効な書き込み位置を全スレッド横断で、書き込み位置の比較順が新しいものから最大 `maxGlobalPostPositions` 件残します。同じスレッド内だけの上限ではありません。削除tombstoneはこの件数に含めず、別に保持します。新しく作るsnapshotでは、有効な位置の `occurredAt`、`deviceId`、`eventId` を `postRecords` に保存します。

初期のv2実装が作ったsnapshotには `postRecords` がありません。この旧形式を読む場合、`postPositions` は順序不明の記録として扱います。同じ位置について順序情報を持つrecordedまたはclearedマーカーが別に存在する場合は、順序不明の記録よりもそのマーカーを優先します。これによりsnapshotの列挙順で削除状態が変わることを防ぎます。

スレッドは次のいずれかを満たす場合にsnapshotへ残します。

- 有効なお気に入りがある
- お気に入りの解除tombstoneがある
- 保持対象の有効な書き込み位置がある
- 書き込み位置の削除tombstoneがある
- `lastViewed` またはmetadataの最終活動が保持期間内。ただしhistory clearがある場合、metadata日時は活動判定に使わない
- history clear tombstoneがある

favorite tombstoneは、古いオフライン端末のお気に入り設定が復活しないよう、それ自体を保持理由として保存します。フィルターも解除済みを含めてすべてsnapshotへ保存します。

`threads` は `threadId` 順、各threadの `postPositions`、`postRecords`、`postCleared` は位置の昇順に出力します。現行TypeScript版の `threadId` 順は実行環境の `localeCompare` に依存するため、非ASCIIの並び順をプロトコル上の意味として利用しないでください。filtersは競合比較順の昇順です。

## 9. ローカルファイル形式

TypeScript版の既定レイアウトです。

```text
<root>/
  devices/
    <deviceId>/
      snapshot.json
      events/
        <segmentId>.jsonl
```

TypeScript版が新規作成する `segmentId` は次の形です。

```text
<13桁にゼロ埋めしたUnix time milliseconds>-<UUID>
```

他言語版は安全な識別子の条件と一意性、安定した列挙順を満たせば別形式の `segmentId` も使用できます。ただし同じ `deviceId` のwriterを複数実装で共有してはいけません。

既定では1セグメント最大1,000イベントです。これは書き込み側のローテーション設定であり、同期で受け取るセグメントを1,000件超という理由だけで拒否してはいけません。

## 10. 利用APIの対応

言語らしい命名や同期・非同期モデルへ変えて構いません。少なくとも次の能力を提供するとTypeScript版と同等に使えます。

- 複数イベントを一括生成してappend
- 各イベント種別の簡易メソッド
- 全スレッド状態と単一スレッド状態の取得
- 全フィルターとscope指定フィルターの取得
- 任意のEventStoreとの双方向同期
- 保持オプション付きcompact
- hostnameの小文字化と末尾ドット除去（URLのuserinfo・portは除く）

新規イベント生成時は、イベントIDを1回だけ生成し、時刻も1回だけ取得します。保存が失敗した再試行で別IDのイベントを増やさない設計が望まれます。

## 11. 最小適合テスト

他言語版には少なくとも次のテストを用意してください。

### 11.1 同時刻の競合

入力:

```jsonl
{"v":2,"id":"favorite-a","deviceId":"device-a","occurredAt":"2026-09-20T00:00:00.000Z","threadId":"thread-1","type":"thread.favorite.set","level":1}
{"v":2,"id":"favorite-b","deviceId":"device_a","occurredAt":"2026-09-20T00:00:00.000Z","threadId":"thread-1","type":"thread.favorite.set","level":5}
```

期待値: `device_a` はASCII辞書順で `device-a` より大きいため、`favoriteLevel` は `5`。

### 11.2 閲覧位置とviewport

入力:

```jsonl
{"v":2,"id":"view-new-position","deviceId":"desktop","occurredAt":"2026-09-20T00:00:00.000Z","threadId":"thread-1","type":"thread.viewed","position":120,"firstPosition":100}
{"v":2,"id":"view-new-time","deviceId":"desktop","occurredAt":"2026-09-20T00:01:00.000Z","threadId":"thread-1","type":"thread.viewed","position":80,"firstPosition":70}
```

期待値:

```json
{"threadId":"thread-1","lastReadPosition":120,"firstReadPosition":70,"lastViewedAt":"2026-09-20T00:01:00.000Z","postPositions":[]}
```

`lastReadPosition` は最大値、`firstReadPosition` は最新viewed由来である点を確認します。

### 11.3 削除後の復活防止と再追加

同じスレッド・位置に対して、時刻順に recorded(古い端末)、cleared(新しい端末) を適用すると位置は非表示でtombstoneが残ります。その後にさらに新しいrecordedを適用すると位置は再表示されます。favoriteとfilterについても同じパターンをテストします。

### 11.4 history epoch

viewed(position=10)、responseCount=20、history cleared、古い時刻のviewed(position=100)、新しい時刻のviewed(position=3)を入力します。期待値は `lastReadPosition=3`、古い `position=100` と削除前のレス数は無効です。favoriteとpostPositionsはhistory clear前の値でも残ることを確認します。

### 11.5 セグメント同期

- `[e1]` と `[e1,e2]` を同期すると両方 `[e1,e2]`
- `[e1,e2]` と `[e1,e3]` は分岐エラー
- 同期をもう一度実行するとコピー件数0
- 同じイベントIDで異なる内容を読むと衝突エラー

### 11.6 snapshot

- revision 2の後にrevision 1を書いてもrevision 2が残る
- 同revision同内容は成功し、同revision異内容は衝突エラー
- snapshotが記録した `eventCount` よりセグメントが伸びていたらpruneしない
- 全スレッド横断の書き込み位置上限と30日保持を確認する

TypeScript版のストレージ実装を同じランタイム内で追加する場合は、`src/event-store.contract.ts` の `registerEventStoreContractTests` を利用できます。他言語版では同ファイルのシナリオを移植してください。

## 12. 実装チェックリスト

- [ ] v2以外と未知のイベント種別を拒否する
- [ ] 安全な識別子、安全な整数、日時、URLを読み込み時にも検証する
- [ ] 比較はロケール非依存で、時刻・deviceId・eventIdの順に行う
- [ ] JSONキー順を標準順にしてTypeScript版の衝突判定と互換にする
- [ ] イベントIDの重複と内容衝突を区別する
- [ ] tombstoneをcompact後も必要な範囲で残す
- [ ] セグメントを短縮・上書き・暗黙マージしない
- [ ] snapshot revisionを単調増加させる
- [ ] coverageの件数が一致するセグメントだけをpruneする
- [ ] snapshotでcoverage済みのイベント接頭辞を状態へ再適用しない
- [ ] 同一 `deviceId` を複数writerで使用しない
- [ ] 同期の冪等性、オフライン端末との再同期、同時刻競合をテストする

## 13. 参照実装

仕様の対応箇所は次のとおりです。

| 関心事 | TypeScript参照実装 |
| --- | --- |
| 公開型・既定値 | `src/types.ts` |
| 検証 | `src/validation.ts` |
| 状態射影・競合解決・snapshot生成 | `src/project.ts` |
| EventStore境界 | `src/store.ts` |
| ローカルファイル保存 | `src/local-event-store.ts` |
| 双方向同期 | `src/synchronize.ts` |
| 利用API・イベント生成・compact | `src/bbsync.ts` |
| EventStore適合シナリオ | `src/event-store.contract.ts` |

実装とこの文書に差が見つかった場合は、同じschema version内では既存データとの互換性を優先し、参照実装の挙動をテストで固定してから文書を更新してください。破壊的な意味変更は新しいschema versionとして設計します。
