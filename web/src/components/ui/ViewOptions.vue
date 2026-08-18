<script setup lang="ts">
// A small "how should this panel look?" popover, dropped straight into the panel's own toolbar.
//
// WHY IT EXISTS. Every one of these used to live only in Settings → Appearance, and that group had
// grown to a dozen rows. The problem is not the row count, it is that a display choice about the
// History panel is invisible from the History panel: nobody digs through Settings looking for a
// tree/list switch they never knew existed. Putting the control where the thing it changes is
// visible makes it discoverable by accident, which is the only way most options ever get found.
// The panel-specific rows were MOVED here, not copied — two homes for one switch is how they drift.
//
// Deliberately generic: the caller passes rows, this owns the trigger, the popover and the row
// styling, so the History and Changes toolbars can't drift apart. Two row kinds only, because
// that is all a view option ever needs:
//   toggle  — on/off (a Switch)
//   choice  — two or three named alternatives (the same inline segmented control the History
//             branch-scope tabs already use, so nothing new is introduced here)
import { SlidersHorizontal } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";

export interface ViewOptionChoice {
  value: string;
  label: string;
}

export interface ViewOptionRow {
  /** Stable key — also the value passed back to `change`. */
  key: string;
  label: string;
  kind: "toggle" | "choice";
  /** `toggle`: current state. */
  on?: boolean;
  /** `choice`: the alternatives and which one is active. */
  choices?: ViewOptionChoice[];
  active?: string;
  /** The one-line explanation this option used to carry as a Settings InfoHint. Kept as the
   *  row's hover text so moving the control out of Settings loses none of the words. */
  hint?: string;
  /** Greyed out with a reason, rather than hidden — a row that vanishes makes the menu's height
   *  jump and leaves the owner wondering where the option went. */
  disabled?: boolean;
  disabledHint?: string;
}

const props = withDefaults(
  defineProps<{
    rows: ViewOptionRow[];
    /** Accessible name + tooltip for the trigger, e.g. "History view options". */
    label: string;
    /** Accepted for call-site symmetry with the surrounding toolbar buttons. It changes nothing
     *  here: the trigger's tooltip lives under the app's TooltipProvider, which already resolves
     *  the shared "show tooltips" switch for every tooltip beneath it (see ui/tooltip/
     *  TooltipProvider.vue). Kept so callers don't have to special-case this one control. */
    tooltips?: boolean;
  }>(),
  { tooltips: true },
);

const emit = defineEmits<{
  /** A toggle flipped (`value` is the new boolean) or a choice was picked (`value` is its key). */
  change: [payload: { key: string; value: boolean | string }];
}>();
</script>

