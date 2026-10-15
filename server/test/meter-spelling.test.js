// One meter, one wallet — whatever the spelling of its number. "E1000", "E-1000"
// and "e 1000" are the same sticker; the photo check reads only letters and digits.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline, OTHER } from "./helpers.mjs";

describe("a meter number spelled differently is still the same meter", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline({ meterNo: "E1000" }) }); });
  after(async () => { await srv.stop(); });

  for (const spelling of ["E-1000", "e 1000", "E.1000"]) {
    test(`"${spelling}" belongs to the wallet that owns E1000`, async () => {
      const r = await srv.post("/reward", { utility: "electric", meterNo: spelling, address: OTHER, reading: 1005, prevRead: 1000, photo: photo(spelling), photoMime: "image/jpeg" });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /registered to another wallet/);
    });
  }
});
