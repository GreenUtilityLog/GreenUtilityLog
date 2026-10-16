// ── Store-level fixes from the money-path audit ──────────────────────────────
// Run against the store module directly (file backend in a temp dir).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store;
before(async () => {
  process.env.STATE_FILE = join(tmpdir(), `gul-store-${process.pid}-${Math.random()}.json`);
  delete process.env.UPSTASH_REDIS_REST_URL;
  ({ store } = await import("../store.js"));
  for (let i = 0; i < 50 && !store.loaded(); i++) await new Promise((r) => setTimeout(r, 20));
});

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("a renamed meter keeps its photo date and one-time corrections", () => {
  store.bindMeter("electric", "e-old", A);
  store.setLastReading("electric", "e-old", 1000);
  store.setPhotoAt("electric", "e-old", 12345);
  store.markRebased("electric", "e-old", { by: "test" });
  store.markBasisFixed("electric", "e-old", { by: "test" });
  store.markAutoPaid("electric", "e-old");
  store.renameMeter("electric", "e-old", "e-new", A);
  assert.equal(store.photoAt("electric", "e-new"), 12345);
  assert.ok(store.rebasedAt("electric", "e-new"));
  assert.ok(store.basisFixedAt("electric", "e-new"));
  assert.ok(store.autoPaidAt("electric", "e-new"));
  assert.ok(store.lastReadingAt("electric", "e-new"));
  assert.equal(store.photoAt("electric", "e-old"), null);
});

test("reading the eco claims doesn't write them", () => {
  const before = JSON.stringify(store.ecoClaims(A));
  assert.equal(before, "[]");
  store.addEcoClaim(A, Date.now());
  assert.equal(store.ecoClaims(A).length, 1);
  // An old claim is pruned when the next one is added, not when read.
  store.addEcoClaim(B, Date.now() - 30 * 86400000);
  assert.equal(store.ecoClaims(B).length, 0);
  store.addEcoClaim(B, Date.now());
  assert.equal(store.ecoClaims(B).length, 1);
});

test("a wallet taken off a phone frees its slot, others stay", () => {
  store.linkDevice("i:phone", A);
  store.linkDevice("i:phone", B);
  store.unlinkDevice("i:phone", B);
  assert.deepEqual(store.deviceWallets("i:phone"), [A]);
  store.unlinkDevice("i:phone", A);
  assert.deepEqual(store.deviceWallets("i:phone"), []);
});

test("pairing finds the spelling the meter's state is kept under", () => {
  store.bindMeter("electric", "e1000", A);
  assert.equal(store.ownedSpelling("electric", "E-1000", A), "e1000");
  assert.equal(store.ownedSpelling("electric", "E-1000", B), "E-1000");
});

test("an overlapping number of another wallet's meter is found", () => {
  store.bindMeter("electric", "e12345678", A);
  assert.equal(store.meterOverlapOwner("electric", "2345678", B), A);
  assert.equal(store.meterOverlapOwner("electric", "2345678", A), null);
  assert.equal(store.meterOverlapOwner("electric", "99887766", B), null);
});
