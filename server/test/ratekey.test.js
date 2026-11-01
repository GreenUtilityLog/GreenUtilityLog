import { test } from "node:test";
import assert from "node:assert/strict";
import { rateKeyFor } from "../ratekey.js";

test("IPv4 counts per address, also written as IPv4-mapped IPv6", () => {
  assert.equal(rateKeyFor("203.0.113.7"), "203.0.113.7");
  assert.equal(rateKeyFor("::ffff:203.0.113.7"), "203.0.113.7");
});

test("IPv6 counts per /64, however the address is written", () => {
  const k = rateKeyFor("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
  assert.equal(k, "2001:db8:1:2::/64");
  assert.equal(rateKeyFor("2001:0db8:0001:0002::1"), k);
  assert.equal(rateKeyFor("2001:DB8:1:2:ffff::"), k);
  assert.notEqual(rateKeyFor("2001:db8:1:3::1"), k);
  assert.equal(rateKeyFor("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(rateKeyFor("::1"), "0:0:0:0::/64");
});

test("nothing usable still gives a key", () => {
  assert.equal(rateKeyFor(""), "unknown");
  assert.equal(rateKeyFor(undefined), "unknown");
});
