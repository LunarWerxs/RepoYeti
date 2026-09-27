// A coarse, shared reactive clock. WHY: a computed that reads Date.now() never re-evaluates on
// its own, so time-based text ("Last fetched 8 days ago") and time-based ordering would freeze
// until some other dependency changed. One interval for the whole app, started on first use;
// minute resolution is plenty for day-scale signals and costs nothing measurable.
//
// The interval lives in a DETACHED effect scope, not in the caller's: the first caller is often
// a repo card, and that card unmounting must not stop the clock every other card still reads.
// useIntervalFn ties the timer to that scope, so stopping the scope is its teardown.
import { effectScope, ref, readonly, type Ref } from "vue";
import { useIntervalFn } from "@vueuse/core";

const now = ref(Date.now());
const clockScope = effectScope(true);
let started = false;

/** The current time in ms, refreshed once a minute. Read `.value` inside a computed to depend on it. */
export function minuteClock(): Readonly<Ref<number>> {
  if (!started) {
    started = true;
    clockScope.run(() =>
      useIntervalFn(() => {
        now.value = Date.now();
      }, 60_000),
    );
  }
  return readonly(now);
}
