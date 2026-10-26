<!-- Stick：無料の棒人間アニメーション作成ソフト -->
<p align="center">
  <a href="https://blixvip.github.io/stick/#tour"><img src="../media/stick-banner.png" alt="Stick：無料の棒人間アニメーション作成ソフト" width="100%"></a>
</p>

<h1 align="center">Stick：無料の棒人間アニメーション作成ソフト</h1>

<p align="center">
  <b>ポーズを付けて、キーフレームを打って、描いて、書き出す。</b><br>Stick は Windows・Linux・ブラウザで動く、無料でオープンソースの棒人間アニメーションソフトです。<br>バトル、歩きのループ、ミーム、ショートアニメを作って MP4・GIF・PNG で書き出せます。
</p>

<p align="center">
  <a href="https://github.com/blixvip/stick/stargazers"><img src="https://img.shields.io/github/stars/blixvip/stick?style=for-the-badge&logo=github&color=EEF2FF&labelColor=050507" alt="GitHub stars"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-EEF2FF?style=for-the-badge&labelColor=050507" alt="GPL-3.0"></a>
  <img src="https://img.shields.io/badge/Windows%20%C2%B7%20Linux%20%C2%B7%20Web-EEF2FF?style=for-the-badge&labelColor=050507" alt="Windows · Linux · Web">
</p>

<p align="center">
  <a href="https://blixvip.github.io/stick/#tour"><b>▶ 2 分の紹介動画</b></a> ·
  <a href="#stick-を入手">Stick を入手</a> ·
  <a href="#機能">機能</a> ·
  <a href="#ギャラリー">ギャラリー</a> ·
  <a href="#よくある質問">よくある質問</a> ·
  <a href="#ソースからビルド">ソースからビルド</a>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <b>日本語</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <img src="../media/stick-hero.gif" alt="Stick：無料の棒人間アニメーション作成ソフト" width="90%">
</p>

## Stick とは？

**Stick** は**棒人間アニメーション**のためのデスクトップ／Web アプリです。関節をドラッグしてポーズを付け、フレームを追加してポーズを変えると、その間の動きを Stick が自動で補間します。レイヤー付きタイムライン、オニオンスキン、カメラワーク、エフェクト、手描きブラシ、オリジナルキャラクター用のリグビルダーを備えています。

**Pivot Animator**（`.piv`・`.stk`）や **Stick Nodes** のプロジェクトも開けるので、過去の作品をそのまま続きから編集できます。処理はすべて自分のパソコン上で行われ、アカウント不要、透かしなし、アップロードもありません。

## 機能

<table>
<tr>
<td width="50%" valign="top">

### どの関節でもポーズ
手足をドラッグするだけで、IK（インバースキネマティクス）がひじとひざを自然に曲げます。角度ロック、伸縮ノード、3D パーツにも対応。

<img src="../media/pose.gif" alt="どの関節でもポーズ · Stick" width="100%">

</td>
<td width="50%" valign="top">

### キーフレームと再生
フレームを追加してポーズを変え、再生するだけ。補間、イージング、リアルタイム WebGPU 再生で長いアニメもなめらか。

<img src="../media/play.gif" alt="キーフレームと再生 · Stick" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 本格的なタイムライン
シンプルなフレーム表示と、レイヤー・フォルダー・キー・イージング・再生範囲・オニオンスキン・音声トラックを備えた詳細タイムライン。

<img src="../media/timeline.gif" alt="本格的なタイムライン · Stick" width="100%">

</td>
<td width="50%" valign="top">

### 内蔵エフェクト
グロー、オーラ、影、ぼかし、パーティクル、エネルギービーム、爆発、煙、パワーアップ。フレームごとにキー設定できます。

<img src="../media/effects.gif" alt="内蔵エフェクト · Stick" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

### どのフレームにも手描き
インク、筆ペン、鉛筆、ライナー、マーカー、木炭、エアブラシ、チョーク、油彩など。手描きとリグを自由に組み合わせられます。

<img src="../media/draw.gif" alt="どのフレームにも手描き · Stick" width="100%">

</td>
<td width="50%" valign="top">

### オリジナルのリグを作成
線、円、多角形、テキスト、画像からキャラクターを作成。歯車、扇子、木箱、3D 図形などのサンプルから始められます。

<img src="../media/build.gif" alt="オリジナルのリグを作成 · Stick" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

### すべてのコマンドを検索
<kbd>F1</kbd> または <kbd>Ctrl</kbd>+<kbd>P</kbd> でどんなコマンドも検索。ショートカットはすべて変更できます。

<img src="../media/command-search.gif" alt="すべてのコマンドを検索 · Stick" width="100%">

</td>
<td width="50%" valign="top">

### ダーク／ライト、27 言語
標準はダークテーマ、ライトテーマにも切り替え可能。UI スケールとタブレット向けタッチレイアウトに対応。

