// Writes docs/readme/README.<lang>.md from one template so every translation
// keeps the same media, links and structure as README.md. Run after editing:
//
//   node scripts/build-readme-translations.mjs
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '..'), out = path.join(root, 'docs/readme');
const REPO = 'https://github.com/blixvip/stick', VIDEO = 'https://blixvip.github.io/stick/#tour';
export {REPO, VIDEO};
export const LANGS = [['en', 'English', '../../README.md'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'],
  ['es', 'Español'], ['pt-BR', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['ru', 'Русский']];

export const T = {
  en: {
    title: 'Stick: free stick figure animation software',
    lead: '<b>Pose it. Keyframe it. Draw on it. Export it.</b><br>Stick is a free, open-source stick figure animator for Windows, Linux and the browser.<br>Make stickman fights, walk cycles, memes and short films, then export MP4, GIF or PNG.',
    nav: ['▶ Watch the 2-minute tour', 'Get Stick', 'Features', 'Gallery', 'FAQ', 'Build from source'],
    whatH: 'What is Stick?',
    what: '**Stick** is a desktop and web app for **stick figure animation**. You drag a figure’s joints to pose it, add a frame, pose it again, and Stick fills the motion in between. It has a real timeline with layers, onion skin, camera moves, visual effects, brushes for hand-drawn frames, and a rig builder for custom characters.\n\nIt opens **Pivot Animator** (`.piv`, `.stk`) and **Stick Nodes** projects, so you can bring your old animations with you. Everything runs on your own computer: no account, no watermark, no uploads.',
    featH: 'Features',
    feats: [
      ['Pose any joint', 'Drag hands and feet; inverse kinematics bends elbows and knees for you. Lock angles, stretch nodes and pose 3D parts in depth.'],
      ['Keyframe and play', 'Add a frame, change the pose, hit play. Tweens, easing curves and real-time WebGPU playback keep long animations smooth.'],
      ['A real animation timeline', 'Simple frame strip or Advanced timeline with layers, folders, keys, easing, playback ranges, onion skin and audio tracks.'],
      ['Built-in effects', 'Glow, aura, shadow, blur, particles, energy beams, explosions, smoke and power-ups, keyframeable per frame.'],
      ['Draw on any frame', 'Ink, brush pen, pencil, liner, marker, charcoal, airbrush, chalk, oil and more. Mix hand-drawn art with your rigs.'],
      ['Build your own rigs', 'Make characters from lines, circles, polygons, text and images. Start from examples like gears, fans, crates and 3D shapes.'],
      ['Every command, one search away', 'Press <kbd>F1</kbd> or <kbd>Ctrl</kbd>+<kbd>P</kbd> to find any command. Every shortcut can be remapped.'],
      ['Light or dark, in 27 languages', 'A dark theme by default, a light theme when you want it, adjustable UI scale and a touch layout for tablets.'],
    ],
    exportH: 'Export anywhere',
    export: 'One-click presets for **YouTube**, **YouTube Shorts**, **TikTok**, **Instagram Reels**, **X**, chat **GIFs**, transparent PNG frames and 4K. Export **MP4**, **WebM** (with transparency), **GIF**, **APNG**, **PNG / JPEG / SVG** sequences, or editable `.piv` and `.stk` files.',
    galleryH: 'Gallery',
    getH: 'Get Stick',
    get: [`**Build it yourself** in a few commands; see [Build from source](#build-from-source). It runs as a desktop app or in your browser.`, `**Installers:** Windows (Setup and Portable) and Linux (AppImage) builds go on the [Releases page](${REPO}/releases). Click **Watch → Custom → Releases** to get notified.`, `**Watch it first:** the [2-minute video tour](${VIDEO}).`],
    star: '⭐ **Star the repository** to follow new releases and help other animators find Stick.',
    faqH: 'FAQ',
    faq: [
      ['Is Stick free?', 'Yes. Stick is free and open source under the GPL-3.0 license. There is no account, no watermark and no paid tier.'],
      ['Is Stick a Pivot Animator alternative?', 'Yes. Stick opens Pivot Animator projects (<code>.piv</code>) and figures (<code>.stk</code>), and can export them back. It adds a layered timeline, tweening, effects, drawing and a modern WebGPU renderer.'],
      ['Can I open Stick Nodes projects on PC?', 'Yes. Stick imports Stick Nodes figures, movieclips and projects, so you can keep working on a Windows or Linux computer.'],
      ['How do I make a stick figure animation?', 'Pose the figure by dragging its joints, press <b>Add frame</b> (<kbd>A</kbd>), change the pose, and press <kbd>Space</kbd> to play. Stick tweens the motion between frames. Then click <b>Export</b> and choose MP4, GIF or a preset like TikTok.'],
      ['Does it work offline? Does it upload my animations?', 'It works fully offline. Your projects stay on your computer; nothing is uploaded.'],
    ],
    buildH: 'Build from source',
    buildReq: 'Requirements: Node.js 22+ and Python 3.11+.',
    buildCmt: ['desktop app (Electron)', 'or the editor in your browser'],
    licenseH: 'License',
    license: 'Stick is free software under the [GNU General Public License v3.0](../../LICENSE) or later. It is a modified version of the GPL-licensed StykAnimate project; this notice is kept as the license requires. Stick is an independent project and is not affiliated with or endorsed by Pivot Animator or Stick Nodes; those names describe file compatibility only.',
    footer: 'free stick figure animation software · stickman animator for Windows, Linux and the web',
  },
  'zh-CN': {
    title: 'Stick：免费的火柴人动画制作软件',
    lead: '<b>摆姿势、打关键帧、手绘、导出。</b><br>Stick 是一款免费开源的火柴人动画软件，支持 Windows、Linux 和浏览器。<br>制作火柴人打斗、走路循环、表情包和动画短片，并导出 MP4、GIF 或 PNG。',
    nav: ['▶ 观看 2 分钟演示', '获取 Stick', '功能', '截图', '常见问题', '从源码构建'],
    whatH: '什么是 Stick？',
    what: '**Stick** 是一款用于制作**火柴人动画**的桌面和网页应用。拖动关节摆出姿势，添加一帧，再换个姿势，Stick 会自动补间中间的动作。它拥有带图层的时间轴、洋葱皮、镜头运动、视觉特效、手绘笔刷，以及用于自定义角色的骨骼编辑器。\n\n它可以打开 **Pivot Animator**（`.piv`、`.stk`）和 **Stick Nodes** 项目，旧作品可以直接继续编辑。所有操作都在你的电脑上完成：无需账号、没有水印、不会上传。',
    featH: '功能',
    feats: [
      ['随心摆姿势', '拖动手和脚，反向动力学（IK）会自动弯曲手肘和膝盖。支持角度锁定、可伸缩节点和 3D 部件。'],
      ['关键帧与播放', '添加一帧、改变姿势、点击播放。补间、缓动曲线和实时 WebGPU 播放让长动画依然流畅。'],
      ['专业时间轴', '简单帧条或高级时间轴：图层、文件夹、关键帧、缓动、播放范围、洋葱皮和音轨。'],
      ['内置特效', '发光、光环、阴影、模糊、粒子、能量光束、爆炸、烟雾和能量提升，可逐帧设置关键帧。'],
      ['在任意帧上手绘', '墨水、毛笔、铅笔、针管笔、马克笔、炭笔、喷枪、粉笔、油画等笔刷，手绘与骨骼动画自由混合。'],
      ['打造自己的角色', '用线条、圆形、多边形、文字和图片制作角色，可从齿轮、折扇、箱子和 3D 形状等示例开始。'],
      ['一键搜索所有命令', '按 <kbd>F1</kbd> 或 <kbd>Ctrl</kbd>+<kbd>P</kbd> 查找任何命令，所有快捷键都可自定义。'],
      ['深色或浅色，27 种语言', '默认深色主题，也可切换浅色；支持界面缩放和平板触控布局。'],
    ],
    exportH: '随处导出',
    export: '一键预设：**YouTube**、**YouTube Shorts**、**抖音 / TikTok**、**Instagram Reels**、**X**、聊天用 **GIF**、透明 PNG 序列和 4K。支持导出 **MP4**、**WebM**（含透明通道）、**GIF**、**APNG**、**PNG / JPEG / SVG** 序列，以及可编辑的 `.piv` 和 `.stk` 文件。',
    galleryH: '截图',
    getH: '获取 Stick',
    get: [`**自行构建**：只需几条命令，见[从源码构建](#从源码构建)。可作为桌面应用运行，也可在浏览器中运行。`, `**安装包**：Windows（安装版和便携版）与 Linux（AppImage）版本发布在 [Releases 页面](${REPO}/releases)。点击 **Watch → Custom → Releases** 获取更新通知。`, `**先看演示**：[2 分钟视频介绍](${VIDEO})。`],
    star: '⭐ **给本仓库点个 Star**，关注新版本，也让更多动画爱好者发现 Stick。',
    faqH: '常见问题',
    faq: [
      ['Stick 免费吗？', 'Stick 完全免费，基于 GPL-3.0 协议开源。无需账号，没有水印，也没有付费版本。'],
      ['Stick 可以替代 Pivot Animator 吗？', '可以。Stick 能打开 Pivot Animator 的项目（<code>.piv</code>）和人物（<code>.stk</code>），也能导出回去，并新增了分层时间轴、补间、特效、手绘和现代 WebGPU 渲染。'],
      ['能在电脑上打开 Stick Nodes 项目吗？', '可以。Stick 支持导入 Stick Nodes 的人物、影片剪辑和项目，可以在 Windows 或 Linux 电脑上继续制作。'],
      ['如何制作火柴人动画？', '拖动关节摆好姿势，按 <b>添加帧</b>（<kbd>A</kbd>），改变姿势，然后按 <kbd>空格</kbd> 播放。Stick 会补间两帧之间的动作。最后点击 <b>导出</b>，选择 MP4、GIF 或 TikTok 等预设。'],
      ['可以离线使用吗？会上传我的作品吗？', '完全支持离线使用。你的项目只保存在自己的电脑上，不会上传。'],
    ],
    buildH: '从源码构建',
    buildReq: '环境要求：Node.js 22+ 和 Python 3.11+。',
    buildCmt: ['桌面应用（Electron）', '或在浏览器中打开编辑器'],
    licenseH: '许可证',
    license: 'Stick 是基于 [GNU 通用公共许可证 v3.0](../../LICENSE)（或更高版本）发布的自由软件。它是 GPL 许可的 StykAnimate 项目的修改版本，按许可证要求保留此声明。Stick 是独立项目，与 Pivot Animator 和 Stick Nodes 无关联，提及这些名称仅为说明文件兼容性。',
    footer: '免费火柴人动画软件 · 支持 Windows、Linux 和网页的火柴人动画制作工具',
  },
  'zh-TW': {
    title: 'Stick：免費的火柴人動畫製作軟體',
    lead: '<b>擺姿勢、設關鍵影格、手繪、匯出。</b><br>Stick 是一款免費開源的火柴人動畫軟體，支援 Windows、Linux 和瀏覽器。<br>製作火柴人打鬥、走路循環、迷因和動畫短片，並匯出 MP4、GIF 或 PNG。',
    nav: ['▶ 觀看 2 分鐘導覽', '取得 Stick', '功能', '截圖', '常見問題', '從原始碼建置'],
    whatH: 'Stick 是什麼？',
    what: '**Stick** 是一款用來製作**火柴人動畫**的桌面與網頁應用程式。拖曳關節擺出姿勢，新增一個影格，再換個姿勢，Stick 就會自動補間中間的動作。它擁有含圖層的時間軸、洋蔥皮、鏡頭運動、視覺特效、手繪筆刷，以及自訂角色的骨架編輯器。\n\n它可以開啟 **Pivot Animator**（`.piv`、`.stk`）與 **Stick Nodes** 專案，舊作品能直接繼續編輯。所有處理都在你的電腦上完成：不需帳號、沒有浮水印、不會上傳。',
    featH: '功能',
    feats: [
      ['隨心擺姿勢', '拖曳手腳，反向運動學（IK）會自動彎曲手肘和膝蓋。支援角度鎖定、可伸縮節點和 3D 部件。'],
      ['關鍵影格與播放', '新增影格、改變姿勢、按下播放。補間、緩動曲線與即時 WebGPU 播放讓長動畫依然流暢。'],
      ['專業時間軸', '簡易影格條或進階時間軸：圖層、資料夾、關鍵影格、緩動、播放範圍、洋蔥皮與音軌。'],
      ['內建特效', '發光、光環、陰影、模糊、粒子、能量光束、爆炸、煙霧與能量提升，可逐格設定關鍵影格。'],
      ['在任何影格上手繪', '墨水、毛筆、鉛筆、代針筆、麥克筆、炭筆、噴槍、粉筆、油畫等筆刷，手繪與骨架動畫自由混合。'],
      ['打造自己的角色', '用線條、圓形、多邊形、文字和圖片製作角色，可從齒輪、摺扇、箱子與 3D 形狀等範例開始。'],
      ['一鍵搜尋所有指令', '按 <kbd>F1</kbd> 或 <kbd>Ctrl</kbd>+<kbd>P</kbd> 找到任何指令，所有快捷鍵都能自訂。'],
      ['深色或淺色，27 種語言', '預設深色主題，也可切換淺色；支援介面縮放與平板觸控版面。'],
    ],
    exportH: '隨處匯出',
    export: '一鍵預設：**YouTube**、**YouTube Shorts**、**TikTok**、**Instagram Reels**、**X**、聊天用 **GIF**、透明 PNG 序列與 4K。可匯出 **MP4**、**WebM**（含透明）、**GIF**、**APNG**、**PNG / JPEG / SVG** 序列，以及可編輯的 `.piv` 與 `.stk` 檔案。',
    galleryH: '截圖',
    getH: '取得 Stick',
    get: [`**自行建置**：只要幾個指令，請見[從原始碼建置](#從原始碼建置)。可作為桌面應用程式執行，也能在瀏覽器中執行。`, `**安裝檔**：Windows（安裝版與可攜版）和 Linux（AppImage）版本發布在 [Releases 頁面](${REPO}/releases)。點選 **Watch → Custom → Releases** 取得更新通知。`, `**先看示範**：[2 分鐘影片導覽](${VIDEO})。`],
    star: '⭐ **為本儲存庫按下 Star**，追蹤新版本，也讓更多動畫創作者發現 Stick。',
    faqH: '常見問題',
    faq: [
      ['Stick 免費嗎？', 'Stick 完全免費，採用 GPL-3.0 授權開源。不需帳號，沒有浮水印，也沒有付費版本。'],
      ['Stick 可以取代 Pivot Animator 嗎？', '可以。Stick 能開啟 Pivot Animator 的專案（<code>.piv</code>）與人物（<code>.stk</code>），也能匯出回去，並加入分層時間軸、補間、特效、手繪與現代 WebGPU 繪圖。'],
      ['可以在電腦上開啟 Stick Nodes 專案嗎？', '可以。Stick 能匯入 Stick Nodes 的人物、影片片段與專案，讓你在 Windows 或 Linux 電腦上繼續創作。'],
      ['要怎麼製作火柴人動畫？', '拖曳關節擺好姿勢，按 <b>新增影格</b>（<kbd>A</kbd>），改變姿勢，再按 <kbd>空白鍵</kbd> 播放。Stick 會補間影格之間的動作。最後按 <b>匯出</b>，選擇 MP4、GIF 或 TikTok 等預設。'],
      ['可以離線使用嗎？會上傳我的作品嗎？', '完全可以離線使用。你的專案只存在自己的電腦上，不會上傳。'],
    ],
    buildH: '從原始碼建置',
    buildReq: '需求：Node.js 22+ 與 Python 3.11+。',
    buildCmt: ['桌面應用程式（Electron）', '或在瀏覽器中開啟編輯器'],
    licenseH: '授權',
    license: 'Stick 是依 [GNU 通用公共授權條款 v3.0](../../LICENSE)（或更新版本）發布的自由軟體。它是採 GPL 授權的 StykAnimate 專案之修改版本，依授權要求保留此聲明。Stick 為獨立專案，與 Pivot Animator 和 Stick Nodes 無關，提及這些名稱僅為說明檔案相容性。',
    footer: '免費火柴人動畫軟體 · 支援 Windows、Linux 與網頁的火柴人動畫工具',
  },
  ja: {
    title: 'Stick：無料の棒人間アニメーション作成ソフト',
    lead: '<b>ポーズを付けて、キーフレームを打って、描いて、書き出す。</b><br>Stick は Windows・Linux・ブラウザで動く、無料でオープンソースの棒人間アニメーションソフトです。<br>バトル、歩きのループ、ミーム、ショートアニメを作って MP4・GIF・PNG で書き出せます。',
    nav: ['▶ 2 分の紹介動画', 'Stick を入手', '機能', 'ギャラリー', 'よくある質問', 'ソースからビルド'],
    whatH: 'Stick とは？',
    what: '**Stick** は**棒人間アニメーション**のためのデスクトップ／Web アプリです。関節をドラッグしてポーズを付け、フレームを追加してポーズを変えると、その間の動きを Stick が自動で補間します。レイヤー付きタイムライン、オニオンスキン、カメラワーク、エフェクト、手描きブラシ、オリジナルキャラクター用のリグビルダーを備えています。\n\n**Pivot Animator**（`.piv`・`.stk`）や **Stick Nodes** のプロジェクトも開けるので、過去の作品をそのまま続きから編集できます。処理はすべて自分のパソコン上で行われ、アカウント不要、透かしなし、アップロードもありません。',
    featH: '機能',
    feats: [
      ['どの関節でもポーズ', '手足をドラッグするだけで、IK（インバースキネマティクス）がひじとひざを自然に曲げます。角度ロック、伸縮ノード、3D パーツにも対応。'],
      ['キーフレームと再生', 'フレームを追加してポーズを変え、再生するだけ。補間、イージング、リアルタイム WebGPU 再生で長いアニメもなめらか。'],
      ['本格的なタイムライン', 'シンプルなフレーム表示と、レイヤー・フォルダー・キー・イージング・再生範囲・オニオンスキン・音声トラックを備えた詳細タイムライン。'],
      ['内蔵エフェクト', 'グロー、オーラ、影、ぼかし、パーティクル、エネルギービーム、爆発、煙、パワーアップ。フレームごとにキー設定できます。'],
      ['どのフレームにも手描き', 'インク、筆ペン、鉛筆、ライナー、マーカー、木炭、エアブラシ、チョーク、油彩など。手描きとリグを自由に組み合わせられます。'],
      ['オリジナルのリグを作成', '線、円、多角形、テキスト、画像からキャラクターを作成。歯車、扇子、木箱、3D 図形などのサンプルから始められます。'],
      ['すべてのコマンドを検索', '<kbd>F1</kbd> または <kbd>Ctrl</kbd>+<kbd>P</kbd> でどんなコマンドも検索。ショートカットはすべて変更できます。'],
      ['ダーク／ライト、27 言語', '標準はダークテーマ、ライトテーマにも切り替え可能。UI スケールとタブレット向けタッチレイアウトに対応。'],
    ],
    exportH: 'どこへでも書き出し',
    export: '**YouTube**、**YouTube ショート**、**TikTok**、**Instagram リール**、**X**、チャット用 **GIF**、透過 PNG 連番、4K のワンクリックプリセット。**MP4**、**WebM**（透過対応）、**GIF**、**APNG**、**PNG / JPEG / SVG** 連番、編集可能な `.piv`・`.stk` を書き出せます。',
    galleryH: 'ギャラリー',
    getH: 'Stick を入手',
    get: [`**自分でビルド**：数コマンドで完了します。[ソースからビルド](#ソースからビルド)を参照。デスクトップアプリとしても、ブラウザでも動きます。`, `**インストーラー**：Windows（セットアップ版・ポータブル版）と Linux（AppImage）版は [Releases ページ](${REPO}/releases)で公開します。**Watch → Custom → Releases** で更新通知を受け取れます。`, `**まずは動画で**：[2 分の紹介動画](${VIDEO})。`],
    star: '⭐ **このリポジトリにスターを付けて**、新しいリリースをフォローし、より多くのアニメーターに Stick を届けてください。',
    faqH: 'よくある質問',
    faq: [
      ['Stick は無料ですか？', 'はい。GPL-3.0 ライセンスの無料オープンソースソフトです。アカウント登録、透かし、有料プランはありません。'],
      ['Pivot Animator の代わりになりますか？', 'はい。Pivot Animator のプロジェクト（<code>.piv</code>）とフィギュア（<code>.stk</code>）を開いて書き出すことができ、さらにレイヤー付きタイムライン、補間、エフェクト、手描き、WebGPU 描画が使えます。'],
      ['Stick Nodes のプロジェクトを PC で開けますか？', 'はい。Stick Nodes のフィギュア、ムービークリップ、プロジェクトを読み込めるので、Windows や Linux のパソコンで続きを作れます。'],
      ['棒人間アニメはどうやって作りますか？', '関節をドラッグしてポーズを付け、<b>フレームを追加</b>（<kbd>A</kbd>）してポーズを変え、<kbd>スペース</kbd>で再生します。フレーム間の動きは Stick が補間します。最後に<b>書き出し</b>で MP4、GIF、TikTok などのプリセットを選びます。'],
      ['オフラインで使えますか？作品はアップロードされますか？', '完全にオフラインで使えます。プロジェクトは自分のパソコンにだけ保存され、アップロードされません。'],
    ],
    buildH: 'ソースからビルド',
    buildReq: '必要環境：Node.js 22 以上、Python 3.11 以上。',
    buildCmt: ['デスクトップアプリ（Electron）', 'またはブラウザでエディターを開く'],
    licenseH: 'ライセンス',
    license: 'Stick は [GNU 一般公衆利用許諾書 v3.0](../../LICENSE)（またはそれ以降）のもとで公開されている自由ソフトウェアです。GPL ライセンスの StykAnimate プロジェクトを改変したもので、ライセンスの定めによりこの表記を残しています。Stick は独立したプロジェクトであり、Pivot Animator や Stick Nodes とは提携していません。これらの名称はファイル互換性の説明のためにのみ使用しています。',
    footer: '無料の棒人間アニメーションソフト · Windows・Linux・Web 対応のスティックマンアニメーター',
  },
  ko: {
    title: 'Stick: 무료 졸라맨 애니메이션 제작 프로그램',
    lead: '<b>포즈를 잡고, 키프레임을 찍고, 그리고, 내보내세요.</b><br>Stick은 Windows, Linux, 브라우저에서 쓰는 무료 오픈소스 스틱맨 애니메이션 프로그램입니다.<br>졸라맨 싸움, 걷기 사이클, 밈, 단편 애니메이션을 만들고 MP4, GIF, PNG로 내보내세요.',
    nav: ['▶ 2분 소개 영상', 'Stick 받기', '기능', '갤러리', '자주 묻는 질문', '소스에서 빌드'],
    whatH: 'Stick이란?',
    what: '**Stick**은 **졸라맨(스틱맨) 애니메이션**을 위한 데스크톱·웹 앱입니다. 관절을 끌어 포즈를 잡고, 프레임을 추가해 다시 포즈를 바꾸면 그 사이 동작을 Stick이 자동으로 채워 줍니다. 레이어 타임라인, 어니언 스킨, 카메라 무빙, 시각 효과, 손그림 브러시, 나만의 캐릭터를 위한 리그 빌더를 갖추고 있습니다.\n\n**Pivot Animator**(`.piv`, `.stk`)와 **Stick Nodes** 프로젝트도 열 수 있어 예전 작업을 그대로 이어갈 수 있습니다. 모든 작업은 내 컴퓨터에서 처리됩니다. 계정, 워터마크, 업로드가 없습니다.',
    featH: '기능',
    feats: [
      ['모든 관절로 포즈', '손발을 끌기만 하면 IK(역운동학)가 팔꿈치와 무릎을 알아서 굽힙니다. 각도 고정, 늘어나는 노드, 3D 파츠도 지원합니다.'],
      ['키프레임과 재생', '프레임을 추가하고 포즈를 바꾼 뒤 재생하세요. 트윈, 이징 곡선, 실시간 WebGPU 재생으로 긴 애니메이션도 부드럽습니다.'],
      ['제대로 된 타임라인', '간단한 프레임 스트립 또는 레이어, 폴더, 키, 이징, 재생 범위, 어니언 스킨, 오디오 트랙이 있는 고급 타임라인.'],
      ['내장 효과', '글로우, 오라, 그림자, 블러, 파티클, 에너지 빔, 폭발, 연기, 파워업을 프레임별로 키 설정할 수 있습니다.'],
      ['어느 프레임에나 손그림', '잉크, 붓펜, 연필, 라이너, 마커, 목탄, 에어브러시, 분필, 유화 등. 손그림과 리그를 자유롭게 섞으세요.'],
      ['나만의 리그 만들기', '선, 원, 다각형, 텍스트, 이미지로 캐릭터를 만드세요. 톱니바퀴, 부채, 상자, 3D 도형 예제로 시작할 수 있습니다.'],
      ['모든 명령을 한 번에 검색', '<kbd>F1</kbd> 또는 <kbd>Ctrl</kbd>+<kbd>P</kbd>로 어떤 명령이든 찾으세요. 모든 단축키를 바꿀 수 있습니다.'],
      ['다크 또는 라이트, 27개 언어', '기본은 다크 테마, 원하면 라이트 테마. UI 크기 조절과 태블릿용 터치 레이아웃을 지원합니다.'],
    ],
    exportH: '어디로든 내보내기',
    export: '**YouTube**, **YouTube Shorts**, **TikTok**, **Instagram 릴스**, **X**, 채팅용 **GIF**, 투명 PNG 프레임, 4K 원클릭 프리셋. **MP4**, **WebM**(투명 지원), **GIF**, **APNG**, **PNG / JPEG / SVG** 시퀀스와 편집 가능한 `.piv`, `.stk` 파일로 내보낼 수 있습니다.',
    galleryH: '갤러리',
    getH: 'Stick 받기',
    get: [`**직접 빌드**: 명령 몇 줄이면 됩니다. [소스에서 빌드](#소스에서-빌드)를 참고하세요. 데스크톱 앱이나 브라우저에서 실행됩니다.`, `**설치 파일**: Windows(설치판, 포터블)와 Linux(AppImage) 빌드는 [Releases 페이지](${REPO}/releases)에 올라갑니다. **Watch → Custom → Releases**로 알림을 받으세요.`, `**먼저 영상으로**: [2분 소개 영상](${VIDEO}).`],
    star: '⭐ **이 저장소에 Star를 눌러** 새 릴리스를 받아 보고, 더 많은 애니메이터가 Stick을 찾을 수 있게 도와주세요.',
    faqH: '자주 묻는 질문',
    faq: [
      ['Stick은 무료인가요?', '네. GPL-3.0 라이선스의 무료 오픈소스입니다. 계정, 워터마크, 유료 버전이 없습니다.'],
      ['Pivot Animator 대체 프로그램인가요?', '네. Pivot Animator 프로젝트(<code>.piv</code>)와 피규어(<code>.stk</code>)를 열고 다시 내보낼 수 있으며, 레이어 타임라인, 트윈, 효과, 손그림, WebGPU 렌더링이 추가되어 있습니다.'],
      ['PC에서 Stick Nodes 프로젝트를 열 수 있나요?', '네. Stick Nodes 피규어, 무비클립, 프로젝트를 가져와 Windows나 Linux 컴퓨터에서 계속 작업할 수 있습니다.'],
      ['졸라맨 애니메이션은 어떻게 만드나요?', '관절을 끌어 포즈를 잡고 <b>프레임 추가</b>(<kbd>A</kbd>)를 누른 뒤 포즈를 바꾸고 <kbd>스페이스</kbd>로 재생하세요. 프레임 사이 동작은 Stick이 채웁니다. 마지막으로 <b>내보내기</b>에서 MP4, GIF, TikTok 같은 프리셋을 고르세요.'],
      ['오프라인에서도 되나요? 작품이 업로드되나요?', '완전히 오프라인으로 작동합니다. 프로젝트는 내 컴퓨터에만 저장되고 업로드되지 않습니다.'],
    ],
    buildH: '소스에서 빌드',
    buildReq: '필요 환경: Node.js 22 이상, Python 3.11 이상.',
    buildCmt: ['데스크톱 앱(Electron)', '또는 브라우저에서 편집기 열기'],
    licenseH: '라이선스',
    license: 'Stick은 [GNU 일반 공중 사용 허가서 v3.0](../../LICENSE)(또는 이후 버전)에 따른 자유 소프트웨어입니다. GPL 라이선스인 StykAnimate 프로젝트를 수정한 버전이며, 라이선스에 따라 이 고지를 유지합니다. Stick은 독립 프로젝트이며 Pivot Animator나 Stick Nodes와 제휴하지 않았습니다. 해당 이름은 파일 호환성을 설명하기 위해서만 사용합니다.',
    footer: '무료 졸라맨 애니메이션 프로그램 · Windows, Linux, 웹용 스틱맨 애니메이터',
  },
  es: {
    title: 'Stick: programa gratis para animar monigotes (stick figures)',
    lead: '<b>Posa. Pon fotogramas clave. Dibuja. Exporta.</b><br>Stick es un animador de monigotes gratis y de código abierto para Windows, Linux y el navegador.<br>Crea peleas de stickman, ciclos de caminata, memes y cortos, y expórtalos a MP4, GIF o PNG.',
    nav: ['▶ Ver el tour de 2 minutos', 'Consigue Stick', 'Funciones', 'Galería', 'Preguntas frecuentes', 'Compilar desde el código'],
    whatH: '¿Qué es Stick?',
    what: '**Stick** es una app de escritorio y web para **animación de monigotes** (stick figures). Arrastras las articulaciones para posar la figura, añades un fotograma, la vuelves a posar y Stick rellena el movimiento intermedio. Tiene una línea de tiempo con capas, papel cebolla, movimientos de cámara, efectos visuales, pinceles para dibujar a mano y un editor de rigs para personajes propios.\n\nAbre proyectos de **Pivot Animator** (`.piv`, `.stk`) y **Stick Nodes**, así que puedes seguir con tus animaciones antiguas. Todo funciona en tu ordenador: sin cuenta, sin marca de agua, sin subidas.',
    featH: 'Funciones',
    feats: [
      ['Posa cualquier articulación', 'Arrastra manos y pies; la cinemática inversa (IK) dobla codos y rodillas por ti. Bloqueo de ángulos, nodos elásticos y piezas 3D.'],
      ['Fotogramas clave y reproducción', 'Añade un fotograma, cambia la pose y dale a reproducir. Interpolación, curvas de suavizado y reproducción WebGPU en tiempo real.'],
      ['Una línea de tiempo de verdad', 'Tira de fotogramas simple o línea de tiempo avanzada con capas, carpetas, claves, suavizado, rangos, papel cebolla y pistas de audio.'],
      ['Efectos integrados', 'Brillo, aura, sombra, desenfoque, partículas, rayos de energía, explosiones, humo y power-ups, animables por fotograma.'],
      ['Dibuja en cualquier fotograma', 'Tinta, pincel, lápiz, rotulador, marcador, carboncillo, aerógrafo, tiza, óleo y más. Mezcla dibujo a mano con tus rigs.'],
      ['Crea tus propios rigs', 'Crea personajes con líneas, círculos, polígonos, texto e imágenes. Empieza con ejemplos como engranajes, abanicos, cajas y formas 3D.'],
      ['Todos los comandos, a una búsqueda', 'Pulsa <kbd>F1</kbd> o <kbd>Ctrl</kbd>+<kbd>P</kbd> para encontrar cualquier comando. Todos los atajos se pueden cambiar.'],
      ['Claro u oscuro, en 27 idiomas', 'Tema oscuro por defecto, tema claro cuando quieras, escala de interfaz ajustable y diseño táctil para tabletas.'],
    ],
    exportH: 'Exporta a cualquier sitio',
    export: 'Ajustes de un clic para **YouTube**, **YouTube Shorts**, **TikTok**, **Instagram Reels**, **X**, **GIF** para chats, PNG transparentes y 4K. Exporta **MP4**, **WebM** (con transparencia), **GIF**, **APNG**, secuencias **PNG / JPEG / SVG** o archivos editables `.piv` y `.stk`.',
    galleryH: 'Galería',
    getH: 'Consigue Stick',
    get: [`**Compílalo tú mismo** con unos pocos comandos; mira [Compilar desde el código](#compilar-desde-el-código). Funciona como app de escritorio o en el navegador.`, `**Instaladores:** las versiones para Windows (instalador y portable) y Linux (AppImage) se publican en la [página de Releases](${REPO}/releases). Pulsa **Watch → Custom → Releases** para recibir avisos.`, `**Míralo primero:** el [vídeo de 2 minutos](${VIDEO}).`],
    star: '⭐ **Dale una estrella a este repositorio** para seguir las novedades y ayudar a otros animadores a encontrar Stick.',
    faqH: 'Preguntas frecuentes',
    faq: [
      ['¿Stick es gratis?', 'Sí. Stick es gratis y de código abierto bajo la licencia GPL-3.0. Sin cuenta, sin marca de agua y sin versión de pago.'],
      ['¿Es una alternativa a Pivot Animator?', 'Sí. Stick abre proyectos (<code>.piv</code>) y figuras (<code>.stk</code>) de Pivot Animator y puede volver a exportarlos. Además añade capas, interpolación, efectos, dibujo y un renderizador WebGPU moderno.'],
      ['¿Puedo abrir proyectos de Stick Nodes en PC?', 'Sí. Stick importa figuras, movieclips y proyectos de Stick Nodes para que sigas trabajando en Windows o Linux.'],
      ['¿Cómo hago una animación de monigotes?', 'Posa la figura arrastrando sus articulaciones, pulsa <b>Añadir fotograma</b> (<kbd>A</kbd>), cambia la pose y pulsa <kbd>Espacio</kbd> para reproducir. Stick interpola el movimiento. Luego pulsa <b>Exportar</b> y elige MP4, GIF o un ajuste como TikTok.'],
      ['¿Funciona sin conexión? ¿Sube mis animaciones?', 'Funciona totalmente sin conexión. Tus proyectos se quedan en tu ordenador; no se sube nada.'],
    ],
    buildH: 'Compilar desde el código',
    buildReq: 'Requisitos: Node.js 22+ y Python 3.11+.',
    buildCmt: ['app de escritorio (Electron)', 'o el editor en tu navegador'],
    licenseH: 'Licencia',
    license: 'Stick es software libre bajo la [Licencia Pública General de GNU v3.0](../../LICENSE) o posterior. Es una versión modificada del proyecto StykAnimate, con licencia GPL; este aviso se mantiene como exige la licencia. Stick es un proyecto independiente y no está afiliado a Pivot Animator ni a Stick Nodes; esos nombres solo describen la compatibilidad de archivos.',
    footer: 'Programa gratis de animación de monigotes · animador de stickman para Windows, Linux y la web',
  },
  'pt-BR': {
    title: 'Stick: programa grátis de animação de bonecos palito',
    lead: '<b>Faça a pose. Crie keyframes. Desenhe. Exporte.</b><br>Stick é um animador de bonecos palito (stick figures) grátis e de código aberto para Windows, Linux e navegador.<br>Crie lutas de stickman, ciclos de caminhada, memes e curtas, e exporte em MP4, GIF ou PNG.',
    nav: ['▶ Assista ao tour de 2 minutos', 'Baixe o Stick', 'Recursos', 'Galeria', 'Perguntas frequentes', 'Compilar a partir do código'],
    whatH: 'O que é o Stick?',
    what: '**Stick** é um app desktop e web para **animação de bonecos palito**. Você arrasta as articulações para posar o boneco, adiciona um quadro, muda a pose e o Stick preenche o movimento entre eles. Tem linha do tempo com camadas, papel cebola, movimentos de câmera, efeitos visuais, pincéis para desenho à mão e um editor de rigs para personagens próprios.\n\nEle abre projetos do **Pivot Animator** (`.piv`, `.stk`) e do **Stick Nodes**, então você pode continuar suas animações antigas. Tudo roda no seu computador: sem conta, sem marca d’água, sem upload.',
    featH: 'Recursos',
    feats: [
      ['Pose qualquer articulação', 'Arraste mãos e pés; a cinemática inversa (IK) dobra cotovelos e joelhos para você. Trava de ângulo, nós elásticos e partes 3D.'],
      ['Keyframes e reprodução', 'Adicione um quadro, mude a pose e aperte play. Interpolação, curvas de suavização e reprodução WebGPU em tempo real.'],
      ['Uma linha do tempo de verdade', 'Faixa de quadros simples ou linha do tempo avançada com camadas, pastas, chaves, suavização, intervalos, papel cebola e trilhas de áudio.'],
      ['Efeitos integrados', 'Brilho, aura, sombra, desfoque, partículas, raios de energia, explosões, fumaça e power-ups, animáveis por quadro.'],
      ['Desenhe em qualquer quadro', 'Tinta, pincel, lápis, caneta, marcador, carvão, aerógrafo, giz, óleo e mais. Misture desenho à mão com seus rigs.'],
      ['Crie seus próprios rigs', 'Monte personagens com linhas, círculos, polígonos, texto e imagens. Comece por exemplos como engrenagens, leques, caixas e formas 3D.'],
      ['Todos os comandos a uma busca', 'Aperte <kbd>F1</kbd> ou <kbd>Ctrl</kbd>+<kbd>P</kbd> para achar qualquer comando. Todos os atalhos podem ser alterados.'],
      ['Claro ou escuro, em 27 idiomas', 'Tema escuro por padrão, tema claro quando quiser, escala de interface ajustável e layout de toque para tablets.'],
    ],
    exportH: 'Exporte para qualquer lugar',
    export: 'Predefinições de um clique para **YouTube**, **YouTube Shorts**, **TikTok**, **Instagram Reels**, **X**, **GIFs** para chat, PNGs transparentes e 4K. Exporte **MP4**, **WebM** (com transparência), **GIF**, **APNG**, sequências **PNG / JPEG / SVG** ou arquivos editáveis `.piv` e `.stk`.',
    galleryH: 'Galeria',
    getH: 'Baixe o Stick',
    get: [`**Compile você mesmo** com poucos comandos; veja [Compilar a partir do código](#compilar-a-partir-do-código). Roda como app desktop ou no navegador.`, `**Instaladores:** versões para Windows (instalador e portátil) e Linux (AppImage) são publicadas na [página de Releases](${REPO}/releases). Clique em **Watch → Custom → Releases** para ser avisado.`, `**Assista antes:** o [vídeo de 2 minutos](${VIDEO}).`],
    star: '⭐ **Dê uma estrela neste repositório** para acompanhar as novidades e ajudar outros animadores a encontrar o Stick.',
    faqH: 'Perguntas frequentes',
    faq: [
      ['O Stick é grátis?', 'Sim. O Stick é grátis e de código aberto sob a licença GPL-3.0. Sem conta, sem marca d’água e sem versão paga.'],
      ['É uma alternativa ao Pivot Animator?', 'Sim. O Stick abre projetos (<code>.piv</code>) e bonecos (<code>.stk</code>) do Pivot Animator e consegue exportá-los de volta, com camadas, interpolação, efeitos, desenho e renderização WebGPU.'],
      ['Posso abrir projetos do Stick Nodes no PC?', 'Sim. O Stick importa bonecos, movieclips e projetos do Stick Nodes para você continuar no Windows ou Linux.'],
      ['Como faço uma animação de boneco palito?', 'Pose o boneco arrastando as articulações, aperte <b>Adicionar quadro</b> (<kbd>A</kbd>), mude a pose e aperte <kbd>Espaço</kbd> para reproduzir. O Stick interpola o movimento. Depois clique em <b>Exportar</b> e escolha MP4, GIF ou uma predefinição como TikTok.'],
      ['Funciona offline? Ele envia minhas animações?', 'Funciona totalmente offline. Seus projetos ficam no seu computador; nada é enviado.'],
    ],
    buildH: 'Compilar a partir do código',
    buildReq: 'Requisitos: Node.js 22+ e Python 3.11+.',
    buildCmt: ['app desktop (Electron)', 'ou o editor no navegador'],
    licenseH: 'Licença',
    license: 'Stick é software livre sob a [Licença Pública Geral GNU v3.0](../../LICENSE) ou posterior. É uma versão modificada do projeto StykAnimate, licenciado sob a GPL; este aviso é mantido como a licença exige. O Stick é um projeto independente e não é afiliado ao Pivot Animator nem ao Stick Nodes; esses nomes descrevem apenas a compatibilidade de arquivos.',
    footer: 'Programa grátis de animação de boneco palito · animador de stickman para Windows, Linux e web',
  },
  fr: {
    title: 'Stick : logiciel gratuit d’animation de bonhommes allumettes',
    lead: '<b>Posez. Créez des images clés. Dessinez. Exportez.</b><br>Stick est un logiciel d’animation de stick figures gratuit et open source pour Windows, Linux et le navigateur.<br>Créez des combats de stickman, des cycles de marche, des mèmes et des courts métrages, puis exportez en MP4, GIF ou PNG.',
    nav: ['▶ Voir la visite de 2 minutes', 'Obtenir Stick', 'Fonctionnalités', 'Galerie', 'FAQ', 'Compiler depuis les sources'],
    whatH: 'Qu’est-ce que Stick ?',
    what: '**Stick** est une application de bureau et web pour l’**animation de bonhommes allumettes**. Vous faites glisser les articulations pour poser le personnage, ajoutez une image, changez la pose, et Stick remplit le mouvement entre les deux. Il propose une timeline à calques, la pelure d’oignon, des mouvements de caméra, des effets visuels, des pinceaux pour dessiner à la main et un éditeur de rigs pour vos propres personnages.\n\nIl ouvre les projets **Pivot Animator** (`.piv`, `.stk`) et **Stick Nodes** : vos anciennes animations vous suivent. Tout fonctionne sur votre ordinateur : pas de compte, pas de filigrane, aucun envoi.',
    featH: 'Fonctionnalités',
    feats: [
      ['Posez chaque articulation', 'Faites glisser mains et pieds ; la cinématique inverse (IK) plie coudes et genoux pour vous. Verrouillage d’angle, nœuds élastiques et pièces 3D.'],
      ['Images clés et lecture', 'Ajoutez une image, changez la pose, lancez la lecture. Interpolation, courbes d’accélération et lecture WebGPU en temps réel.'],
      ['Une vraie timeline', 'Bande d’images simple ou timeline avancée avec calques, dossiers, clés, accélération, plages de lecture, pelure d’oignon et pistes audio.'],
      ['Effets intégrés', 'Lueur, aura, ombre, flou, particules, rayons d’énergie, explosions, fumée et power-ups, animables image par image.'],
      ['Dessinez sur n’importe quelle image', 'Encre, feutre pinceau, crayon, fineliner, marqueur, fusain, aérographe, craie, huile et plus. Mélangez dessin à la main et rigs.'],
      ['Créez vos propres rigs', 'Construisez des personnages avec lignes, cercles, polygones, texte et images. Partez d’exemples : engrenages, éventails, caisses et formes 3D.'],
      ['Toutes les commandes en une recherche', 'Appuyez sur <kbd>F1</kbd> ou <kbd>Ctrl</kbd>+<kbd>P</kbd> pour trouver n’importe quelle commande. Tous les raccourcis sont personnalisables.'],
      ['Clair ou sombre, en 27 langues', 'Thème sombre par défaut, thème clair à la demande, taille d’interface réglable et mise en page tactile pour tablettes.'],
    ],
    exportH: 'Exportez partout',
    export: 'Préréglages en un clic pour **YouTube**, **YouTube Shorts**, **TikTok**, **Instagram Reels**, **X**, **GIF** pour les discussions, PNG transparents et 4K. Exportez en **MP4**, **WebM** (avec transparence), **GIF**, **APNG**, séquences **PNG / JPEG / SVG** ou fichiers modifiables `.piv` et `.stk`.',
    galleryH: 'Galerie',
    getH: 'Obtenir Stick',
    get: [`**Compilez-le vous-même** en quelques commandes ; voir [Compiler depuis les sources](#compiler-depuis-les-sources). Il fonctionne en application de bureau ou dans le navigateur.`, `**Installateurs :** les versions Windows (installateur et portable) et Linux (AppImage) sont publiées sur la [page des Releases](${REPO}/releases). Cliquez sur **Watch → Custom → Releases** pour être prévenu.`, `**Regardez d’abord :** la [vidéo de 2 minutes](${VIDEO}).`],
    star: '⭐ **Ajoutez une étoile à ce dépôt** pour suivre les nouvelles versions et aider d’autres animateurs à découvrir Stick.',
    faqH: 'FAQ',
    faq: [
      ['Stick est-il gratuit ?', 'Oui. Stick est gratuit et open source sous licence GPL-3.0. Pas de compte, pas de filigrane, pas de version payante.'],
      ['Est-ce une alternative à Pivot Animator ?', 'Oui. Stick ouvre les projets (<code>.piv</code>) et les figures (<code>.stk</code>) de Pivot Animator et peut les réexporter, avec en plus des calques, l’interpolation, des effets, le dessin et un rendu WebGPU moderne.'],
      ['Puis-je ouvrir des projets Stick Nodes sur PC ?', 'Oui. Stick importe les figures, movieclips et projets Stick Nodes pour continuer sur Windows ou Linux.'],
      ['Comment faire une animation de bonhomme allumette ?', 'Posez le personnage en faisant glisser ses articulations, appuyez sur <b>Ajouter une image</b> (<kbd>A</kbd>), changez la pose et appuyez sur <kbd>Espace</kbd> pour lire. Stick interpole le mouvement. Cliquez ensuite sur <b>Exporter</b> et choisissez MP4, GIF ou un préréglage comme TikTok.'],
      ['Fonctionne-t-il hors ligne ? Envoie-t-il mes animations ?', 'Il fonctionne entièrement hors ligne. Vos projets restent sur votre ordinateur ; rien n’est envoyé.'],
    ],
    buildH: 'Compiler depuis les sources',
    buildReq: 'Prérequis : Node.js 22+ et Python 3.11+.',
    buildCmt: ['application de bureau (Electron)', 'ou l’éditeur dans votre navigateur'],
    licenseH: 'Licence',
    license: 'Stick est un logiciel libre sous [Licence publique générale GNU v3.0](../../LICENSE) ou ultérieure. C’est une version modifiée du projet StykAnimate, sous licence GPL ; cette mention est conservée comme l’exige la licence. Stick est un projet indépendant, sans lien avec Pivot Animator ni Stick Nodes ; ces noms décrivent uniquement la compatibilité des fichiers.',
    footer: 'Logiciel gratuit d’animation de bonhommes allumettes · animateur de stickman pour Windows, Linux et le web',
  },
  de: {
    title: 'Stick: kostenlose Software für Strichmännchen-Animation',
    lead: '<b>Posen. Keyframes setzen. Zeichnen. Exportieren.</b><br>Stick ist ein kostenloser Open-Source-Animator für Strichmännchen unter Windows, Linux und im Browser.<br>Erstelle Stickman-Kämpfe, Laufzyklen, Memes und Kurzfilme und exportiere als MP4, GIF oder PNG.',
    nav: ['▶ 2-Minuten-Tour ansehen', 'Stick holen', 'Funktionen', 'Galerie', 'FAQ', 'Aus dem Quellcode bauen'],
    whatH: 'Was ist Stick?',
    what: '**Stick** ist eine Desktop- und Web-App für **Strichmännchen-Animation**. Du ziehst die Gelenke, um die Figur zu posen, fügst ein Bild hinzu, änderst die Pose, und Stick füllt die Bewegung dazwischen. Dazu kommen eine Zeitleiste mit Ebenen, Zwiebelschicht, Kamerafahrten, visuelle Effekte, Pinsel zum Zeichnen von Hand und ein Rig-Editor für eigene Figuren.\n\nStick öffnet Projekte aus **Pivot Animator** (`.piv`, `.stk`) und **Stick Nodes**, sodass du alte Animationen weiterbearbeiten kannst. Alles läuft auf deinem Rechner: kein Konto, kein Wasserzeichen, keine Uploads.',
    featH: 'Funktionen',
    feats: [
      ['Jedes Gelenk posen', 'Hände und Füße ziehen; inverse Kinematik (IK) beugt Ellbogen und Knie für dich. Winkelsperre, dehnbare Knoten und 3D-Teile.'],
      ['Keyframes und Wiedergabe', 'Bild hinzufügen, Pose ändern, abspielen. Zwischenbilder, Easing-Kurven und WebGPU-Wiedergabe in Echtzeit.'],
      ['Eine echte Zeitleiste', 'Einfacher Bildstreifen oder erweiterte Zeitleiste mit Ebenen, Ordnern, Keys, Easing, Wiedergabebereichen, Zwiebelschicht und Audiospuren.'],
      ['Eingebaute Effekte', 'Leuchten, Aura, Schatten, Weichzeichner, Partikel, Energiestrahlen, Explosionen, Rauch und Power-ups, pro Bild animierbar.'],
      ['Auf jedes Bild zeichnen', 'Tinte, Pinselstift, Bleistift, Fineliner, Marker, Kohle, Airbrush, Kreide, Öl und mehr. Handzeichnung und Rigs frei mischen.'],
      ['Eigene Rigs bauen', 'Figuren aus Linien, Kreisen, Polygonen, Text und Bildern bauen. Starte mit Beispielen wie Zahnrädern, Fächern, Kisten und 3D-Formen.'],
      ['Jeder Befehl, eine Suche entfernt', 'Drücke <kbd>F1</kbd> oder <kbd>Strg</kbd>+<kbd>P</kbd>, um jeden Befehl zu finden. Alle Tastenkürzel lassen sich ändern.'],
      ['Hell oder dunkel, in 27 Sprachen', 'Standardmäßig dunkles Design, auf Wunsch hell, einstellbare UI-Größe und Touch-Layout für Tablets.'],
    ],
    exportH: 'Überallhin exportieren',
    export: 'Ein-Klick-Vorlagen für **YouTube**, **YouTube Shorts**, **TikTok**, **Instagram Reels**, **X**, Chat-**GIFs**, transparente PNG-Bilder und 4K. Exportiere **MP4**, **WebM** (mit Transparenz), **GIF**, **APNG**, **PNG / JPEG / SVG**-Sequenzen oder bearbeitbare `.piv`- und `.stk`-Dateien.',
    galleryH: 'Galerie',
    getH: 'Stick holen',
    get: [`**Selbst bauen** mit wenigen Befehlen; siehe [Aus dem Quellcode bauen](#aus-dem-quellcode-bauen). Läuft als Desktop-App oder im Browser.`, `**Installer:** Versionen für Windows (Setup und portabel) und Linux (AppImage) erscheinen auf der [Releases-Seite](${REPO}/releases). Klicke auf **Watch → Custom → Releases**, um benachrichtigt zu werden.`, `**Erst ansehen:** die [2-Minuten-Video-Tour](${VIDEO}).`],
    star: '⭐ **Gib diesem Repository einen Stern**, um neue Versionen zu verfolgen und anderen Animatoren zu helfen, Stick zu finden.',
    faqH: 'FAQ',
    faq: [
      ['Ist Stick kostenlos?', 'Ja. Stick ist kostenlos und Open Source unter der GPL-3.0-Lizenz. Kein Konto, kein Wasserzeichen, keine Bezahlversion.'],
      ['Ist Stick eine Alternative zu Pivot Animator?', 'Ja. Stick öffnet Pivot-Animator-Projekte (<code>.piv</code>) und -Figuren (<code>.stk</code>) und kann sie wieder exportieren – mit Ebenen, Zwischenbildern, Effekten, Zeichnen und modernem WebGPU-Rendering.'],
      ['Kann ich Stick-Nodes-Projekte am PC öffnen?', 'Ja. Stick importiert Stick-Nodes-Figuren, Movieclips und Projekte, damit du unter Windows oder Linux weiterarbeiten kannst.'],
      ['Wie erstelle ich eine Strichmännchen-Animation?', 'Pose die Figur, indem du ihre Gelenke ziehst, drücke <b>Bild hinzufügen</b> (<kbd>A</kbd>), ändere die Pose und drücke <kbd>Leertaste</kbd> zum Abspielen. Stick berechnet die Bewegung dazwischen. Klicke dann auf <b>Exportieren</b> und wähle MP4, GIF oder eine Vorlage wie TikTok.'],
      ['Funktioniert Stick offline? Lädt es meine Animationen hoch?', 'Stick funktioniert komplett offline. Deine Projekte bleiben auf deinem Rechner; nichts wird hochgeladen.'],
    ],
    buildH: 'Aus dem Quellcode bauen',
    buildReq: 'Voraussetzungen: Node.js 22+ und Python 3.11+.',
    buildCmt: ['Desktop-App (Electron)', 'oder der Editor im Browser'],
    licenseH: 'Lizenz',
    license: 'Stick ist freie Software unter der [GNU General Public License v3.0](../../LICENSE) oder neuer. Es ist eine veränderte Version des GPL-lizenzierten Projekts StykAnimate; dieser Hinweis bleibt erhalten, wie es die Lizenz verlangt. Stick ist ein unabhängiges Projekt und steht in keiner Verbindung zu Pivot Animator oder Stick Nodes; diese Namen beschreiben nur die Dateikompatibilität.',
    footer: 'Kostenlose Strichmännchen-Animationssoftware · Stickman-Animator für Windows, Linux und das Web',
  },
  ru: {
    title: 'Stick: бесплатная программа для анимации человечков',
    lead: '<b>Поставьте позу. Расставьте ключевые кадры. Рисуйте. Экспортируйте.</b><br>Stick — бесплатный аниматор стикменов с открытым исходным кодом для Windows, Linux и браузера.<br>Делайте драки стикменов, циклы ходьбы, мемы и мультфильмы и экспортируйте в MP4, GIF или PNG.',
    nav: ['▶ Смотреть 2-минутный обзор', 'Скачать Stick', 'Возможности', 'Галерея', 'Вопросы и ответы', 'Сборка из исходников'],
    whatH: 'Что такое Stick?',
    what: '**Stick** — настольное и веб-приложение для **анимации человечков из палочек**. Перетаскивайте суставы, чтобы поставить позу, добавьте кадр, измените позу — и Stick сам заполнит движение между ними. Есть таймлайн со слоями, калька (onion skin), движения камеры, визуальные эффекты, кисти для рисования от руки и редактор ригов для своих персонажей.\n\nStick открывает проекты **Pivot Animator** (`.piv`, `.stk`) и **Stick Nodes**, так что старые анимации можно продолжить. Всё работает на вашем компьютере: без аккаунта, без водяных знаков, без загрузок в сеть.',
    featH: 'Возможности',
    feats: [
      ['Поза любым суставом', 'Тяните за руки и ноги — инверсная кинематика (IK) сама согнёт локти и колени. Фиксация углов, растягиваемые узлы и 3D-детали.'],
      ['Ключевые кадры и воспроизведение', 'Добавьте кадр, измените позу, нажмите «Воспроизвести». Промежуточные кадры, кривые сглаживания и воспроизведение на WebGPU в реальном времени.'],
      ['Настоящий таймлайн', 'Простая лента кадров или расширенный таймлайн со слоями, папками, ключами, сглаживанием, диапазонами, калькой и аудиодорожками.'],
      ['Встроенные эффекты', 'Свечение, аура, тень, размытие, частицы, энергетические лучи, взрывы, дым и усиления — с ключами на каждый кадр.'],
      ['Рисуйте на любом кадре', 'Тушь, кисть, карандаш, линер, маркер, уголь, аэрограф, мел, масло и другое. Сочетайте рисунок от руки с ригами.'],
      ['Создавайте свои риги', 'Собирайте персонажей из линий, кругов, многоугольников, текста и картинок. Начните с примеров: шестерни, веер, ящики и 3D-фигуры.'],
      ['Любая команда — через поиск', 'Нажмите <kbd>F1</kbd> или <kbd>Ctrl</kbd>+<kbd>P</kbd>, чтобы найти любую команду. Все сочетания клавиш можно изменить.'],
      ['Светлая или тёмная тема, 27 языков', 'Тёмная тема по умолчанию, светлая — по желанию, масштаб интерфейса и сенсорный режим для планшетов.'],
    ],
    exportH: 'Экспорт куда угодно',
    export: 'Пресеты в один клик для **YouTube**, **YouTube Shorts**, **TikTok**, **Instagram Reels**, **X**, **GIF** для чатов, прозрачных PNG и 4K. Экспорт в **MP4**, **WebM** (с прозрачностью), **GIF**, **APNG**, последовательности **PNG / JPEG / SVG** или редактируемые файлы `.piv` и `.stk`.',
    galleryH: 'Галерея',
    getH: 'Скачать Stick',
    get: [`**Соберите сами** за несколько команд — см. [Сборка из исходников](#сборка-из-исходников). Работает как настольное приложение или в браузере.`, `**Установщики:** версии для Windows (установщик и портативная) и Linux (AppImage) публикуются на [странице Releases](${REPO}/releases). Нажмите **Watch → Custom → Releases**, чтобы получать уведомления.`, `**Сначала посмотрите:** [2-минутный видеообзор](${VIDEO}).`],
    star: '⭐ **Поставьте звезду репозиторию**, чтобы следить за новыми версиями и помочь другим аниматорам найти Stick.',
    faqH: 'Вопросы и ответы',
    faq: [
      ['Stick бесплатный?', 'Да. Stick бесплатный и с открытым кодом по лицензии GPL-3.0. Без аккаунта, без водяных знаков, без платной версии.'],
      ['Это альтернатива Pivot Animator?', 'Да. Stick открывает проекты (<code>.piv</code>) и фигуры (<code>.stk</code>) Pivot Animator и умеет экспортировать их обратно, добавляя слои, промежуточные кадры, эффекты, рисование и современный рендер на WebGPU.'],
      ['Можно открыть проекты Stick Nodes на ПК?', 'Да. Stick импортирует фигуры, мувиклипы и проекты Stick Nodes, чтобы вы продолжили работу на Windows или Linux.'],
      ['Как сделать анимацию стикмена?', 'Поставьте позу, перетаскивая суставы, нажмите <b>Добавить кадр</b> (<kbd>A</kbd>), измените позу и нажмите <kbd>Пробел</kbd> для воспроизведения. Stick заполнит движение между кадрами. Затем нажмите <b>Экспорт</b> и выберите MP4, GIF или пресет, например TikTok.'],
      ['Работает ли без интернета? Загружает ли мои анимации?', 'Полностью работает офлайн. Проекты хранятся только на вашем компьютере, ничего не загружается.'],
    ],
    buildH: 'Сборка из исходников',
    buildReq: 'Требования: Node.js 22+ и Python 3.11+.',
    buildCmt: ['настольное приложение (Electron)', 'или редактор в браузере'],
    licenseH: 'Лицензия',
    license: 'Stick — свободное ПО по [Стандартной общественной лицензии GNU v3.0](../../LICENSE) или более поздней версии. Это изменённая версия проекта StykAnimate под лицензией GPL; это уведомление сохраняется, как требует лицензия. Stick — независимый проект, не связанный с Pivot Animator или Stick Nodes; эти названия используются только для описания совместимости файлов.',
    footer: 'Бесплатная программа для анимации человечков · аниматор стикменов для Windows, Linux и веба',
  },
};

export const GIFS = ['pose', 'play', 'timeline', 'effects', 'draw', 'build', 'command-search', 'settings'];
const SHOTS = [['screenshot-animate', 'screenshot-effects'], ['screenshot-draw', 'screenshot-build'], ['screenshot-export', 'screenshot-settings-light']];
const anchor = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

function page(code, t) {
  const langBar = LANGS.map(([c, name, href]) => c === code ? `<b>${name}</b>` : `<a href="${href || `README.${c}.md`}">${name}</a>`).join(' ·\n  ');
  const navTargets = [VIDEO, `#${anchor(t.getH)}`, `#${anchor(t.featH)}`, `#${anchor(t.galleryH)}`, `#${anchor(t.faqH)}`, `#${anchor(t.buildH)}`];
  const nav = t.nav.map((label, i) => `<a href="${navTargets[i]}">${i ? label : `<b>${label}</b>`}</a>`).join(' ·\n  ');
  const cells = t.feats.map(([h, body], i) => `<td width="50%" valign="top">\n\n### ${h}\n${body}\n\n<img src="../media/${GIFS[i]}.gif" alt="${h} · Stick" width="100%">\n\n</td>`);
  const rows = []; for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>\n${cells[i]}\n${cells[i + 1]}\n</tr>`);
  const gallery = SHOTS.map(row => `<tr>\n${row.map(s => `<td><img src="../media/${s}.jpg" alt="Stick · ${t.title}"></td>`).join('\n')}\n</tr>`).join('\n');
  const faq = t.faq.map(([q, a]) => `<details>\n<summary><b>${q}</b></summary>\n\n${a}\n</details>`).join('\n\n');
  return `<!-- ${t.title} -->
<p align="center">
  <a href="${VIDEO}"><img src="../media/stick-banner.png" alt="${t.title}" width="100%"></a>
</p>

<h1 align="center">${t.title}</h1>

<p align="center">
  ${t.lead}
</p>

<p align="center">
  <a href="${REPO}/stargazers"><img src="https://img.shields.io/github/stars/blixvip/stick?style=for-the-badge&logo=github&color=EEF2FF&labelColor=050507" alt="GitHub stars"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-EEF2FF?style=for-the-badge&labelColor=050507" alt="GPL-3.0"></a>
  <img src="https://img.shields.io/badge/Windows%20%C2%B7%20Linux%20%C2%B7%20Web-EEF2FF?style=for-the-badge&labelColor=050507" alt="Windows · Linux · Web">
</p>

<p align="center">
  ${nav}
</p>

<p align="center">
  ${langBar}
</p>

<p align="center">
  <img src="../media/stick-hero.gif" alt="${t.title}" width="90%">
</p>

## ${t.whatH}

${t.what}

## ${t.featH}

<table>
${rows.join('\n')}
</table>

### ${t.exportH}

${t.export}

<p align="center">
  <img src="../media/export.gif" alt="${t.exportH} · Stick" width="90%">
</p>

## ${t.galleryH}

<table>
${gallery}
</table>

## ${t.getH}

${t.get.map(line => `- ${line}`).join('\n')}

${t.star}

## ${t.faqH}

${faq}

## ${t.buildH}

${t.buildReq}

\`\`\`sh
git clone ${REPO}.git
cd stick
npm ci
python -m pip install -r backend/requirements-fast.txt
npm start            # ${t.buildCmt[0]}
npm run serve        # ${t.buildCmt[1]}: http://127.0.0.1:47831
\`\`\`

## ${t.licenseH}

${t.license}

<p align="center">
  <img src="../../assets/brand/svg/stick-app-icon-dark.svg" alt="Stick" width="72"><br>
  <sub><b>Stick</b> · ${t.footer}</sub>
</p>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
await mkdir(out, {recursive: true});
for (const [code, t] of Object.entries(T)) {
  if (code === 'en') continue; // README.md is written by hand
  await writeFile(path.join(out, `README.${code}.md`), page(code, t));
  console.log(`docs/readme/README.${code}.md`);
}
}
