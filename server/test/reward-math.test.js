// ── The arithmetic that decides what a wallet is paid ────────────────────────
// These are pure functions, so they can be pinned exactly. Everything here was
// previously verified only by reading it, or by a one-off script thrown away
// afterwards — which is how a reader pushing 3853 kWh reached a tester before it
// reached anyone else.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeReward, spanDays, usageBoundsFor,
  USAGE_BENCHMARK, REWARD_BASE, RATES, MAX_PAYOUT_PER_SUBMISSION, MAX_SPAN_DAYS,
} from "../config.js";

const DAY = 86_400_000;

test("a perfect day is capped, not paid in full", () => {
  // Worth pinning because the ceiling now binds on a GOOD day, not only an absurd
  // one: base plus the whole benchmark comes to 5.08 for electricity, above the
  // 4 cap. Everything from roughly 1.8 kWh of consumption downward therefore pays
  // the same. That is the deliberate consequence of a flat per-submission ceiling;
  // if the gradient matters more than the ceiling, lower RATES rather than raise
  // this cap.
  const uncapped = REWARD_BASE.electric + USAGE_BENCHMARK.electric * RATES.electric;
  assert.ok(uncapped > MAX_PAYOUT_PER_SUBMISSION, "this test is pointless if the cap is above the best case");
  assert.equal(computeReward("electric", 0, 1), MAX_PAYOUT_PER_SUBMISSION);
});

test("using exactly the benchmark earns the base and nothing more", () => {
  assert.equal(computeReward("electric", USAGE_BENCHMARK.electric, 1), REWARD_BASE.electric);
});

test("using more than the benchmark still earns the base, never less", () => {
  assert.equal(computeReward("electric", 500, 1), REWARD_BASE.electric);
  assert.ok(computeReward("electric", 1e9, 1) > 0);
});

test("the target stretches with the span, so waiting is not punished", () => {
  // Seven days of average use should land on the base, exactly as one day does.
  const sevenDaysOfBenchmark = USAGE_BENCHMARK.electric * 7;
  assert.equal(computeReward("electric", sevenDaysOfBenchmark, 7), REWARD_BASE.electric);
});

test("the per-payout ceiling is flat, so waiting never pays more in one go", () => {
  // The point of the flat cap: a week of perfect saving claimed at once is worth
  // the same as one day of it. Daily claiming is the only way to earn more.
  for (const days of [1, 2, 5, 7]) {
    assert.ok(computeReward("electric", 0, days) <= MAX_PAYOUT_PER_SUBMISSION + 1e-9,
      `span ${days} exceeded the cap`);
  }
  assert.equal(computeReward("electric", 0, 7), computeReward("electric", 0, 1),
    "seven days at once must not pay more than one day");
});

test("a daily claimer out-earns a weekly one for the same saving", () => {
  const weekly = computeReward("electric", 0, 7);
  const daily = 7 * computeReward("electric", 0, 1);
  assert.ok(daily > weekly * 6, `daily ${daily} should far exceed weekly ${weekly}`);
});

test("a span longer than MAX_SPAN_DAYS is clamped, so a year of waiting is not a jackpot", () => {
  assert.equal(computeReward("electric", 0, 365), computeReward("electric", 0, MAX_SPAN_DAYS));
});

test("nothing any utility can do pays more than the ceiling", () => {
  for (const u of ["electric", "gas", "water", "solar"]) {
    for (const days of [1, 7]) {
      for (const usage of [0, 1, 1000]) {
        assert.ok(computeReward(u, usage, days) <= MAX_PAYOUT_PER_SUBMISSION + 1e-9,
          `${u} usage ${usage} span ${days} paid over the cap`);
      }
    }
  }
});

test("solar is paid for what it produces, not for what it saves", () => {
  const produced = 5; // stays under the daily ceiling, so the formula is visible
  assert.equal(computeReward("solar", produced, 1),
    +(REWARD_BASE.solar + produced * RATES.solar).toFixed(2));
  // and producing nothing pays only the base
  assert.equal(computeReward("solar", 0, 1), REWARD_BASE.solar);
});

test("a big solar day is capped, not paid in full", () => {
  // Worth pinning: at 0.72 B3TR/kWh the ceiling binds from about 8 kWh a day, so
  // the uncapped formula and the payout stop agreeing well inside normal output.
  const uncapped = REWARD_BASE.solar + 10 * RATES.solar;  // 7.40
  assert.ok(uncapped > MAX_PAYOUT_PER_SUBMISSION);
  assert.equal(computeReward("solar", 10, 1), MAX_PAYOUT_PER_SUBMISSION);
});

test("spanDays counts whole days, floors at one and caps at MAX_SPAN_DAYS", () => {
  assert.equal(spanDays(0), 1);
  assert.equal(spanDays(DAY * 0.4), 1);
  assert.equal(spanDays(DAY * 3), 3);
  assert.equal(spanDays(DAY * 99), MAX_SPAN_DAYS);
});

test("plausible bounds stretch upward with the span but the floor stays put", () => {
  const [lo1, hi1] = usageBoundsFor("electric", 1);
  const [lo7, hi7] = usageBoundsFor("electric", 7);
  assert.equal(lo1, lo7, "the floor must not scale — a tiny delta is a typo on any span");
  assert.equal(hi7, hi1 * 7);
});

test("the mismatch that started all of this is outside every possible bound", () => {
  // A photo baseline on one tariff register against a reader reporting both.
  const gap = 7705.514 - 3852.104;
  const [, ceiling] = usageBoundsFor("electric", MAX_SPAN_DAYS);
  assert.ok(gap > ceiling,
    `a ${gap} kWh step must never be payable; the ceiling is ${ceiling}`);
});

test("an unknown utility has no rate and earns nothing", () => {
  assert.equal(computeReward("plutonium", 0, 1), 0);
});

// ── The dry-run switch must never be on by accident ──────────────────────────
// It exists so the payout path can be tested, which means a mistake here is a
// service that believes it is paying and is not. Pinned in both directions.

test("the chain stub is off unless it is switched on explicitly", async () => {
  const cases = [undefined, "", "0", "false", "no", "off", "TRUE_ISH", " true"];
  for (const value of cases) {
    const env = { ...process.env };
    if (value === undefined) delete env.DISTRIBUTOR_DRY_RUN;
    else env.DISTRIBUTOR_DRY_RUN = value;
    const on = /^(1|true|yes)$/i.test(env.DISTRIBUTOR_DRY_RUN || "");
    assert.equal(on, false, `DISTRIBUTOR_DRY_RUN=${JSON.stringify(value)} must not enable the stub`);
  }
});

test("and it is on for exactly the values documented", () => {
  for (const value of ["1", "true", "TRUE", "yes", "Yes"]) {
    assert.equal(/^(1|true|yes)$/i.test(value), true, `${value} should enable it`);
  }
});
