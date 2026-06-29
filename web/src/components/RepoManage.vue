<script setup lang="ts">
// Small per-repo "Remote & tags" dialog. Kept self-contained (its own file) so it stays
// out of the large RepoCard template. Remote edits are local `.git/config` changes (no
// network); tags are read-only.
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Trash2, Tag } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useStore } from "../store";
import { fromNow } from "@/lib/util";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const props = defineProps<{ repoId: string; remote: string | null }>();
const open = defineModel<boolean>("open", { required: true });
const store = useStore();
const { t } = useI18n();

const url = ref("");
const busy = computed(() => store.gitOpBusy[props.repoId] === "remote");
const tagBusy = computed(() => store.gitOpBusy[props.repoId] === "tag");
const confirmRemove = ref(false);
const tags = computed(() => store.tagsByRepo[props.repoId]?.tags ?? []);

// new-tag form
const tagName = ref("");
const tagMessage = ref("");
const tagPush = ref(false);

watch(open, (isOpen) => {
  if (isOpen) {
    url.value = props.remote ?? "";
    confirmRemove.value = false;
    tagName.value = "";
    tagMessage.value = "";
    tagPush.value = false;
    void store.loadTags(props.repoId);
  }
});

async function createTag(): Promise<void> {
  const name = tagName.value.trim();
  if (!name || tagBusy.value) return;
  const r = await store.createTag(props.repoId, {
    name,
    message: tagMessage.value.trim() || undefined,
    push: tagPush.value,
  });
  if (r.ok) {
    toast.success(r.message || t("repo.manage.tagCreated"));
    tagName.value = "";
    tagMessage.value = "";
  } else {
    toast.error(r.message || t("repo.manage.tagFailed"));
  }
}

async function save(): Promise<void> {
  const u = url.value.trim();
  if (!u || busy.value) return;
  const r = await store.setRemote(props.repoId, u);
  if (r.ok) {
    toast.success(t("repo.manage.saved"));
    open.value = false;
  } else {
    toast.error(r.message || t("repo.manage.saveFailed"));
  }
}
async function remove(): Promise<void> {
  if (busy.value) return;
  if (!confirmRemove.value) {
    confirmRemove.value = true; // inline two-step confirm
    return;
  }
  confirmRemove.value = false;
  const r = await store.removeRemote(props.repoId);
  if (r.ok) {
    toast.success(t("repo.manage.removed"));
    url.value = "";
  } else {
    toast.error(r.message || t("repo.manage.removeFailed"));
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t("repo.manage.title") }}</DialogTitle>
        <DialogDescription>{{ $t("repo.manage.remoteHint") }}</DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-1.5">
        <label class="text-[12px] text-muted-foreground">{{ $t("repo.manage.remoteLabel") }}</label>
        <Input v-model="url" class="mono" :placeholder="$t('repo.manage.remotePlaceholder')" @keyup.enter="save" />
        <div class="flex items-center gap-2 pt-1">
          <Button size="sm" :disabled="!url.trim() || busy" @click="save">
            <Loader2 v-if="busy" class="animate-spin" />
            {{ $t("repo.manage.save") }}
          </Button>
          <Button
            v-if="remote"
            :variant="confirmRemove ? 'destructive' : 'outline'"
            size="sm"
            :disabled="busy"
            @click="remove"
            @blur="confirmRemove = false"
          >
            <Trash2 />
            {{ confirmRemove ? $t("repo.manage.removeConfirm") : $t("repo.manage.remove") }}
          </Button>
        </div>
      </div>

      <!-- tags (read-only) -->
      <div class="flex flex-col gap-1.5 border-t border-border/40 pt-3">
        <div class="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
          <Tag :size="14" class="text-muted-foreground" /> {{ $t("repo.manage.tagsTitle") }}
        </div>
        <p v-if="!tags.length" class="text-[12px] text-muted-foreground">{{ $t("repo.manage.tagsEmpty") }}</p>
        <div v-else class="scroll-slim flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          <div
            v-for="tg in tags"
            :key="tg.name"
            class="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-accent/40"
          >
            <span class="mono shrink-0 text-[12px] text-foreground">{{ tg.name }}</span>
            <span class="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground" :title="tg.subject">{{ tg.subject }}</span>
            <span class="shrink-0 text-[11px] text-muted-foreground/70">{{ fromNow(tg.date) }}</span>
          </div>
        </div>

        <!-- create a tag (annotated when a message is given; optional push) -->
        <form class="flex flex-col gap-2 pt-1" @submit.prevent="createTag">
          <div class="flex items-center gap-2">
            <Input v-model="tagName" class="mono" :placeholder="$t('repo.manage.tagNamePlaceholder')" />
            <Button type="submit" size="sm" class="shrink-0" :disabled="!tagName.trim() || tagBusy">
              <Loader2 v-if="tagBusy" class="animate-spin" />
              {{ $t("repo.manage.tagCreate") }}
            </Button>
          </div>
          <Input v-model="tagMessage" class="mono" :placeholder="$t('repo.manage.tagMessagePlaceholder')" />
          <label v-if="remote" class="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
            <input v-model="tagPush" type="checkbox" class="size-3.5 accent-primary" />
            {{ $t("repo.manage.tagPush") }}
          </label>
        </form>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ $t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
