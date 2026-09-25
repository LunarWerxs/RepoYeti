// A coarse, shared reactive clock. WHY: a computed that reads Date.now() never re-evaluates on
// its own, so time-based text ("Last fetched 8 days ago") and time-based ordering would freeze
// until some other dependency changed. One interval for the whole app, started on first use;
// minute resolution is plenty for day-scale signals and costs nothing measurable.
import { ref, readonly, type Ref } from "vue";

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

/** The current time in ms, refreshed once a minute. Read `.value` inside a computed to depend on it. */
export function minuteClock(): Readonly<Ref<number>> {
  if (!timer) timer = setInterval(() => {
    now.value = Date.now();
  }, 60_000);
  return readonly(now);
}
