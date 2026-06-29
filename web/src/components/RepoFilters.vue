<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, Check, ChevronDown, User, GitBranch, SlidersHorizontal, EyeOff } from "@lucide/vue";
import { useStore, type StatusKey } from "../store";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const { t } = useI18n();
const store = useStore();

// The filters live in an accordion that opens from the icon embedded in the search bar.
const open = ref(false);
function toggleFilters(): void {
  open.value = !open.value;
}

function statusOptions(): { value: StatusKey; label: string }[] {
  return [
    { value: "dirty", label: t("filters.status.dirty") },
    { value: "ahead", label: t("filters.status.ahead") },
    { value: "behind", label: t("filters.status.behind") },
    { value: "clean", label: t("filters.status.clean") },
    { value: "error", label: t("filters.status.error") },
  ];
}

const identityLabel = computed(() => {
  if (store.filterIdentity === undefined) return t("filters.anyIdentity");
  if (store.filterIdentity === null) return t("filters.noIdentity");
  return store.identityById[store.filterIdentity]?.displayName ?? t("filters.anyIdentity");
});
const statusLabel = computed(() => {
  const n = store.filterStatuses.length;
  if (n === 0) return t("filters.anyStatus");
  if (n === 1) return statusOptions().find((s) => s.value === store.filterStatuses[0])?.label ?? t("filters.statusCount", { count: 1 }, 1);
  return t("filters.statusCount", { count: n }, n);
});
// The icon shows a dot when any filter (or "show hidden") is active.
const anyActive = computed(() => store.filtersActive || store.showHidden);
</script>

<template>
  <Collapsible :open="open" class="mb-2.5 flex flex-col gap-2">
    <!-- search bar with an embedded filters toggle on the right -->
    <div class="relative min-w-0 flex-1">
      <Search
        class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input v-model="store.filterQuery" :placeholder="$t('filters.searchPlaceholder')" class="pl-8 pr-10" />
      <button
        type="button"
        :aria-label="$t('filters.filtersTooltip')"
        :aria-expanded="open"
        :class="
          cn(
            'absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
            open && 'bg-accent text-foreground',
            anyActive && 'text-primary',
          )
        "
        @click="toggleFilters"
      >
        <SlidersHorizontal :size="15" />
        <span
          v-if="anyActive"
          class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
        />
      </button>
    </div>

    <CollapsibleContent>
      <div class="flex flex-col gap-2.5 pt-0.5">
        <div class="flex flex-wrap items-center gap-2">
          <!-- identity filter -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                variant="outline"
                size="sm"
                :class="cn(store.filterIdentity !== undefined && 'border-primary/50 text-foreground')"
              >
                <User />
                {{ identityLabel }}
                <ChevronDown class="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-56">
              <DropdownMenuLabel>{{ $t("filters.filterByIdentity") }}</DropdownMenuLabel>
              <DropdownMenuItem @select="store.filterIdentity = undefined">
                {{ $t("filters.anyIdentity") }}
                <Check v-if="store.filterIdentity === undefined" :size="15" class="ml-auto text-primary" />
              </DropdownMenuItem>
              <DropdownMenuItem @select="store.filterIdentity = null">
                {{ $t("filters.noIdentity") }}
                <Check v-if="store.filterIdentity === null" :size="15" class="ml-auto text-primary" />
              </DropdownMenuItem>
              <template v-if="store.identities.length">
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  v-for="i in store.identities"
                  :key="i.id"
                  @select="store.filterIdentity = i.id"
                >
                  <span class="truncate">{{ i.displayName }}</span>
                  <Check v-if="store.filterIdentity === i.id" :size="15" class="ml-auto shrink-0 text-primary" />
                </DropdownMenuItem>
              </template>
            </DropdownMenuContent>
          </DropdownMenu>

          <!-- sync-status filter -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                variant="outline"
                size="sm"
                :class="cn(store.filterStatuses.length > 0 && 'border-primary/50 text-foreground')"
              >
                <GitBranch />
                {{ statusLabel }}
                <ChevronDown class="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-48">
              <DropdownMenuLabel>{{ $t("filters.filterByStatus") }}</DropdownMenuLabel>
              <!-- multi-select: toggle several; OR semantics. .prevent keeps the menu open. -->
              <DropdownMenuCheckboxItem
                v-for="o in statusOptions()"
                :key="o.value"
                :model-value="store.filterStatuses.includes(o.value)"
                @update:model-value="store.toggleStatus(o.value)"
                @select="(e: Event) => e.preventDefault()"
              >
                {{ o.label }}
              </DropdownMenuCheckboxItem>
              <template v-if="store.filterStatuses.length">
                <DropdownMenuSeparator />
                <DropdownMenuItem class="text-muted-foreground" @select="store.filterStatuses = []">
                  <X :size="14" />
                  {{ $t("filters.clearStatuses") }}
                </DropdownMenuItem>
              </template>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            v-if="store.filtersActive"
            variant="ghost"
            size="sm"
            :aria-label="$t('filters.clearFilters')"
            @click="store.clearFilters()"
          >
            <X />
            {{ $t("filters.clearFilters") }}
          </Button>

          <!-- right-aligned cluster: match count + compact "show hidden" toggle -->
          <div class="ml-auto flex items-center gap-2">
            <span v-if="store.filtersActive" class="text-[12px] text-muted-foreground">
              {{ $t("filters.matchCount", { filtered: store.filteredRepos.length, total: store.visibleRepos.length }) }}
            </span>

            <label
              :class="
                cn(
                  'flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-secondary/30 px-2.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground',
                  store.showHidden && 'border-primary/40 text-foreground',
                )
              "
            >
              <EyeOff :size="14" />
              <span class="whitespace-nowrap">{{ $t("filters.showHiddenShort") }}</span>
              <Switch
                :model-value="store.showHidden"
                :aria-label="$t('filters.showHidden')"
                @update:model-value="(v: boolean) => (store.showHidden = v)"
              />
            </label>
          </div>
        </div>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
