import sharp from 'sharp'
const sprout = `
  <path d="M256 380 C 247 330 250 300 256 256" fill="none" stroke="#eef6f0" stroke-width="20" stroke-linecap="round"/>
  <path d="M256 268 C 238 244 238 212 256 184 C 274 212 274 244 256 268 Z" fill="#eef6f0"/>
  <path d="M254 300 C 300 314 358 288 382 232 C 322 218 268 250 254 300 Z" fill="#eef6f0"/>
  <path d="M258 300 C 212 314 154 288 130 232 C 190 218 244 250 258 300 Z" fill="#eef6f0"/>`
const FF='Liberation Sans, DejaVu Sans, sans-serif'
const W=440,H=880, cx=W/2
const tile=120, tx=cx-tile/2, ty=232
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
 <defs>
   <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a3326"/><stop offset="1" stop-color="#264d3a"/></linearGradient>
   <linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#142c1e"/><stop offset="0.55" stop-color="#214834"/><stop offset="1" stop-color="#3c6a50"/></linearGradient>
 </defs>
 <rect width="${W}" height="${H}" fill="url(#bg)"/>
 <rect x="0" y="0" width="${W}" height="3" fill="rgba(255,255,255,0.12)"/>
 <rect x="0" y="0" width="${W*0.25}" height="3" fill="#4CAF50"/>
 <g transform="translate(${tx},${ty})">
   <rect width="${tile}" height="${tile}" rx="${Math.round(tile*0.23)}" fill="url(#tg)"/>
   <g transform="scale(${tile/512})">${sprout}</g>
 </g>
 <text x="${cx}" y="445" text-anchor="middle" font-family="${FF}" font-weight="bold" font-size="34" fill="#ffffff" letter-spacing="-0.6">Welcome to</text>
 <text x="${cx}" y="487" text-anchor="middle" font-family="${FF}" font-weight="bold" font-size="34" fill="#ffffff" letter-spacing="-0.6">Green Utility Log</text>
 <text x="${cx}" y="545" text-anchor="middle" font-family="${FF}" font-size="16" fill="rgba(255,255,255,0.8)">Track your electric, gas, water &amp; solar meters.</text>
 <text x="${cx}" y="571" text-anchor="middle" font-family="${FF}" font-size="16" fill="rgba(255,255,255,0.8)">Earn real B3TR rewards on VeChain.</text>
 <g transform="translate(${cx-39},690)">
   <rect x="0" y="0" width="24" height="6" rx="3" fill="#4CAF50"/>
   <rect x="30" y="0" width="6" height="6" rx="3" fill="rgba(255,255,255,0.3)"/>
   <rect x="44" y="0" width="6" height="6" rx="3" fill="rgba(255,255,255,0.3)"/>
   <rect x="58" y="0" width="6" height="6" rx="3" fill="rgba(255,255,255,0.3)"/>
 </g>
 <g transform="translate(${cx-140},740)">
   <rect width="280" height="54" rx="8" fill="#4CAF50"/>
   <text x="140" y="34" text-anchor="middle" font-family="${FF}" font-weight="bold" font-size="14" letter-spacing="1.4" fill="#ffffff">GET STARTED</text>
 </g>
 <text x="${cx}" y="828" text-anchor="middle" font-family="${FF}" font-weight="bold" font-size="11" letter-spacing="1" fill="rgba(255,255,255,0.6)">SKIP</text>
</svg>`
await sharp(Buffer.from(svg)).png().toFile('brand/intro-preview.png')
console.log('done')
