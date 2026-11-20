// ── The leaderboard: this week or all time, with each wallet's streak ────────
// Pure functions over the on-chain rows (leaderboard.js: one row per wallet, with
// every payout's time and amount), so they can be tested without a browser.
//
// "This week" starts on Monday 00:00 local time, as on Home: a newcomer can lead
// it from their first week. The streak is the number of days in a row with a
// payout, ending today or yesterday (today's reading may still come).

const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

// Monday 00:00 of the week `now` is in, local time (calendar days: DST-safe).
export function weekStartOf(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
}

export function streakOf(pays, now = Date.now()) {
  const days = new Set((pays || []).filter(([, b]) => b > 0).map(([t]) => dayKey(t)));
  const d = new Date(now);
  let day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (!days.has(dayKey(day.getTime()))) day = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(day.getTime()))) { n++; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1); }
  return n;
}

// rows: [{ addr, b3tr, count, pays: [[ms, b3tr], …] }] → ranked
// [{ addr, b3tr, count, streak, isMe, rank }]. `period` is "week" or "all". The
// connected wallet is always in it, at 0 when it has nothing in that period. In
// "week", wallets without a payout this week are left out.
export function rankBoard(rows, { period = "all", me = null, now = Date.now() } = {}) {
  const from = period === "week" ? weekStartOf(now) : -Infinity;
  const out = (rows || []).map((r) => {
    const pays = (r.pays || []).filter(([t]) => t >= from);
    return {
      addr: r.addr,
      b3tr: period === "week" ? +pays.reduce((a, [, b]) => a + b, 0).toFixed(4) : r.b3tr,
      count: period === "week" ? pays.length : r.count,
      streak: streakOf(r.pays, now),
      isMe: !!me && r.addr === me,
    };
  }).filter((r) => period !== "week" || r.count > 0 || r.isMe);
  if (me && !out.some((r) => r.isMe)) out.push({ addr: me, b3tr: 0, count: 0, streak: 0, isMe: true });
  return out.sort((a, b) => b.b3tr - a.b3tr || b.streak - a.streak).map((r, i) => ({ ...r, rank: i + 1 }));
}
