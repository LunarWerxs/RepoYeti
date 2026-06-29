<script setup lang="ts">
// The single file-viewer instance (mounted once in AppShell). It only chooses the shell:
//   · desktop (≥768px) → a right-side push panel; the page reserves pageShiftPx of padding
//     (see AppShell) so it slides left and stays centered. Non-modal, no backdrop.
//   · mobile            → an overlay bottom sheet (reka Dialog), like Settings.
// The header + body + editor live in FileViewerInner, shared by both.
import { useEventListener } from "@vueuse/core";
import {
  fileViewer,
  isDesktopViewer,
  viewerWidth,
  closeFile,
  setViewerWidth,
  commitViewerWidth,
} from "@/lib/file-viewer";
import { shortcutsActive } from "@/lib/hotkeys";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import FileViewerInner from "./FileViewerInner.vue";
import ConfirmDiscardDialog from "./ConfirmDiscardDialog.vue";

// ── desktop: drag the left edge to resize (page padding tracks viewerWidth live) ──
let startX = 0;
let startW = 0;
function onMove(e: PointerEvent): void {
  setViewerWidth(startW + (startX - e.clientX));
}
function onUp(): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  commitViewerWidth(viewerWidth.value);
}
function onGripDown(e: PointerEvent): void {
  startX = e.clientX;
  startW = viewerWidth.value;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  e.preventDefault();
}

// Escape closes the desktop panel (the mobile sheet handles its own Escape).
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && shortcutsActive() && fileViewer.open && isDesktopViewer.value) closeFile();
});

function onMobileOpenChange(open: boolean): void {
  if (!open) closeFile();
}
</script>

<template>
  <!-- desktop push-drawer -->
  <Teleport to="body">
    <Transition
      enter-active-class="transition-transform duration-300 ease-out"
      enter-from-class="translate-x-full"
      leave-active-class="transition-transform duration-300 ease-in"
      leave-to-class="translate-x-full"
    >
      <aside
        v-if="isDesktopViewer && fileViewer.open"
        class="fixed inset-y-0 right-0 z-40 flex border-l border-border bg-card shadow-2xl shadow-black/40"
        :style="{ width: `${viewerWidth}px` }"
      >
        <!-- resize grip (left edge) -->
        <button
          type="button"
          class="group/grip absolute inset-y-0 left-0 z-10 flex w-1.5 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center outline-none"
          :aria-label="$t('fileViewer.resize')"
          :title="$t('fileViewer.resize')"
          @pointerdown="onGripDown"
        >
          <span
            class="h-10 w-1 rounded-full bg-border transition-colors group-hover/grip:bg-primary/60 group-focus-visible/grip:bg-primary/60"
          />
        </button>
        <FileViewerInner :target="fileViewer.target" :show-close="true" class="h-full min-w-0 flex-1" @close="closeFile" />
      </aside>
    </Transition>
  </Teleport>

  <!-- mobile bottom sheet -->
  <Sheet v-if="!isDesktopViewer" :open="fileViewer.open" @update:open="onMobileOpenChange">
    <SheetContent side="bottom" class="h-[85vh] gap-0 p-0">
      <FileViewerInner :target="fileViewer.target" :show-close="false" class="h-full" @close="closeFile" />
    </SheetContent>
  </Sheet>

  <ConfirmDiscardDialog />
</template>
