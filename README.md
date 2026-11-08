# Folio PDF

Windows 11向けのローカルPDFビューアです。Electron・React・TypeScriptで作成しています。

## 使い始める

GitHubのReleasesから `Folio PDF Setup 0.1.2.exe` をダウンロードして実行してください。公開されたReleaseはGitHubへのログインなしでダウンロードできます。

ローカルでビルドした場合は `release/0.1.2/Folio PDF Setup 0.1.2.exe` が生成されます。
インストールせず試す場合は `release/0.1.2/win-unpacked/Folio PDF.exe` を実行できます。この場合は `win-unpacked` フォルダー全体を保持してください。

- PDFを開く：Ctrl+O、ファイルのドロップ、関連付け後のダブルクリック。
- サムネイルでページ移動。Ctrl+Fで文書全体を検索。
- Ctrl+ホイールで25〜1600%の拡大縮小。Space+ドラッグ・中ボタンドラッグで移動。
- ページ整理で並べ替え・削除・回転・抽出。Ctrl・Shiftで複数選択。
- Ctrl+Sで名前を付けて保存。編集を原本へ自動上書きしません。
- 「結合」で複数PDFを追加し、順番を指定して保存。
- 右上の矢印ボタンでPDFを別ウィンドウへ移動・取り込み。
- 設定から外観、タブ／ウィンドウの既定動作、セッション復元を変更できます。
- Ctrl+Pで印刷。詳細設定はWindowsとプリンタードライバーに任せます。

## 描画

PDF.jsの部分描画・詳細キャンバスを利用します。操作中は既存の描画で追従し、表示範囲を画面密度に合わせて再描画します。大判図面の全体を巨大なキャンバスへ展開しません。画像だけのPDFの細部は元画像の解像度が上限です。

## 初期版の制限

- OCR・注釈作成・本文編集・電子署名検証には対応しません。
- 暗号化・署名・編集制限のあるPDFは閲覧中心の対応です。
- ページ編集・結合では既存のしおり・フォーム・内部リンクなどを完全には保持できません。保存前に案内します。
- 印刷用ページは150dpiの画像として準備します。実プリンター固有の余白、倍率、両面、混在用紙サイズは実機での確認が必要です。
- 通常終了の保存確認と閲覧状態の復元に対応します。未保存編集の異常終了からの復旧は対象外です。
- 初期ビルドはコード署名を付けていません。

## 開発

Node.js 24以降とpnpmを使用します。

```powershell
pnpm install
pnpm dev
pnpm build
pnpm start
pnpm test
pnpm test:smoke
pnpm test:integration
pnpm test:quality
pnpm dist:win
```

`test:integration` は物理印刷の最終呼び出しをPDF保存に置き換えます。実プリンターへは送信しません。テストは独立したユーザーデータ領域を使います。

仕様：[docs/specification.md](docs/specification.md)。検証結果：[docs/validation.md](docs/validation.md)。