<template>
  <!--
    The label is a real Tooltip, so a finger can reach it (press and hold — see ui/tooltip/touch.ts).
    It used to be a native `title`, which no touch device has ever shown: on a phone this control was
    simply an unexplained slider icon.

    The SPAN keeps the two `as-child` triggers off ONE element. Merged together, both Tooltip and
    Popover write `data-state` and bind pointer handlers, so whichever merged last won and the state
    the styles read was no longer the one the click drove. The inert wrapper makes that impossible:
    the Tooltip merges onto the span, the Popover keeps its own button, and neither sees the other's
    attributes. It must be a real box (`inline-flex`), not `display: contents`, because reka
    positions the tooltip off the trigger's bounding rect and a box-less element measures 0×0 at the
    origin.

    The span alone was NOT enough, and believing it was cost a release: the popover kept opening
    off-screen while every attribute looked right. That half is a nesting problem, not a merging one
    — see the note on the trigger below, and copy that ORDER (Tooltip outside, Popover inside the
    span) wherever a tooltip labels a menu.

    Tap and hold stay separate on their own: the popover opens on CLICK, and a completed hold
    swallows the click that ends it (touch.ts swallowNextClick, capture phase on document, and the
    inner button is inside the span it scopes to). So a quick tap still opens the menu in one tap,
    and a hold shows the label without opening anything.
  -->
  <Tooltip>
    <TooltipTrigger as-child>
      <!--
        WHY THE POPOVER IS NESTED INSIDE THE TOOLTIP TRIGGER, and not the other way round.

        reka's MenuRoot, PopoverRoot and TooltipRoot each render a PopperRoot, and a PopperRoot
        `provide`s the anchor its popper positions against. A trigger registers itself through
        PopperAnchor, which `inject`s the NEAREST PopperRoot. So with the Popover on the OUTSIDE,
        its own trigger sat inside the Tooltip and handed its anchor to the TOOLTIP's PopperRoot,
        while PopoverContent, outside the Tooltip, injected an anchor-less one. Floating UI then
        never had a reference element, `isPositioned` stayed false, and PopperContent kept its
        pre-position style `translate(0, -200%)`: the menu really did open — aria-expanded went
        true and the items were in the DOM — two menu-heights above the top of the window, where
        nobody could see it. It read as a dead button.

        Nesting the Popover inside the span makes its own PopperRoot the nearest one for BOTH its
        trigger and its content, and leaves the span as the tooltip's anchor. Keep the span: two
        `as-child` triggers merging onto one element is a separate real bug, and reka measures the
        tooltip off the trigger's bounding rect, so it must be a real box (`inline-flex`), never
        `display: contents`.
      -->
      <span class="inline-flex">
        <Popover>
          <PopoverTrigger
            class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-accent data-[state=open]:text-foreground"
            :aria-label="label"
          >
            <SlidersHorizontal :size="14" />
          </PopoverTrigger>
          <PopoverContent class="w-64 p-1" align="end">
            <div class="px-2 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {{ label }}
            </div>
            <div
              v-for="row in rows"
              :key="row.key"
              class="rounded-sm px-2 py-1"
              :title="row.disabled ? row.disabledHint : row.hint"
            >
            <div
              class="flex min-h-7 items-center justify-between gap-3"
              :class="row.disabled && 'opacity-45'"
            >
              <span class="min-w-0 text-[12.5px] text-foreground">{{ row.label }}</span>
              <Switch
                v-if="row.kind === 'toggle'"
                :model-value="row.on"
                :disabled="row.disabled"
                :aria-label="row.label"
                @update:model-value="(v: boolean) => emit('change', { key: row.key, value: v })"
              />
              <div
                v-else
                class="inline-flex shrink-0 items-center rounded-md border border-border/60 p-0.5"
                role="tablist"
                :aria-label="row.label"
              >
                <button
                  v-for="choice in row.choices ?? []"
                  :key="choice.value"
                  type="button"
                  role="tab"
                  :aria-selected="row.active === choice.value"
                  :disabled="row.disabled"
                  class="rounded px-2 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
                  :class="
                    row.active === choice.value
                      ? 'bg-primary/15 font-medium text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  "
                  @click="emit('change', { key: row.key, value: choice.value })"
                >
                  {{ choice.label }}
                </button>
              </div>
            </div>
              <!-- A disabled row's REASON, rendered inline rather than left in the `title` above.
                   It used to be hover-only, so the whole menu could be inert (every row here needs
                   "Diff statistics" on, and that ships OFF) while looking like an ordinary menu that
                   simply ignored you — the switch is greyed 45%, which is easy to miss, and a native
                   tooltip needs a second of hover on a control nobody suspects. Saying it in the menu
                   is the difference between "this is broken" and "here is the switch to turn on".
                   NOT shown at full opacity's sibling: the dim belongs to the control, the reason must
                   stay readable. -->
              <p v-if="row.disabled && row.disabledHint" class="pt-0.5 text-[11px] text-muted-foreground">
                {{ row.disabledHint }}
              </p>
            </div>
          </PopoverContent>
        </Popover>
      </span>
    </TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>
