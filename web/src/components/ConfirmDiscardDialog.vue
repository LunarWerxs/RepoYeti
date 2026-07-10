<script setup lang="ts">
// In-app "discard unsaved edits?" prompt for the file viewer — an on-brand modal that replaces
// window.confirm (which looks foreign and behaves poorly on mobile). Driven entirely by
// file-viewer.ts: it owns the open state and the resolver the guards await.
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { discardDialogOpen, resolveDiscard } from "@/lib/file-viewer";
</script>

<template>
  <Dialog v-model:open="discardDialogOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t("fileViewer.discardTitle") }}</DialogTitle>
        <DialogDescription>{{ $t("fileViewer.discardBody") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="secondary" @click="resolveDiscard(false)">
          {{ $t("fileViewer.keepEditing") }}
        </Button>
        <Button variant="destructive" @click="resolveDiscard(true)">
          {{ $t("fileViewer.discard") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
