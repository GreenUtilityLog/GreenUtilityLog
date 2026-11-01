// ── Animated banners for X posts, and still cards for shared links ───────────
// One file: every banner is an HTML page built here, recorded in Chromium
// (Playwright) and encoded with ffmpeg. For each variant it writes:
//   brand/animated/out/<name>.mp4   7-ish seconds, 1200×675 — attach to a post
//   brand/animated/out/<name>.gif   the same, 720 px wide at 12 fps, for where video won't do
//   docs/share/<name>.png           the last frame at 1200×630 — the preview card
//   docs/share/<name>.html          a page with that card that sends people on to
//                                   the app: …/GreenUtilityLog/share/<name>.html
//
// Usage (from the repo root; needs Playwright's Chromium and ffmpeg):
//   node brand/animated/render.cjs                 every variant
//   node brand/animated/render.cjs meter week      just these
//   node brand/animated/render.cjs sunday --q="Is your TV on stand-by right now?"
// The Sunday banner takes its question from --q; without it, a general one.
//
// The numbers in the banners are examples of how a saving is paid (kWh below the
// 8 kWh-a-day target × 0.61 B3TR), not anyone's real result.

const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "out");
const SHARE = path.join(ROOT, "docs", "share");
const LOGO = "data:image/png;base64," + fs.readFileSync(path.join(ROOT, "brand", "logo-512.png")).toString("base64");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ── Shared look: brand green, a header area, a footer with logo and tags ─────
const page = (body, css = "", script = "") => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100vw;height:100vh;overflow:hidden}
body{background:radial-gradient(900px 520px at 22% 18%,#355a46 0%,rgba(53,90,70,0) 60%),linear-gradient(135deg,#163626 0%,#1f4532 55%,#2f6247 100%);
  font-family:"Inter","Helvetica Neue",Arial,"Noto Color Emoji",sans-serif;color:#f2f7f3;display:flex;flex-direction:column;box-sizing:border-box;padding:40px 60px 36px}
main{flex:1;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0}
footer{display:flex;justify-content:space-between;align-items:center;font-size:24px;font-weight:700;color:#cfe6d7}
footer .brand{display:flex;align-items:center;gap:14px}
footer img{width:52px;height:52px;border-radius:13px}
footer .tags{font-size:22px;font-weight:800;color:#a8e0bd}
.sticker{font-weight:900;background:#e6f2ea;color:#14301f;border-radius:999px;box-shadow:0 14px 40px rgba(0,0,0,.35)}
@keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.3)}to{opacity:1;transform:scale(1)}}
${css}</style></head><body><main>${body}</main>
<footer><div class="brand"><img src="${LOGO}">Green Utility Log</div><div class="tags">#VeChain · #VeBetterDAO</div></footer>
<script>${script}</script></body></html>`;

// ── The variants ─────────────────────────────────────────────────────────────
function meter() {
  return page(`
  <div class="panel"><div class="lbl">⚡ Today's reading</div>
    <div class="disp"><span id="d">003848.9</span><small>kWh</small></div>
    <div class="row"><span>Used <b>4.0 kWh</b></span><span>Target <b>8.0 kWh</b></span><span>Saved <b>4.0 kWh</b></span></div>
    <div class="sticker pop">+2.44 B3TR</div></div>
  <div class="head">Use less electricity. Earn B3TR. 💚</div>`, `
  .panel{position:relative;width:760px;padding:30px 40px 26px;border-radius:26px;background:rgba(8,24,16,.55);border:2px solid rgba(160,220,185,.25);box-shadow:0 30px 80px rgba(0,0,0,.35)}
  .lbl{font-size:22px;font-weight:800;letter-spacing:2px;color:#a8e0bd;text-transform:uppercase}
  .disp{margin-top:12px;background:#a9bfa6;border-radius:12px;padding:14px 26px;font-family:"DejaVu Sans Mono",Menlo,monospace;font-size:92px;font-weight:700;color:#0f1f16;letter-spacing:6px;display:flex;justify-content:space-between;align-items:baseline}
  .disp small{font-size:34px;letter-spacing:0}
  .row{display:flex;justify-content:space-between;margin-top:20px;font-size:30px;font-weight:700;opacity:0;animation:fadeUp .6s ease 2.6s forwards}
  .row b{color:#a8e0bd}
  .pop{position:absolute;right:-40px;top:-30px;font-size:46px;padding:14px 26px;opacity:0;transform:rotate(-6deg);animation:pop .6s cubic-bezier(.2,1.6,.4,1) 3.6s forwards}
  .head{margin-top:34px;font-size:46px;font-weight:900;opacity:0;animation:fadeUp .7s ease 4.3s forwards}`, `
  const el=document.getElementById('d'),a=3848.9,b=3852.9;let t0;
  function f(t){t0??=t;const p=Math.min(1,(t-t0)/2200);el.textContent=(a+(b-a)*(1-Math.pow(1-p,3))).toFixed(1).padStart(8,'0');if(p<1)requestAnimationFrame(f)}
  setTimeout(()=>requestAnimationFrame(f),300)`);
}

function sprout() {
  return page(`
  <svg width="330" height="330" viewBox="0 0 512 512">
    <path class="stem" d="M256 380 C 247 330 250 300 256 256" fill="none" stroke="#eef6f0" stroke-width="22" stroke-linecap="round"/>
    <path class="leaf l3" d="M256 268 C 238 244 238 212 256 184 C 274 212 274 244 256 268 Z" fill="#eef6f0"/>
    <path class="leaf l1" d="M254 300 C 300 314 358 288 382 232 C 322 218 268 250 254 300 Z" fill="#eef6f0"/>
    <path class="leaf l2" d="M258 300 C 212 314 154 288 130 232 C 190 218 244 250 258 300 Z" fill="#eef6f0"/>
  </svg><div class="ground"></div>
  <h1>Green Utility Log</h1><p>Every kWh you save grows into B3TR 🌱</p>`, `
  svg{margin-top:-20px}
  .stem{stroke-dasharray:200;stroke-dashoffset:200;animation:draw 1.1s ease .3s forwards}
  .leaf{transform-origin:256px 300px;transform:scale(0);animation:grow .7s cubic-bezier(.2,1.4,.4,1) forwards}
  .l1{animation-delay:1.2s}.l2{animation-delay:1.45s}.l3{animation-delay:1.0s}
  @keyframes draw{to{stroke-dashoffset:0}} @keyframes grow{to{transform:scale(1)}}
  .ground{width:420px;height:10px;margin-top:-46px;border-radius:5px;background:rgba(168,224,189,.35);transform:scaleX(0);animation:gx .6s ease forwards}
  @keyframes gx{to{transform:scaleX(1)}}
  h1{margin:30px 0 0;font-size:76px;font-weight:900;letter-spacing:-2px;opacity:0;animation:fadeUp .7s ease 2.1s forwards}
  p{margin:14px 0 0;font-size:34px;color:#cfe6d7;opacity:0;animation:fadeUp .7s ease 2.8s forwards}`);
}

function week() {
  const days = [["Mon", 9.5], ["Tue", 7.2], ["Wed", 6.1], ["Thu", 8.4], ["Fri", 5.3], ["Sat", 6.8], ["Sun", 4.9]];
  const MAX = 11, earned = [];
  const cols = days.map(([d, v], i) => {
    const delay = 0.3 + i * 0.35, good = v < 8, b3tr = +((8 - v) * 0.61).toFixed(2);
    if (good) earned.push([b3tr, delay + 0.85]);
    return `<div class="col"><div class="bar ${good ? "good" : "over"}" style="height:calc(${v / MAX} * (100% - 40px));animation-delay:${delay}s">
      ${good ? `<div class="sticker chip" style="animation-delay:${delay + 0.45}s">+${b3tr.toFixed(2)}</div>` : ""}</div><div class="d">${d}</div></div>`;
  }).join("");
  return page(`
  <div class="top"><div><div class="title">Below the line = B3TR ⚡</div><div class="subt">- - -  target: 8 kWh a day</div></div><div class="sticker sum">+<span id="s">0.00</span> B3TR</div></div>
  <div class="chart"><div class="target" style="bottom:calc(${8 / MAX} * (100% - 40px) + 40px)"></div>${cols}</div>`, `
  main{justify-content:flex-start}
  .top{width:100%;display:flex;justify-content:space-between;align-items:center;opacity:0;animation:fadeUp .6s ease .1s forwards}
  .title{font-size:44px;font-weight:900}
  .sum{font-size:42px;padding:6px 22px}
  .chart{position:relative;flex:1;width:100%;display:flex;justify-content:space-around;align-items:flex-end;margin-top:20px}
  .col{position:relative;z-index:2;width:90px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
  .bar{position:relative;width:66px;border-radius:12px 12px 4px 4px;transform:scaleY(0);transform-origin:bottom;animation:up .5s ease-out forwards}
  .good{background:linear-gradient(#a8e0bd,#5fae7f)} .over{background:linear-gradient(#e2a46b,#b06a32)}
  @keyframes up{to{transform:scaleY(1)}}
  .d{height:40px;line-height:40px;font-size:22px;font-weight:700;color:#cfe6d7}
  .chip{position:absolute;left:50%;top:-8px;font-size:21px;padding:4px 10px;white-space:nowrap;opacity:0;animation:rise .9s ease forwards}
  @keyframes rise{from{opacity:0;transform:translate(-50%,0) scale(.6)}to{opacity:1;transform:translate(-50%,-110%) scale(1)}}
  .target{position:absolute;left:0;right:0;border-top:4px dashed rgba(230,242,234,.8);z-index:1}
  .subt{margin-top:6px;font-size:22px;font-weight:700;color:#cfe6d7}`, `
  let total=0;for(const [g,t] of ${JSON.stringify(earned)})setTimeout(()=>{total+=g;document.getElementById('s').textContent=total.toFixed(2)},t*1000);`);
}

// Countries: where an automatic reader works, or how to take part without one.
const COUNTRIES = {
  p1:      { flags: "🇳🇱 🇧🇪 🇱🇺 🇩🇰 🇸🇪 🇭🇺", head: "Your P1 meter reads itself ⚡", sub: "HomeWizard P1 + GreenUtilityLog: every kWh you save earns B3TR — no photos needed." },
  dach:    { flags: "🇩🇪 🇦🇹 🇨🇭", head: "Powerfox or Tasmota reader ⚡", sub: "Your meter sends its own reading — every kWh you save earns B3TR." },
  nordics: { flags: "🇳🇴 🇸🇪 🇩🇰 🇫🇮", head: "Tibber Pulse? You're set ⚡", sub: "Connect it once — every kWh you save earns B3TR, automatically." },
  na:      { flags: "🇺🇸 🇨🇦", head: "No P1 port? One photo 📸", sub: "Photograph your kWh meter — every kWh you save earns B3TR." },
};
function country(key) {
  const c = COUNTRIES[key];
  const flags = c.flags.split(" ").map((f, i) => `<span style="animation-delay:${0.2 + i * 0.22}s">${f}</span>`).join("");
  const after = 0.2 + c.flags.split(" ").length * 0.22;
  return page(`<div class="flags">${flags}</div><h1>${esc(c.head)}</h1><p>${esc(c.sub)}</p>
  <div class="sticker cta">greenutilitylog.github.io</div>`, `
  .flags{display:flex;gap:26px;font-size:96px;line-height:1}
  .flags span{opacity:0;animation:pop .5s cubic-bezier(.2,1.6,.4,1) forwards}
  h1{margin:36px 0 0;font-size:64px;font-weight:900;letter-spacing:-1.5px;text-align:center;opacity:0;animation:fadeUp .7s ease ${after + 0.2}s forwards}
  p{margin:16px 0 0;max-width:900px;font-size:32px;line-height:1.3;color:#cfe6d7;text-align:center;opacity:0;animation:fadeUp .7s ease ${after + 0.9}s forwards}
  .cta{margin-top:30px;font-size:28px;padding:10px 26px;opacity:0;animation:pop .5s cubic-bezier(.2,1.6,.4,1) ${after + 1.7}s forwards}`);
}

function sunday(q) {
  const question = q || "What uses the most electricity in your home?";
  return page(`<div class="kicker">Sunday question <span class="think">🤔</span></div>
  <h1 id="q"></h1><p>Log your meter 📸 · every kWh you save earns B3TR 💚</p>`, `
  .kicker{font-size:40px;font-weight:900;color:#a8e0bd;letter-spacing:1px;opacity:0;animation:fadeUp .6s ease .1s forwards}
  .think{display:inline-block;animation:tilt 1.2s ease-in-out .6s infinite}
  @keyframes tilt{0%,100%{transform:rotate(0)}50%{transform:rotate(-14deg)}}
  h1{margin:30px 0 0;min-height:2.4em;max-width:980px;font-size:62px;line-height:1.2;font-weight:900;letter-spacing:-1px;text-align:center}
  h1::after{content:"▍";color:#a8e0bd;animation:blink .8s steps(1) infinite}
  @keyframes blink{50%{opacity:0}}
  h1.done::after{content:none}
  p{margin:22px 0 0;font-size:32px;color:#cfe6d7;opacity:0;animation:fadeUp .7s ease forwards;animation-delay:var(--d)}`, `
  const q=${JSON.stringify(question)},h=document.getElementById('q'),step=Math.min(60,3200/q.length);
  document.querySelector('p').style.setProperty('--d',(0.8+q.length*step/1000+0.3)+'s');
  [...q].forEach((ch,i)=>setTimeout(()=>{h.textContent+=ch;if(i===q.length-1)setTimeout(()=>h.classList.add('done'),600)},800+i*step));`);
}

// title/desc: the share page's preview text (docs/share/<name>.html).
const VARIANTS = {
  meter:   { html: meter, secs: 7.2, title: "Use less electricity. Earn B3TR.", desc: "Log your meter — every kWh below the daily target earns B3TR on VeChain." },
  sprout:  { html: sprout, secs: 6.2, title: "Green Utility Log", desc: "Every kWh you save grows into B3TR. A VeBetterDAO x2earn app on VeChain." },
  week:    { html: week, secs: 7.2, title: "Below the line = B3TR", desc: "Stay under 8 kWh a day: every kWh you save earns B3TR." },
  p1:      { html: () => country("p1"), secs: 6.8, ...cardText("p1") },
  dach:    { html: () => country("dach"), secs: 6.4, ...cardText("dach") },
  nordics: { html: () => country("nordics"), secs: 6.6, ...cardText("nordics") },
  na:      { html: () => country("na"), secs: 6.2, ...cardText("na") },
  sunday:  { html: (opts) => sunday(opts.q), secs: 7.5, title: "Sunday question 🤔", desc: (opts) => `${opts.q || "What uses the most electricity in your home?"} Log your meter — every kWh you save earns B3TR.` },
};
function cardText(key) { const c = COUNTRIES[key]; return { title: `${c.head} ${c.flags.replace(/ /g, "")}`, desc: c.sub }; }

// A page per variant at …/GreenUtilityLog/share/<name>.html: its own preview card
// for links in posts (so not every post shows the same picture), and for a person
// a straight redirect to the app. Crawlers don't run scripts, so they read the
// tags; browsers run the script and land in the app.
const SITE = "https://greenutilitylog.github.io/GreenUtilityLog";
function sharePage(name, v, opts) {
  const title = esc(v.title), desc = esc(typeof v.desc === "function" ? v.desc(opts) : v.desc);
  const img = `${SITE}/share/${name}.png`, url = `${SITE}/share/${name}.html`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Green Utility Log</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Green Utility Log">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${img}">
<!-- Generated by brand/animated/render.cjs — edit there, not here. -->
<script>location.replace("../" + location.search + location.hash);</script>
</head>
<body style="margin:0;padding:40px 20px;background:#1f4532;color:#f2f7f3;font:18px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;text-align:center">
<p>${title}</p>
<p><a href="../" style="color:#a8e0bd;font-weight:700">Open Green Utility Log →</a></p>
</body>
</html>
`;
}

// ── Recording ────────────────────────────────────────────────────────────────
async function render(browser, name, v, opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gul-${name}-`));
  const file = path.join(tmp, "page.html");
  fs.writeFileSync(file, v.html(opts));
  // The video: recorded from the moment the page exists.
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 675 }, recordVideo: { dir: tmp, size: { width: 1200, height: 675 } } });
  const pg = await ctx.newPage();
  await pg.goto("file://" + file);
  await pg.waitForTimeout((v.secs + 0.6) * 1000);
  const video = await pg.video().path();
  await ctx.close();
  const mp4 = path.join(OUT, `${name}.mp4`), gif = path.join(OUT, `${name}.gif`);
  const ff = (args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
  ff(["-i", video, "-t", String(v.secs), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", "-an", mp4]);
  ff(["-i", mp4, "-vf", "fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", gif]);
  // The still card: the finished frame at the size link previews use.
  const still = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await still.goto("file://" + file);
  await still.waitForTimeout(v.secs * 1000);
  await still.screenshot({ path: path.join(SHARE, `${name}.png`) });
  fs.writeFileSync(path.join(SHARE, `${name}.html`), sharePage(name, v, opts));
  await still.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const kb = (f) => Math.round(fs.statSync(f).size / 1024);
  console.log(`${name}: mp4 ${kb(mp4)} KB · gif ${kb(gif)} KB · card docs/share/${name}.png`);
}

(async () => {
  const args = process.argv.slice(2);
  const opts = { q: (args.find((a) => a.startsWith("--q=")) || "").slice(4) };
  const names = args.filter((a) => !a.startsWith("--"));
  const todo = names.length ? names : Object.keys(VARIANTS);
  for (const n of todo) if (!VARIANTS[n]) { console.error(`unknown variant "${n}" — one of: ${Object.keys(VARIANTS).join(", ")}`); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHARE, { recursive: true });
  const browser = await chromium.launch();
  try { for (const n of todo) await render(browser, n, VARIANTS[n], opts); }
  finally { await browser.close(); }
})();
