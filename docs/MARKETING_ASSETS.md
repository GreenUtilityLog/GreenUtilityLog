# Marketing assets — screen-recording script, og-image, VeBetterDAO launch tweet

Companion to `MARKETING.md`. Three ready-to-use assets.

---

## 1. The how-to screen recording (your highest-converting asset)

Target: **30–45 seconds**, shot **vertically** on your phone (9:16) so it works as a
Twitter/X video, a Telegram pin, and a TikTok/Shorts/Reel. Record the real app on real
testnet. No fancy editing — clarity beats polish.

### Shot list + on-screen captions

| # | Time | What you show (screen) | On-screen caption (big text overlay) |
|---|------|------------------------|--------------------------------------|
| 1 | 0:00–0:04 | App home screen, your B3TR balance | **"Earn B3TR for saving energy 🌱"** |
| 2 | 0:04–0:09 | Tap "connect", VeWorld opens, approve | **"1. Connect VeWorld (testnet)"** |
| 3 | 0:09–0:15 | Tap the electricity meter / "new reading" | **"2. Pick your electricity meter"** |
| 4 | 0:15–0:22 | Camera opens, photograph the real meter | **"3. Snap your meter 📸"** |
| 5 | 0:22–0:28 | Reading auto-fills, tap submit, sign in VeWorld | **"4. Submit + sign"** |
| 6 | 0:28–0:38 | Success toast "+X B3TR", balance goes up | **"Done. Rewarded on-chain ✅"** |
| 7 | 0:38–0:45 | End card: logo + URL + "Testnet beta — testers wanted" | **"Try it 👉 [your URL]"** |

### Optional voiceover (if you talk over it — keep it casual)
> "This is Green Utility Log. You connect your VeWorld wallet, pick your electricity
> meter, take a photo of it, and submit. The reading goes on-chain as a VeBetterDAO
> proof-of-impact, and you earn B3TR for using less energy than usual. It's testnet
> right now — test tokens, no real value — and we're looking for testers. Link's below."

### Recording tips
- Clean the meter glass; good light; hold steady on the digits in shot 4.
- Pre-fund the wallet with VTHO **before** recording so there's no "insufficient energy"
  hiccup mid-take.
- If a step is slow (tx confirming), **cut/speed it up** — keep momentum.
- Record 2–3 takes; pick the cleanest. First frame should be eye-catching (the balance
  + leaf), because it's the thumbnail.

---

## 2. og-image (social preview card)

Files in `assets/`:
- `og-image.svg` — editable source (open in a browser or any vector tool)
- `og-image.png` — 1200×630, ready to upload

### Wire it into the site `<head>` (so links unfurl with the card)
Add to your `index.html` (adjust the absolute URL to your GitHub Pages path):
```html
<meta property="og:title" content="Green Utility Log — earn B3TR for saving energy" />
<meta property="og:description" content="Snap your electricity meter, log usage, earn B3TR. A VeBetterDAO x2earn app on VeChain. Testnet beta — testers wanted." />
<meta property="og:image" content="https://greenutilitylog.github.io/GreenUtilityLog/og-image.png" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="https://greenutilitylog.github.io/GreenUtilityLog/og-image.png" />
```
> Put `og-image.png` where the build publishes it (e.g. Vite's `public/` so it lands at
> the site root). Then validate with the X Card Validator / opengraph.xyz before launch.

---

## 3. VeBetterDAO-targeted launch tweet (for a possible RT)

Big-account retweets come from making it **easy and flattering to share** — tag them,
lead with the ecosystem, show you built it right, keep it to one tweet with the video.
Post this as its own tweet (not buried in the thread) and attach the 30s video.

> 🌱 New #VeBetterDAO x2earn app in testnet beta: **Green Utility Log**.
>
> Photograph your electricity meter → it's logged on-chain as a proof-of-impact → earn
> $B3TR for using less energy than your own average.
>
> Real-world sustainability, provable on @vechainofficial. Built anti-farm from day one.
>
> Testers welcome 👇 [APP URL]

**Variant B (shorter, punchier):**
> Proof-of-sustainability, one meter photo at a time. 📸🌱
>
> Green Utility Log is live in testnet beta — a #VeBetterDAO x2earn app where you earn
> $B3TR for saving real energy on @vechainofficial.
>
> Come test it 👉 [APP URL]

### How to actually get the RT (do these, not just hope)
- **Tag the right accounts:** @VeBetterDAO and @vechainofficial. Don't tag 10 — it reads
  as spam.
- **Attach the video.** Tweets with the 30s demo get far more reach + reshares than text.
- **Post when they're awake/active** (VeChain team skews CET/Asia hours).
- **Then engage their account genuinely** for a few days first — reply with substance on
  their posts so you're a familiar name when you @ them, not a cold link-drop.
- **Reply to your own tweet** with: "Built solo, in public. Feedback from the community
  shapes what ships next — gas, water, solar, streaks?" Builders-in-public get amplified.
- Drop it (briefly, respecting rules) in the **VeChain Discord** + **r/Vechain** so the
  team sees organic traction — that's what makes a project account hit RT.

> Honesty guardrails (keep in every post): testnet · "test-B3TR, no monetary value" ·
> never promise a mainnet date or price.
