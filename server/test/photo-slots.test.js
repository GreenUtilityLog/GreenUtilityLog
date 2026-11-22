// ── Slow uploads can't hold the photo slots ──────────────────────────────────
// Six uploads that never finish (a byte every few seconds, from three addresses,
// no wallet needed) used to hold all six photo slots, and every real photo
// submission was told "the server is busy". Slots now count only bodies that have
// arrived, and an upload gets PHOTO_UPLOAD_MS to arrive.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startServer } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function slowUpload(port, ip) {
  const s = net.connect(port, "127.0.0.1");
  s.on("error", () => {});
  s.write(`POST /reward HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 8000000\r\nCF-Connecting-IP: ${ip}\r\n\r\n{"a":`);
  const drip = setInterval(() => { try { s.write(" "); } catch { /* closed */ } }, 300);
  return { s, stop: () => { clearInterval(drip); s.destroy(); } };
}
const post = (base, path, ip) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ address: "0x1111111111111111111111111111111111111111" }) });

test("six never-ending uploads from three addresses: a real submission still gets through", async () => {
  const srv = await startServer({ env: { PHOTO_UPLOAD_MS: "2000" } });
  const port = Number(new URL(srv.base).port);
  const slow = [0, 0, 1, 1, 2, 2].map((n) => slowUpload(port, `10.9.9.${n}`));
  try {
    await sleep(400);
    const r = await post(srv.base, "/reward", "10.8.8.8");
    assert.notEqual(r.status, 503, "not 'the server is busy'");
    // The slow ones are dropped once their time is up.
    await sleep(2500);
    const closed = slow.map((x) => x.s.destroyed || x.s.readableEnded);
    assert.ok(closed.every(Boolean), `dropped: ${closed}`);
  } finally { slow.forEach((x) => x.stop()); await srv.stop(); }
});

test("still two uploads at a time per address", async () => {
  const srv = await startServer({ env: { PHOTO_UPLOAD_MS: "5000" } });
  const port = Number(new URL(srv.base).port);
  const slow = [slowUpload(port, "10.7.7.7"), slowUpload(port, "10.7.7.7")];
  try {
    await sleep(400);
    const r = await post(srv.base, "/reward", "10.7.7.7");
    assert.equal(r.status, 429);
  } finally { slow.forEach((x) => x.stop()); await srv.stop(); }
});
