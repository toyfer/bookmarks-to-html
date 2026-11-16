# bookmarks-to-html
- 分野: web-tool / 状態: active / 後継・前身: なし

## これは何か

ブラウザのブックマークファイルを、どのブラウザでもインポートできる **Netscape 形式 HTML** に変換する、単一 `index.html` の静的Webツールです。ブックマークの中身がサーバーへ送信されることはありません（全処理をブラウザ内で完結）。

対応する入力:

| 入力 | 備考 |
|---|---|
| Chrome / Edge / Brave の `Bookmarks` | 拡張子なしファイルもそのまま選択可能 |
| Firefox の JSON / `.jsonlz4` | バックアップファイル（内容をその場で解凍して解析） |
| Safari の `Bookmarks.plist` | XML とバイナリの両形式に対応 |
| 既存の Netscape 形式 HTML / 一般的な HTML | `<A HREF>` を走査 |
| CSV / TSV | ヘッダ行（Title / URL / Folder / Tags など、英語・日本語）から列を自動判定 |
| Markdown | 見出しがフォルダ、リンクがブックマーク |
| URL リスト（OneTab 等の貼り付け含む） | 1行1URL |

変換時の処理:

- **フォルダ構造**を保持 / 1フォルダへ集約 / 平坦化 から選べます
- **重複URL**は「そのまま / フォルダ内除去 / 全体除去」から選べます
- 空フォルダの省略、追加日時の保持を切り替えられます
- `chrome:` / `edge:` / `place:` などのブラウザ内部URLは、他ブラウザで開けないため自動で除外します
- 出力は UTF-8（BOMなし）の Netscape Bookmark File 形式（`<!DOCTYPE NETSCAPE-Bookmark-file-1>`）で、未圧縮のテキストのためメールやチャットでも送れます

## 使い方

1. 下記URLを開きます: <https://toyfer.github.io/bookmarks-to-html/>
2. ブックマークファイルをドロップ、または「ファイルを選択」から選びます（拡張子なしの `Bookmarks` も可。複数選択も可）
3. フォルダ構造と重複の扱いを選んで、**HTMLをダウンロード**（またはHTMLをコピー）
4. 任意のブラウザのブックマークインポートで、そのHTMLを読み込む

ファイルの場所の目安:

- Chrome: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Bookmarks`
- Edge: `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Bookmarks`
- Safari: `~/Library/Safari/Bookmarks.plist`

ブラウザを閉じてから読むと、記録中のファイルではなく最新の内容が得られます。Chrome / Edge / Firefox / Safari はいずれも Netscape 形式 HTML をインポートできます。

## 状態と今後

- ビルド不要（`index.html` 1本で完結）。`engine.js` は開発用の内製ソースで、`index.html` にインライン済みのため公開には不要です
- GitHub Pages は **Settings → Pages** で Source を `Deploy from a branch` / Branch `main` / folder `/ (root)` に設定してください（本リポジトリはリモート側で Pages を有効化できませんでした）
- 既存ブックマークをその形式のまま再利用したいだけなら、上記のいずれかのブラウザの標準エクスポートでも十分です。本ツールは「別フォーマット同士の相互変換」「複数ファイルのマージ」「重複整理」が主な用途です

## ライセンス

MIT License
