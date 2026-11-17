// ── Access mode "gm": VeBetterDAO's member rule, plus the Passport ─────────────
// Mainnet is for VeBetterDAO members. A wallet gets in when ALL of these hold
// (galaxy.js memberCheck, index.js gmStatus):
//   - it has a Galaxy Member (GM) NFT;
//   - it is a Passport's own wallet, not one linked to another Passport;
//   - it has no signals in the Passport;
//   - it voted in the last allocation round;
//   - the GM NFT it voted with is still its own, at level 2 (Moon) or higher;
//   - the Passport counts it as a person.
// Checked on chain at connect and at every payout. Admins always get in; a role
// gives no access in this mode. A check that can't be read means "try again".

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { ABIFunction } from "@vechain/sdk-core";
import { startServer, fakeNode, adminSigner, photo } from "./helpers.mjs";
import { defaultAccess } from "../config.js";

// The testnet contracts (config.js).
const GM = "0x38a59fa7fd7039884465a0ff285b8c4b6fe394ca";
const PASSPORT = "0x592c756df7a5d39de1735030e8b9c18b7417e6c4";
const VOTING = "0x8800592c463f0b21ae08732559ee8e146db1d7b2";
const REWARDS = "0x851ef91801899a4e7e4a3174a9300b3e20c957e8";

const sel = (name, inputs) => new ABIFunction({ name, type: "function", stateMutability: "view", inputs: inputs.map((t, i) => ({ name: `a${i}`, type: t })), outputs: [] }).signatureHash.slice(0, 10);
const S = {
  balanceOf: sel("balanceOf", ["address"]),
  isPerson: sel("isPerson", ["address"]),
  isEntity: sel("isEntity", ["address"]),
  signaledCounter: sel("signaledCounter", ["address"]),
  currentRoundId: sel("currentRoundId", []),
  roundSnapshot: sel("roundSnapshot", ["uint256"]),
  hasVoted: sel("hasVoted", ["uint256", "address"]),
  getSelectedTokenId: sel("getSelectedTokenId", ["address"]),
  getSelectedTokenIdAtBlock: sel("getSelectedTokenIdAtBlock", ["address", "uint48"]),
  hasTokenVoted: sel("hasTokenVoted", ["uint256", "uint256"]),
  ownerOf: sel("ownerOf", ["uint256"]),
  levelOf: sel("levelOf", ["uint256"]),
};
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const hex = (...ws) => "0x" + ws.map(word).join("");
const boolAndString = (b, str) => {
  const s = Buffer.from(str, "utf8");
  return "0x" + word(b ? 1 : 0) + word(64) + word(s.length) + s.toString("hex").padEnd(Math.max(64, Math.ceil(s.length / 32) * 64), "0");
};

const ROUND = 50n, ROUND_START = 1000n; // the current round, and the last one's start block
const addr = (b) => "0x" + b.repeat(20);
const OTHER = addr("ee");
// Each wallet passes every check but the one it is named for.
const W = {
  FULL: addr("a1"), GM_ONLY: addr("a2"), NONE: addr("a3"), TESTER: addr("a4"), UNREAD: addr("a5"), PP_UNREAD: addr("a6"),
  LINKED: addr("b1"), SIGNALED: addr("b2"), NOVOTE: addr("b3"), LEVEL1: addr("b4"), SOLD: addr("b5"), TOKEN_NOT_VOTED: addr("b6"),
  SWITCHED: addr("b7"), VOTE_UNREAD: addr("b8"),
};
const base = (token) => ({ gm: 1, entity: false, signals: 0, voted: true, atStart: token, now: token, person: [true, "User is a Galaxy Member"] });
const world = {
  [W.FULL]: base(7),
  [W.GM_ONLY]: { ...base(11), person: [false, "User has been signaled too many times"] },
  [W.NONE]: { ...base(0), gm: 0, voted: false },
  [W.TESTER]: { ...base(0), gm: 0, voted: false },
  [W.UNREAD]: { ...base(0), gm: null },
  [W.PP_UNREAD]: { ...base(12), person: null },
  [W.LINKED]: { ...base(13), entity: true },
  [W.SIGNALED]: { ...base(14), signals: 2 },
  [W.NOVOTE]: { ...base(15), voted: false },
  [W.LEVEL1]: base(16),
  [W.SOLD]: base(17),
  [W.TOKEN_NOT_VOTED]: base(18),
  // Selected NFT 19 at the round's start, switched to 20 and voted with that one:
  // only the NFT at the round's start counts (owner's choice), so out.
  [W.SWITCHED]: { ...base(19), now: 20 },
  [W.VOTE_UNREAD]: { ...base(21), voted: null },
};
// token → { owner, level, voted (in the last round) }
const tokens = {
  7: { owner: W.FULL, level: 2, voted: true }, 11: { owner: W.GM_ONLY, level: 3, voted: true }, 12: { owner: W.PP_UNREAD, level: 2, voted: true },
  13: { owner: W.LINKED, level: 2, voted: true }, 14: { owner: W.SIGNALED, level: 2, voted: true }, 15: { owner: W.NOVOTE, level: 2, voted: false },
  16: { owner: W.LEVEL1, level: 1, voted: true }, 17: { owner: OTHER, level: 4, voted: true }, 18: { owner: W.TOKEN_NOT_VOTED, level: 5, voted: false },
  19: { owner: W.SWITCHED, level: 2, voted: false }, 20: { owner: W.SWITCHED, level: 3, voted: true }, 21: { owner: W.VOTE_UNREAD, level: 2, voted: true },
};