<img src="../media/settings.gif" alt="ダーク／ライト、27 言語 · Stick" width="100%">

</td>
</tr>
</table>

### どこへでも書き出し

**YouTube**、**YouTube ショート**、**TikTok**、**Instagram リール**、**X**、チャット用 **GIF**、透過 PNG 連番、4K のワンクリックプリセット。**MP4**、**WebM**（透過対応）、**GIF**、**APNG**、**PNG / JPEG / SVG** 連番、編集可能な `.piv`・`.stk` を書き出せます。

<p align="center">
  <img src="../media/export.gif" alt="どこへでも書き出し · Stick" width="90%">
</p>

## ギャラリー

<table>
<tr>
<td><img src="../media/screenshot-animate.jpg" alt="Stick · Stick：無料の棒人間アニメーション作成ソフト"></td>
<td><img src="../media/screenshot-effects.jpg" alt="Stick · Stick：無料の棒人間アニメーション作成ソフト"></td>
</tr>
<tr>
<td><img src="../media/screenshot-draw.jpg" alt="Stick · Stick：無料の棒人間アニメーション作成ソフト"></td>
<td><img src="../media/screenshot-build.jpg" alt="Stick · Stick：無料の棒人間アニメーション作成ソフト"></td>
</tr>
<tr>
<td><img src="../media/screenshot-export.jpg" alt="Stick · Stick：無料の棒人間アニメーション作成ソフト"></td>
<td><img src="../media/screenshot-settings-light.jpg" alt="Stick · Stick：無料の棒人間アニメーション作成ソフト"></td>
</tr>
</table>

## Stick を入手

- **自分でビルド**：数コマンドで完了します。[ソースからビルド](#ソースからビルド)を参照。デスクトップアプリとしても、ブラウザでも動きます。
- **インストーラー**：Windows（セットアップ版・ポータブル版）と Linux（AppImage）版は [Releases ページ](https://github.com/blixvip/stick/releases)で公開します。**Watch → Custom → Releases** で更新通知を受け取れます。
- **まずは動画で**：[2 分の紹介動画](https://blixvip.github.io/stick/#tour)。

⭐ **このリポジトリにスターを付けて**、新しいリリースをフォローし、より多くのアニメーターに Stick を届けてください。

## よくある質問

<details>
<summary><b>Stick は無料ですか？</b></summary>

はい。GPL-3.0 ライセンスの無料オープンソースソフトです。アカウント登録、透かし、有料プランはありません。
</details>

<details>
<summary><b>Pivot Animator の代わりになりますか？</b></summary>

はい。Pivot Animator のプロジェクト（<code>.piv</code>）とフィギュア（<code>.stk</code>）を開いて書き出すことができ、さらにレイヤー付きタイムライン、補間、エフェクト、手描き、WebGPU 描画が使えます。
</details>

<details>
<summary><b>Stick Nodes のプロジェクトを PC で開けますか？</b></summary>

はい。Stick Nodes のフィギュア、ムービークリップ、プロジェクトを読み込めるので、Windows や Linux のパソコンで続きを作れます。
</details>

<details>
<summary><b>棒人間アニメはどうやって作りますか？</b></summary>

関節をドラッグしてポーズを付け、<b>フレームを追加</b>（<kbd>A</kbd>）してポーズを変え、<kbd>スペース</kbd>で再生します。フレーム間の動きは Stick が補間します。最後に<b>書き出し</b>で MP4、GIF、TikTok などのプリセットを選びます。
</details>

<details>
<summary><b>オフラインで使えますか？作品はアップロードされますか？</b></summary>

完全にオフラインで使えます。プロジェクトは自分のパソコンにだけ保存され、アップロードされません。
</details>

## ソースからビルド

必要環境：Node.js 22 以上、Python 3.11 以上。

```sh
git clone https://github.com/blixvip/stick.git
cd stick
npm ci
python -m pip install -r backend/requirements-fast.txt
npm start            # デスクトップアプリ（Electron）
npm run serve        # またはブラウザでエディターを開く: http://127.0.0.1:47831
```

## ライセンス

Stick は [GNU 一般公衆利用許諾書 v3.0](../../LICENSE)（またはそれ以降）のもとで公開されている自由ソフトウェアです。GPL ライセンスの StykAnimate プロジェクトを改変したもので、ライセンスの定めによりこの表記を残しています。Stick は独立したプロジェクトであり、Pivot Animator や Stick Nodes とは提携していません。これらの名称はファイル互換性の説明のためにのみ使用しています。

<p align="center">
  <img src="../../assets/brand/svg/stick-app-icon-dark.svg" alt="Stick" width="72"><br>
  <sub><b>Stick</b> · 無料の棒人間アニメーションソフト · Windows・Linux・Web 対応のスティックマンアニメーター</sub>
</p>
