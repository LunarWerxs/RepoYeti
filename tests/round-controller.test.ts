/**
 * The single-in-flight, single-timer rules of src/round-controller.ts (audit item 10), against a
 * controlled clock. The hand-rolled plumbing it replaced in auto-commit.ts and remote-sync.ts let a
 * timer that fired during a manual round start a second concurrent pass; these tests pin every
 * ordering that used to be wrong.
 */
import { expect, test } from "bun:test";
import { createRoundController } from "../src/round-controller.ts";

/** A fake clock: timers are recorded, never run on their own; the test fires them by hand. */
function fakeClock() {
  const pending = new Map<number, () => void>();
  let next = 1;
  let armCount = 0;
  return {
    setTimer: (fn: () => void, _ms: number) => {
      armCount++;
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    /** Fire the (single) pending timer. Throws if there is not exactly one, which is itself an assertion. */
    fire() {
      if (pending.size !== 1) throw new Error(`expected exactly one armed timer, found ${pending.size}`);
      const [id, fn] = [...pending.entries()][0]!;
      pending.delete(id);
      fn();
    },
    get pendingCount() {
      return pending.size;
    },
    get armCount() {
      return armCount;
    },
  };
}

/** A round whose completion the test controls. */
function deferredRound() {
  let started = 0;
  let release: (() => void) | null = null;
  const round = () =>
    new Promise<string>((resolve) => {
      started++;
      release = () => resolve(`round-${started}`);
    });
  return {
    round,
    get started() {
      return started;
    },
    release: () => {
      release?.();
      release = null;
    },
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

test("a timer firing DURING a manual round starts no second round, and the round's end re-arms exactly once", async () => {
  const clock = fakeClock();
  const work = deferredRound();
  const ctl = createRoundController({ round: work.round, delayMs: () => 60_000, ...clock });
  ctl.setEnabled(true);
  ctl.start();
  expect(clock.pendingCount).toBe(1);

  const manual = ctl.runNow(); // a round is now in flight, the timer is still armed
  expect(work.started).toBe(1);
  clock.fire(); // the timer goes off mid-round: the old code started tick() again here
  expect(work.started).toBe(1);
  expect(clock.pendingCount).toBe(0); // the fired timer spent itself; nothing re-armed yet

  work.release();
  expect(await manual).toBe("round-1");
  await settle();
  expect(clock.pendingCount).toBe(1); // exactly one re-arm, from the round's tail
  expect(clock.armCount).toBe(2);
});

test("a manual round while the timer is armed leaves that timer alone (cadence preserved, never two timers)", async () => {
  const clock = fakeClock();
  const work = deferredRound();
  const ctl = createRoundController({ round: work.round, delayMs: () => 60_000, ...clock });
  ctl.setEnabled(true);
  ctl.start();
  const manual = ctl.runNow();
  work.release();
  await manual;
  await settle();
  expect(clock.pendingCount).toBe(1);
  expect(clock.armCount).toBe(1); // the original timer, untouched
});

test("runNow during an in-flight round answers null instead of running a concurrent pass", async () => {
  const clock = fakeClock();
  const work = deferredRound();
  const ctl = createRoundController({ round: work.round, delayMs: () => 60_000, ...clock });
  const first = ctl.runNow();
  expect(await ctl.runNow()).toBeNull();
  expect(work.started).toBe(1);
  work.release();
  await first;
  // Idle again: the next manual call runs.
  const second = ctl.runNow();
  expect(work.started).toBe(2);
  work.release();
  await second;
});

test("disable mid-round disarms and the round's end arms nothing; re-enable mid-round arms exactly once at the end", async () => {
  const clock = fakeClock();
  const work = deferredRound();
  const ctl = createRoundController({ round: work.round, delayMs: () => 60_000, ...clock });
  ctl.setEnabled(true);
  ctl.start();
  clock.fire(); // timer-fired round now in flight
  expect(work.started).toBe(1);
  expect(clock.pendingCount).toBe(0);

  ctl.setEnabled(false);
  work.release();
  await settle();
  expect(clock.pendingCount).toBe(0); // disabled: nothing re-armed
  expect(ctl.inFlight).toBe(false);

  // Re-enable while a NEW manual round is running: no timer until it ends, then exactly one.
  const manual = ctl.runNow();
  ctl.setEnabled(true);
  expect(clock.pendingCount).toBe(0);
  work.release();
  await manual;
  await settle();
  expect(clock.pendingCount).toBe(1);
});

test("a timer-fired round that throws is swallowed and still re-arms exactly once; a manual failure propagates", async () => {
  const clock = fakeClock();
  let calls = 0;
  const ctl = createRoundController({
    round: async () => {
      calls++;
      throw new Error("round failed");
    },
    delayMs: () => 30_000,
    ...clock,
  });
  ctl.setEnabled(true);
  ctl.start();
  clock.fire();
  await settle();
  expect(calls).toBe(1);
  expect(clock.pendingCount).toBe(1);
  expect(clock.armCount).toBe(2);

  await expect(ctl.runNow()).rejects.toThrow("round failed");
  await settle();
  expect(clock.pendingCount).toBe(1); // the armed timer was left alone
});

test("stop() disarms permanently until start(); retime() re-arms an idle loop with the fresh delay", async () => {
  const clock = fakeClock();
  const delays: number[] = [];
  let delay = 60_000;
  const ctl = createRoundController({
    round: async () => "ok",
    delayMs: () => delay,
    setTimer: (fn, ms) => {
      delays.push(ms);
      return clock.setTimer(fn, ms);
    },
    clearTimer: clock.clearTimer,
  });
  ctl.setEnabled(true);
  ctl.start();
  expect(delays).toEqual([60_000]);
  delay = 5_000;
  ctl.retime();
  expect(clock.pendingCount).toBe(1);
  expect(delays).toEqual([60_000, 5_000]);
  ctl.stop();
  expect(clock.pendingCount).toBe(0);
  ctl.setEnabled(true); // not started: still nothing
  expect(clock.pendingCount).toBe(0);
  ctl.start();
  expect(clock.pendingCount).toBe(1);
});
