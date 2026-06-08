import sharp from 'sharp'

const sprout = `
  <path d="M256 380 C 247 330 250 300 256 256" fill="none" stroke="#eef6f0" stroke-width="18" stroke-linecap="round"/>
  <path d="M256 268 C 238 244 238 212 256 184 C 274 212 274 244 256 268 Z" fill="#eef6f0"/>
  <path d="M254 300 C 300 314 358 288 382 232 C 322 218 268 250 254 300 Z" fill="#eef6f0"/>
  <path d="M258 300 C 212 314 154 288 130 232 C 190 218 244 250 258 300 Z" fill="#eef6f0"/>
  <path d="M256 250 C 252 230 252 210 256 196" fill="none" stroke="#2c5743" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
  <path d="M270 288 C 312 282 344 264 366 240" fill="none" stroke="#2c5743" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
  <path d="M242 288 C 200 282 168 264 146 240" fill="none" stroke="#2c5743" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
`
const defs = `
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#142c1e"/><stop offset="0.55" stop-color="#214834"/><stop offset="1" stop-color="#3c6a50"/>
  </linearGradient>
  <radialGradient id="hl" cx="50%" cy="22%" r="80%">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.11"/><stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient>`
const FF = 'Liberation Sans, DejaVu Sans, sans-serif'

// Centered banner: tile + wordmark + tagline + pill, all horizontally centered.
function centeredBanner(w, h, { tile, wm, tag, pillW, pillFs, tagText=true }) {
  const cx = w/2
  const tileScale = tile.size/512
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>${defs}</defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <rect width="${w}" height="${h}" fill="url(#hl)"/>
    <g opacity="0.05" transform="translate(${cx-260},${h*0.1}) scale(1.0)">${sprout}</g>
    <g transform="translate(${cx - tile.size/2},${tile.y})">
      <rect width="${tile.size}" height="${tile.size}" rx="${tile.size*0.23}" fill="#0f2317" stroke="#34604a" stroke-width="2"/>
      <g transform="scale(${tileScale})">${sprout}</g>
    </g>
    <text x="${cx}" y="${wm.y}" text-anchor="middle" font-family="${FF}" font-weight="bold" font-size="${wm.fs}" letter-spacing="-1" fill="#f3f8f5">Green Utility Log</text>
    ${tagText ? `<text x="${cx}" y="${tag.y}" text-anchor="middle" font-family="${FF}" font-size="${tag.fs}" fill="#aeccbd">Track your meters. Earn B3TR rewards on VeChain.</text>`:''}
    <g transform="translate(${cx - pillW/2},${(tag.y||wm.y)+ (tagText?16:24)})">
      <rect width="${pillW}" height="${pillFs*2.1}" rx="${pillFs*1.05}" fill="#0f2317" stroke="#34604a" stroke-width="1.5"/>
      <text x="${pillW/2}" y="${pillFs*1.4}" text-anchor="middle" font-family="${FF}" font-weight="bold" font-size="${pillFs}" letter-spacing="2" fill="#88cc9e">POWERED BY VEBETTERDAO  ·  VECHAIN</text>
    </g>
  </svg>`
}

// 1240x460 centered
const b1240 = centeredBanner(1240, 460, {
  tile:{size:120, y:54}, wm:{y:268, fs:62}, tag:{y:312, fs:26}, pillW:360, pillFs:18,
})
// 800x400 veworld 2:1 centered
const b800 = centeredBanner(800, 400, {
  tile:{size:104, y:44}, wm:{y:232, fs:50}, tag:{y:272, fs:22}, pillW:320, pillFs:16,
})

// 720x720 square promo card
const cx = 360
const sq720 = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">
  <defs>${defs}</defs>
  <rect width="720" height="720" fill="url(#g)"/>
  <rect width="720" height="720" fill="url(#hl)"/>
  <g opacity="0.045" transform="translate(120,360) scale(1.6)">${sprout}</g>
  <g transform="translate(${cx-95},150)">
    <rect width="190" height="190" rx="44" fill="#0f2317" stroke="#34604a" stroke-width="2"/>
    <g transform="scale(${190/512})">${sprout}</g>
  </g>
  <text x="${cx}" y="448" text-anchor="middle" font-family="${FF}" font-weight="bold" font-size="58" letter-spacing="-1" fill="#f3f8f5">Green Utility Log</text>
  <text x="${cx}" y="494" text-anchor="middle" font-family="${FF}" font-size="25" fill="#aeccbd">Track meters. Earn B3TR on VeChain.</text>
  <g transform="translate(${cx-190},520)">
    <rect width="380" height="42" rx="21" fill="#0f2317" stroke="#34604a" stroke-width="1.5"/>
    <text x="190" y="28" text-anchor="middle" font-family="${FF}" font-weight="bold" font-size="18" letter-spacing="2" fill="#88cc9e">POWERED BY VEBETTERDAO · VECHAIN</text>
  </g>
</svg>`

const buf = s => Buffer.from(s)
await sharp(buf(b1240)).png().toFile('brand/banner-1240x460.png')
await sharp(buf(b800)).png().toFile('brand/veworld-banner-800x400.png')
await sharp(buf(sq720)).png().toFile('brand/square-720x720.png')
// plain icon at 720 too (in case they want a bare logo at that size)
console.log('done')
