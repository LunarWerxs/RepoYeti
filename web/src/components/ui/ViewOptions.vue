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
    /** Accepted for call-site symmetry with the surrounding toolbar buttons; the trigger always
     *  labels itself with a native `title` (see the template), so this changes nothing. Kept so
     *  callers don't have to special-case this one control. */
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
    The trigger labels itself with a NATIVE title, not a reka Tooltip.
    This was `<Tooltip><TooltipTrigger as-child><PopoverTrigger>`, and the menu would not open on a
    real click. Two `as-child` trigger components merging onto ONE element is the bug: both Tooltip
    and Popover write `data-state` and both bind pointer handlers, so whichever merges last wins and
    the open/close state the styles read is no longer the one the click drives. It is also exactly
    the construct the rest of this app avoids — FileViewerInner's ⋮ menu and the tree/list button
    beside this one each put ONE trigger on an element and use a plain `title` for the label.
  -->
  <Popover>
    <PopoverTrigger
      class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-accent data-[state=open]:text-foreground"
      :aria-label="label"
      :title="label"
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
        class="flex min-h-7 items-center justify-between gap-3 rounded-sm px-2 py-1"
        :class="row.disabled && 'opacity-45'"
        :title="row.disabled ? row.disabledHint : row.hint"
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
    </PopoverContent>
  </Popover>
</template>
