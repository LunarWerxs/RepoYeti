<script setup lang="ts">
import { NButton, NIcon, NTooltip } from "naive-ui";
import { Wifi, WifiOff, Users, RefreshCw, Plus } from "lucide-vue-next";

defineProps<{ connected: boolean; repoCount: number }>();
defineEmits<{ manage: []; reload: []; add: [] }>();
</script>

<template>
  <header class="hdr safe-top">
    <div class="brand">
      <img src="/icon.svg" alt="" width="28" height="28" />
      <div class="titles">
        <div class="title">GitMob</div>
        <div class="sub">{{ repoCount }} repo{{ repoCount === 1 ? "" : "s" }}</div>
      </div>
    </div>

    <div class="actions">
      <NTooltip>
        <template #trigger>
          <span class="conn" :class="{ on: connected }" aria-label="connection status">
            <NIcon :size="17" :component="connected ? Wifi : WifiOff" />
          </span>
        </template>
        {{ connected ? "Live — receiving updates" : "Reconnecting…" }}
      </NTooltip>

      <NButton quaternary circle aria-label="reload" @click="$emit('reload')">
        <template #icon><NIcon :component="RefreshCw" /></template>
      </NButton>

      <NButton secondary circle aria-label="add repository" @click="$emit('add')">
        <template #icon><NIcon :component="Plus" /></template>
      </NButton>

      <NButton secondary strong aria-label="manage identities" @click="$emit('manage')">
        <template #icon><NIcon :component="Users" /></template>
      </NButton>
    </div>
  </header>
</template>

<style scoped>
.hdr {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  background: rgba(14, 14, 18, 0.82);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid #1f1f27;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.titles {
  line-height: 1.1;
}
.title {
  font-weight: 700;
  font-size: 17px;
  letter-spacing: 0.2px;
}
.sub {
  font-size: 12px;
  color: #7c7c8a;
  margin-top: 1px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.conn {
  display: inline-flex;
  padding: 5px;
  border-radius: 8px;
  color: #6a6a78;
  transition: color 0.2s ease;
}
.conn.on {
  color: #3ddc84;
}
</style>