const args = (data) => (data.slice(10).match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
const asAddr = (n) => "0x" + n.toString(16).padStart(40, "0");
function onCall(to, data) {
  const s = data.slice(0, 10), a = args(data);
  const who = a.length ? asAddr(a[0]) : null;
  if (to === GM && s === S.balanceOf) { const w = world[who]; return w && w.gm != null ? hex(w.gm) : null; }
  if (to === PASSPORT && s === S.isPerson) {
    const w = world[who]; if (!w || w.person === null) return null;
    return boolAndString(w.person[0], w.person[1]);
  }
  if (to === PASSPORT && s === S.isEntity) return hex(world[who]?.entity ? 1 : 0);
  if (to === PASSPORT && s === S.signaledCounter) return hex(world[who]?.signals ?? 0);
  if (to === VOTING && s === S.currentRoundId) return hex(ROUND);
  if (to === VOTING && s === S.roundSnapshot) return a[0] === ROUND - 1n ? hex(ROUND_START) : hex(0);
  if (to === VOTING && s === S.hasVoted) {
    const w = world[asAddr(a[1])]; if (a[0] !== ROUND - 1n) return hex(0);
    return w?.voted == null ? null : hex(w.voted ? 1 : 0);
  }
  if (to === GM && s === S.getSelectedTokenIdAtBlock) return a[1] === ROUND_START ? hex(world[who]?.atStart ?? 0) : hex(0);
  if (to === GM && s === S.getSelectedTokenId) return hex(world[who]?.now ?? 0);
  if (to === REWARDS && s === S.hasTokenVoted) return hex(a[1] === ROUND_START && tokens[a[0]]?.voted ? 1 : 0);
  if (to === GM && s === S.ownerOf) { const t = tokens[a[0]]; return t ? hex(BigInt(t.owner)) : null; }
  if (to === GM && s === S.levelOf) return hex(tokens[a[0]]?.level ?? 0);
  return null;
}

test("mainnet starts on gm, testnet as REQUIRE_PASS says", () => {
  assert.equal(defaultAccess("mainnet", true), "gm");
  assert.equal(defaultAccess("mainnet", false), "gm");
  assert.equal(defaultAccess("testnet", true), "roles");
  assert.equal(defaultAccess("testnet", false), "everyone");
});

describe("access mode gm", () => {
  let srv, node, admin;
  // Each wallet from its own address: the per-IP limit (30 a minute) isn't what's tested.
  let n = 0;
  const ip = () => `10.0.${Math.floor(++n / 200)}.${n % 200 + 1}`;
  const post = (path, body, extra = {}) => fetch(srv.base + path, {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip(), ...extra }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const seen = (address) => post("/wallet/seen", { address });
  const pay = (address, lang) => fetch(srv.base + "/reward", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip(), ...(lang ? { "X-GUL-Lang": lang } : {}) },
    body: JSON.stringify({ utility: "electric", meterNo: "E1", address, reading: 1, photo: photo(address) }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  before(async () => {
    node = await fakeNode("ok", { onCall });
    admin = await adminSigner();
    srv = await startServer({
      state: { settings: { access: "gm" }, passes: { [W.TESTER]: { no: 1, issuedAt: Date.now(), issuedBy: null, tier: "tester", note: "" } }, passSeq: 1, passesInit: 1 },
      env: { NODE_URL: node.url, ADMIN_WALLETS: admin.address },
    });
  });
  after(async () => { await srv.stop(); node.srv.close(); });

  test("every check passes: in, and the app sees each one", async () => {
    const r = await seen(W.FULL);
    assert.equal(r.body.access, "gm");
    assert.equal(r.body.hasPass, true);
    assert.deepEqual(r.body.gmAccess, { has: true, main: true, clean: true, voted: true, gm: true, level: 2, person: true });
  });

  // One wallet per rule: out, with that rule's reason at the payout.
  for (const [name, field, reason] of [
    ["LINKED", "main", /linked to another VeBetterDAO Passport/],
    ["SIGNALED", "clean", /has been signaled in its VeBetterDAO Passport/],
    ["NOVOTE", "voted", /needs a vote in the last VeBetterDAO allocation round/],
    ["LEVEL1", "gm", /level 2 \(Moon\) or higher/],
    ["SOLD", "gm", /level 2 \(Moon\) or higher and still in this wallet/],
    ["TOKEN_NOT_VOTED", "gm", /the GM NFT you voted with/],
  ]) {
    test(`${name.toLowerCase().replace(/_/g, " ")}: out (${field} is false), and told why`, async () => {
      const r = await seen(W[name]);
      assert.equal(r.body.hasPass, false, JSON.stringify(r.body));
      assert.equal(r.body.gmAccess[field], false, JSON.stringify(r.body.gmAccess));
      const p = await pay(W[name]);
      assert.equal(p.status, 403);
      assert.equal(p.body.needsPass, true);
      assert.match(p.body.error, reason);
    });
  }

  test("level 1 is named: the app can say which level the voted NFT has", async () => {
    assert.equal((await seen(W.LEVEL1)).body.gmAccess.level, 1);
  });

  test("switched GM NFT mid-round: the one selected at the round's start counts, and it didn't vote", async () => {
    const r = await seen(W.SWITCHED);
    assert.equal(r.body.hasPass, false, JSON.stringify(r.body));
    assert.equal(r.body.gmAccess.gm, false);
  });

  test("everything but the Passport: out, and told why", async () => {
    const r = await seen(W.GM_ONLY);
    assert.equal(r.body.hasPass, false);
    assert.equal(r.body.gmAccess.gm, true);
    assert.equal(r.body.gmAccess.person, false);
    const p = await pay(W.GM_ONLY);
    assert.equal(p.status, 403);
    assert.match(p.body.error, /Passport doesn't count it as a person/);
  });

  test("no GM NFT: out, and told what is needed (in the app's language)", async () => {
    const r = await seen(W.NONE);
    assert.equal(r.body.hasPass, false);
    assert.equal(r.body.gmAccess.has, false);
    assert.equal(r.body.gmAccess.gm, false);
    const p = await pay(W.NONE, "nl");
    assert.equal(p.status, 403);
    assert.match(p.body.error, /voor leden van VeBetterDAO/);
    assert.match(p.body.errorEn, /Galaxy Member \(GM\) NFT and a VeBetterDAO Passport/);
  });

  test("a role without a GM NFT gives no access in this mode", async () => {
    assert.equal((await seen(W.TESTER)).body.hasPass, false);
  });

  test("the GM NFT can't be read: out for now, and says so", async () => {
    const r = await seen(W.UNREAD);
    assert.equal(r.body.hasPass, false);
    assert.equal(r.body.gmAccess.has, null);
    const p = await pay(W.UNREAD);
    assert.equal(p.status, 403);
    assert.match(p.body.error, /couldn't check this wallet's VeBetterDAO GM NFT/);
  });

  test("the vote can't be read: out for now, told to try again (not that it didn't vote)", async () => {
    const r = await seen(W.VOTE_UNREAD);
    assert.equal(r.body.hasPass, false);
    assert.equal(r.body.gmAccess.voted, null);
    const p = await pay(W.VOTE_UNREAD);
    assert.equal(p.status, 403);
    assert.match(p.body.error, /couldn't check this wallet on VeBetterDAO right now/);
  });

  test("the Passport can't be read: out for now, told to try again (not that it doesn't count)", async () => {
    const r = await seen(W.PP_UNREAD);
    assert.equal(r.body.hasPass, false);
    assert.equal(r.body.gmAccess.person, null);
    const p = await pay(W.PP_UNREAD);
    assert.equal(p.status, 403);
    assert.match(p.body.error, /couldn't check this wallet's VeBetterDAO Passport/);
  });

  test("the payout gate lets the full wallet through (it fails later, on the photo, not on access)", async () => {
    const p = await post("/reward", { utility: "electric", meterNo: "E1", address: W.FULL, reading: 1, photo: "x" });
    assert.notEqual(p.body.needsPass, true, JSON.stringify(p.body));
  });

  test("the admin always gets in, without a GM NFT", async () => {
    assert.equal((await seen(admin.address)).body.hasPass, true);
  });

  test("an admin can switch between gm, roles and everyone", async () => {
    let r = await admin.call(srv, "/admin/access", { mode: "roles" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const roleSeen = await seen(W.TESTER);
    assert.equal(roleSeen.body.hasPass, true, "in roles mode the role counts again: " + JSON.stringify(roleSeen));
    r = await admin.call(srv, "/admin/access", { mode: "gm" });
    assert.equal(r.body.access, "gm");
    assert.equal((await seen(W.TESTER)).body.hasPass, false);
    r = await admin.call(srv, "/admin/access", { mode: "nonsense" });
    assert.equal(r.status, 400);
  });
});
