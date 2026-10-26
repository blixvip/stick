// Builds the GitHub Pages landing site (one page per language) into a folder:
//
//   node scripts/build-site.mjs <out-dir>
//
// The page text comes from scripts/build-readme-translations.mjs, so the site and
// the README translations stay in step. <out-dir>/media must already hold the
// clips and posters named in CLIPS (plus stick-editor-tour.mp4 and og.png); the
// branch that serves the site is gh-pages.
import {mkdir, writeFile, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {T, LANGS, GIFS, REPO, VIDEO} from './build-readme-translations.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'build/site'));
const SITE = 'https://blixvip.github.io/stick/';
const CLIPS = GIFS; // same feature order as the README
const HTML_LANG = {'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant'};

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = s => s.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
const anchor = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
// The small Markdown subset used in the translation strings.
const md = s => s.split(/\n\n/).map(p => p
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${href.replace('../../LICENSE', `${REPO}/blob/main/LICENSE`)}">${text}</a>`));
const para = s => md(s).map(p => `<p>${p}</p>`).join('\n');
const pageUrl = code => code === 'en' ? SITE : `${SITE}${code}/`;

function page(code, t) {
  const up = code === 'en' ? '' : '../', media = `${up}media/`;
  const description = strip(t.lead).slice(0, 300);
  const sections = {get: anchor(t.getH), feat: anchor(t.featH), faq: anchor(t.faqH), build: anchor(t.buildH)};
  const alternates = LANGS.map(([c]) => `<link rel="alternate" hreflang="${HTML_LANG[c] || c}" href="${pageUrl(c)}">`).join('\n  ') + `\n  <link rel="alternate" hreflang="x-default" href="${SITE}">`;
  const langLinks = LANGS.map(([c, name]) => c === code ? `<span aria-current="true">${name}</span>` : `<a href="${up}${c === 'en' ? '' : c + '/'}" hreflang="${HTML_LANG[c] || c}" lang="${HTML_LANG[c] || c}">${name}</a>`).join('');
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Stick', url: pageUrl(code), inLanguage: HTML_LANG[code] || code,
    description, applicationCategory: 'MultimediaApplication', applicationSubCategory: 'Animation software', operatingSystem: 'Windows, Linux, Web browser',
    offers: {'@type': 'Offer', price: '0', priceCurrency: 'USD'}, license: 'https://www.gnu.org/licenses/gpl-3.0.html', isAccessibleForFree: true,
    image: SITE + 'media/og.png', screenshot: SITE + 'media/hero.jpg', downloadUrl: REPO + '/releases', codeRepository: REPO,
    video: {'@type': 'VideoObject', name: t.nav[0].replace('▶ ', ''), description, thumbnailUrl: SITE + 'media/hero.jpg', contentUrl: SITE + 'media/stick-editor-tour.mp4', uploadDate: '2026-10-25', duration: 'PT1M54S'},
  };
  const faqLd = {'@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: t.faq.map(([q, a]) => ({'@type': 'Question', name: q, acceptedAnswer: {'@type': 'Answer', text: strip(a)}}))};
  const features = t.feats.map(([h, body], i) => `<article class="feature">
        <video class="clip" muted loop playsinline preload="none" poster="${media}${CLIPS[i]}.jpg" aria-label="${esc(h)}"><source src="${media}${CLIPS[i]}.mp4" type="video/mp4"></video>
        <h3>${h}</h3><p>${body}</p>
      </article>`).join('\n      ');
  const faq = t.faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('\n      ');
  return `<!doctype html>
<html lang="${HTML_LANG[code] || code}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(t.title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="keywords" content="Stick, stick figure animation, stickman animation, stick figure animator, Pivot Animator alternative, Stick Nodes PC, 2D animation software, free animation software, GIF maker">
  <link rel="canonical" href="${pageUrl(code)}">
  ${alternates}
  <meta name="theme-color" content="#050507">
  <link rel="icon" type="image/svg+xml" href="${up}favicon.svg">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Stick">
  <meta property="og:title" content="${esc(t.title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${pageUrl(code)}">
  <meta property="og:image" content="${SITE}media/og.png">
  <meta property="og:image:width" content="1280"><meta property="og:image:height" content="640">
  <meta property="og:video" content="${SITE}media/stick-editor-tour.mp4">
  <meta property="og:locale" content="${code.replace('-', '_')}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(t.title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${SITE}media/og.png">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <script type="application/ld+json">${JSON.stringify(faqLd)}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:ital,wght@0,500;0,700;1,800;1,900&display=swap">
  <style>
    :root { --bg: #050507; --panel: #0d0f15; --line: #1f2230; --text: #eef2ff; --muted: #9aa3b5; --glow: #c9d6ff; color-scheme: dark; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: radial-gradient(1200px 700px at 50% -10%, #151826 0%, var(--bg) 60%) no-repeat, var(--bg); color: var(--text); font: 17px/1.6 "Inter Tight", system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans", "Malgun Gothic", sans-serif; }
    a { color: var(--text); }
    .wrap { width: min(1120px, 100% - 32px); margin: 0 auto; }
    header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 0; }
    .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; font-weight: 900; font-style: italic; font-size: 24px; letter-spacing: -.02em; }
    .brand img { width: 38px; height: 38px; }
    .top-links { display: flex; gap: 18px; font-size: 15px; } .top-links a { color: var(--muted); text-decoration: none; } .top-links a:hover { color: var(--text); }
    .langs { display: flex; flex-wrap: wrap; gap: 6px 14px; justify-content: center; font-size: 14px; color: var(--muted); padding: 6px 0 0; }
    .langs a { color: var(--muted); text-decoration: none; } .langs a:hover { color: var(--text); } .langs [aria-current] { color: var(--text); font-weight: 700; }
    .hero { text-align: center; padding: 48px 0 24px; }
    .hero img.logo { width: min(420px, 80%); filter: drop-shadow(0 0 28px rgba(201, 214, 255, .35)); }
    h1 { font-size: clamp(34px, 5.4vw, 62px); line-height: 1.05; font-style: italic; font-weight: 900; letter-spacing: -.03em; margin: 22px 0 14px; text-shadow: 0 0 30px rgba(201, 214, 255, .25); }
    .lead { color: var(--muted); max-width: 760px; margin: 0 auto; font-size: 19px; } .lead b { color: var(--text); }
    .cta { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin: 28px 0 8px; }
    .btn { display: inline-flex; align-items: center; gap: 8px; padding: 13px 22px; border-radius: 12px; font-weight: 700; text-decoration: none; border: 1px solid var(--line); background: var(--panel); }
    .btn.primary { background: var(--text); color: var(--bg); border-color: var(--text); box-shadow: 0 0 32px rgba(201, 214, 255, .35); }
    .window { margin: 34px auto 0; border-radius: 18px; overflow: hidden; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 30px 80px rgba(0,0,0,.7), 0 0 60px rgba(201,214,255,.10); background: #000; }
    .window video { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; }
    section { padding: 64px 0 8px; }
    h2 { font-size: clamp(28px, 3.6vw, 40px); font-style: italic; font-weight: 900; letter-spacing: -.02em; margin: 0 0 18px; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 22px; }
    .feature { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
    .feature video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; border-bottom: 1px solid var(--line); }
    .feature h3 { margin: 16px 18px 6px; font-size: 20px; font-style: italic; font-weight: 800; } .feature p { margin: 0 18px 18px; color: var(--muted); font-size: 15.5px; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: .9em; background: #161925; padding: 2px 6px; border-radius: 6px; }
    kbd { font: 600 .85em ui-monospace, Consolas, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 5px; background: #161925; }
    p { color: #d6dbea; } strong { color: var(--text); }
    ul.get li { margin: 8px 0; color: #d6dbea; }
    details { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; margin: 10px 0; }
    summary { cursor: pointer; font-weight: 700; } details p { margin: 10px 0 0; color: var(--muted); }
    pre { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; overflow-x: auto; font: 14px/1.6 ui-monospace, Consolas, monospace; color: #d6dbea; }
    footer { text-align: center; color: var(--muted); padding: 60px 0 40px; font-size: 14px; } footer img { width: 56px; }
    @media (max-width: 640px) { .top-links { display: none; } body { font-size: 16px; } section { padding-top: 44px; } }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <a class="brand" href="${up || './'}"><img src="${up}favicon.svg" alt="" width="38" height="38">Stick</a>
      <nav class="top-links"><a href="#${sections.feat}">${t.nav[2]}</a><a href="#tour">${t.nav[0].replace('▶ ', '')}</a><a href="#${sections.faq}">${t.nav[4]}</a><a href="${REPO}">GitHub</a></nav>
    </header>
    <nav class="langs" aria-label="Language">${langLinks}</nav>
    <main>
      <div class="hero">
        <img class="logo" src="${up}media/logo-stacked.svg" alt="Stick logo: a stick figure running between code brackets" width="420" height="378">
        <h1>${t.title}</h1>
        <p class="lead">${t.lead}</p>
        <div class="cta">
          <a class="btn primary" href="#tour">${t.nav[0]}</a>
          <a class="btn" href="${REPO}">⭐ GitHub</a>
          <a class="btn" href="#${sections.get}">${t.nav[1]}</a>
        </div>
        <div class="window"><video autoplay muted loop playsinline poster="${media}hero.jpg" aria-label="${esc(t.title)}"><source src="${media}hero.mp4" type="video/mp4"></video></div>
      </div>
      <section id="${anchor(t.whatH)}"><h2>${t.whatH}</h2>${para(t.what)}</section>
      <section id="${sections.feat}"><h2>${t.featH}</h2>
      <div class="features">
      ${features}
      </div></section>
      <section id="${anchor(t.exportH)}"><h2>${t.exportH}</h2>${para(t.export)}
        <div class="window"><video muted loop playsinline preload="none" class="clip" poster="${media}export.jpg"><source src="${media}export.mp4" type="video/mp4"></video></div></section>
      <section id="tour"><h2>${t.nav[0].replace('▶ ', '')}</h2>
        <div class="window"><video controls preload="metadata" poster="${media}hero.jpg"><source src="${media}stick-editor-tour.mp4" type="video/mp4"></video></div></section>
      <section id="${sections.get}"><h2>${t.getH}</h2><ul class="get">${t.get.map(l => `<li>${md(l).join('')}</li>`).join('')}</ul><p>${md(t.star).join('')}</p></section>
      <section id="${sections.faq}"><h2>${t.faqH}</h2>
      ${faq}
      </section>
      <section id="${sections.build}"><h2>${t.buildH}</h2><p>${t.buildReq}</p>
<pre><code>git clone ${REPO}.git
cd stick
npm ci
python -m pip install -r backend/requirements-fast.txt
npm start            # ${esc(t.buildCmt[0])}
npm run serve        # ${esc(t.buildCmt[1])}: http://127.0.0.1:47831</code></pre></section>
      <section id="${anchor(t.licenseH)}"><h2>${t.licenseH}</h2>${para(t.license)}</section>
    </main>
    <footer><img src="${up}media/app-icon.svg" alt="Stick" width="56" height="56"><br><strong>Stick</strong> · ${t.footer}<br><a href="${REPO}">${REPO.replace('https://', '')}</a></footer>
  </div>
  <script>
    // Feature clips play only while on screen.
    const clips = document.querySelectorAll('video.clip');
    const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) e.target.play().catch(() => {}); else e.target.pause(); }), {rootMargin: '120px'});
    clips.forEach(v => io.observe(v));
  </script>
</body>
</html>
`;
}

await mkdir(path.join(out, 'media'), {recursive: true});
await copyFile(path.join(root, 'mark.svg'), path.join(out, 'favicon.svg'));
await copyFile(path.join(root, 'assets/brand/svg/stick-stacked-white.svg'), path.join(out, 'media/logo-stacked.svg'));
await copyFile(path.join(root, 'assets/brand/svg/stick-app-icon-dark.svg'), path.join(out, 'media/app-icon.svg'));
for (const [code] of LANGS) {
  const dir = code === 'en' ? out : path.join(out, code);
  await mkdir(dir, {recursive: true});
  await writeFile(path.join(dir, 'index.html'), page(code, T[code]));
}
const today = new Date().toISOString().slice(0, 10);
await writeFile(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${LANGS.map(([c]) => `  <url><loc>${pageUrl(c)}</loc><lastmod>${today}</lastmod>${LANGS.map(([a]) => `<xhtml:link rel="alternate" hreflang="${HTML_LANG[a] || a}" href="${pageUrl(a)}"/>`).join('')}</url>`).join('\n')}
</urlset>
`);
await writeFile(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
await writeFile(path.join(out, '.nojekyll'), '');
console.log(`site written to ${out} (${LANGS.length} languages)`);
