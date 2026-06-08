import sharp from 'sharp'

// Shared 3-leaf sprout (matches the app's 🌱 identity), drawn in a 0..512 box.
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
    <stop offset="0" stop-color="#142c1e"/>
    <stop offset="0.55" stop-color="#214834"/>
    <stop offset="1" stop-color="#3c6a50"/>
  </linearGradient>
  <radialGradient id="hl" cx="30%" cy="24%" r="85%">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.12"/>
    <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient>
`

// ---- App icon (square, full-bleed rounded squircle) ----
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#g)"/>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#hl)"/>
  ${sprout}
</svg>`

// ---- Banner (3:1 landscape) ----
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
  <defs>${defs}
    <clipPath id="bg"><rect x="0" y="0" width="1500" height="500" rx="0"/></clipPath>
  </defs>
  <rect x="0" y="0" width="1500" height="500" fill="url(#g)"/>
  <rect x="0" y="0" width="1500" height="500" fill="url(#hl)"/>
  <!-- faint oversized sprout watermark on the right -->
  <g clip-path="url(#bg)" opacity="0.06" transform="translate(1120,-40) scale(1.7)">${sprout}</g>
  <!-- logo tile -->
  <g transform="translate(96,150)">
    <rect x="0" y="0" width="200" height="200" rx="46" fill="#0f2317" stroke="#34604a" stroke-width="2"/>
    <g transform="scale(0.39)">${sprout}</g>
  </g>
  <!-- wordmark + tagline -->
  <text x="336" y="232" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-weight="bold" font-size="94" letter-spacing="-1" fill="#f3f8f5">Green Utility Log</text>
  <text x="340" y="292" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-size="34" fill="#aeccbd">Track your meters. Earn B3TR rewards on VeChain.</text>
  <g transform="translate(340,322)">
    <rect x="0" y="0" width="430" height="44" rx="22" fill="#0f2317" stroke="#34604a" stroke-width="1.5"/>
    <text x="22" y="30" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-weight="bold" font-size="20" letter-spacing="2" fill="#88cc9e">POWERED BY VEBETTERDAO  ·  VECHAIN</text>
  </g>
</svg>`

const buf = (s) => Buffer.from(s)
await sharp(buf(icon)).resize(512,512).png().toFile('brand/logo-512.png')
await sharp(buf(icon)).resize(1024,1024).png().toFile('brand/logo-1024.png')
await sharp(buf(icon)).resize(256,256).png().toFile('brand/logo-256.png')
await sharp(buf(banner)).png().toFile('brand/banner-1500x500.png')
console.log('rendered:', ...['logo-512','logo-1024','logo-256','banner-1500x500'])
