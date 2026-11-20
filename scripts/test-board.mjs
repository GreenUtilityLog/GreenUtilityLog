// The leaderboard's week and streak (src/board.js). Run: node scripts/test-board.mjs
import assert from "node:assert/strict";
import { rankBoard, streakOf, weekStartOf } from "../src/board.js";
const D = 86400000;
// Wednesday 2026-11-18 15:00 local
const now = new Date(2026, 10, 18, 15).getTime();
assert.equal(new Date(weekStartOf(now)).getDay(), 1); assert.equal(new Date(weekStartOf(now)).getDate(), 16);
const old = { addr: "0xold", b3tr: 100, count: 50, pays: [[now - 30 * D, 100]] };
const fresh = { addr: "0xnew", b3tr: 3, count: 2, pays: [[now - D, 1.5], [now - 2 * 3600e3, 1.5]] };
const all = rankBoard([old, fresh], { period: "all", now });
assert.equal(all[0].addr, "0xold");
const week = rankBoard([old, fresh], { period: "week", now });
assert.equal(week.length, 1, "no payout this week: not in the week board");
assert.equal(week[0].addr, "0xnew"); assert.equal(week[0].b3tr, 3); assert.equal(week[0].rank, 1);
const meWeek = rankBoard([old, fresh], { period: "week", me: "0xold", now });
assert.equal(meWeek.find((r) => r.isMe).b3tr, 0, "me at 0 this week");
assert.equal(streakOf(fresh.pays, now), 2, "yesterday and today");
assert.equal(streakOf([[now - D, 1], [now - 2 * D, 1]], now), 2, "ending yesterday still counts");
assert.equal(streakOf([[now - 2 * D, 1]], now), 0, "a gap breaks it");
assert.equal(streakOf([[now, 0]], now), 0, "a zero payout isn't a day");
// last week's Sunday 23:00 is not this week
assert.equal(rankBoard([{ addr: "a", b3tr: 1, count: 1, pays: [[weekStartOf(now) - 3600e3, 1]] }], { period: "week", now }).length, 0);
console.log("board ok");
