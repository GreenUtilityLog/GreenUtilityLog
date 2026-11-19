// ── memberCheck: a node that fails is "try again", not "no" ───────────────────
// ownerOf reverts for a burned token (then: not this wallet's). A node error on it
// used to count the same way and refuse a wallet that qualifies, cached for 30 s.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ABIFunction } from "@vechain/sdk-core";

const sel = (name, types) => new ABIFunction({ name, type: "function", stateMutability: "view", inputs: types.map((t, i) => ({ name: `a${i}`, type: t })), outputs: [] }).signatureHash.slice(0, 10);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
// One wallet per case (answers are cached per wallet): its selected GM NFT is the
// token with its own first byte, and ownerOf for that token fails, reverts, or
// names the wallet.
const ERR = "0x" + "a1".repeat(20), REV = "0x" + "a2".repeat(20), OK = "0x" + "a3".repeat(20);
const ANS = {
  [sel("isEntity", ["address"])]: word(0), [sel("signaledCounter", ["address"])]: word(0),
  [sel("currentRoundId", [])]: word(50), [sel("roundSnapshot", ["uint256"])]: word(1000),
  [sel("hasVoted", ["uint256", "address"])]: word(1),
  [sel("hasTokenVoted", ["uint256", "uint256"])]: word(1), [sel("levelOf", ["uint256"])]: word(3),
};
const AT_BLOCK = sel("getSelectedTokenIdAtBlock", ["address", "uint48"]);
const OWNER_OF = sel("ownerOf", ["uint256"]);

test("ownerOf: a node error is \"couldn't read\", a revert is \"not this wallet's\"", async () => {
  const node = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const data = String(JSON.parse(b || "{}").data || ""), s = data.slice(0, 10), arg = data.slice(10, 74);
      const byte = arg.slice(-2);
      if (s === OWNER_OF && byte === "a1") { res.statusCode = 502; return res.end("bad gateway"); }
      const out = s === AT_BLOCK ? word(parseInt(byte, 16))
        : s === OWNER_OF ? (byte === "a2" ? null : "0".repeat(24) + byte.repeat(20))
        : ANS[s];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out ? { data: "0x" + out, reverted: false } : { data: "0x", reverted: true }));
    });
  });
  await new Promise((r) => node.listen(0, "127.0.0.1", r));
  process.env.NETWORK = "testnet";
  process.env.NODE_URL = `http://127.0.0.1:${node.address().port}`;
  const { memberCheck } = await import("../galaxy.js");
  try {
    assert.equal((await memberCheck(ERR)).gm, null, "node error → couldn't read (try again)");
    assert.equal((await memberCheck(REV)).gm, false, "burned token → not this wallet's");
    assert.equal((await memberCheck(OK)).gm, true, "this wallet's");
  } finally { node.close(); }
});
