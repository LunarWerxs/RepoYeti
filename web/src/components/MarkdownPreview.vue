<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "@/lib/markdown-preview";

const props = defineProps<{ source: string }>();
const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <div class="h-full overflow-auto px-5 py-4 sm:px-7 sm:py-6">
    <!-- renderMarkdown sanitizes raw HTML and hardens links before it reaches this sink. -->
    <article class="markdown-preview mx-auto max-w-4xl text-[13.5px]" v-html="html" />
  </div>
</template>

<style scoped>
.markdown-preview {
  color: var(--foreground);
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.markdown-preview :deep(h1),
.markdown-preview :deep(h2),
.markdown-preview :deep(h3),
.markdown-preview :deep(h4) {
  margin: 1.4em 0 0.55em;
  color: var(--foreground);
  font-weight: 650;
  line-height: 1.25;
}
.markdown-preview :deep(h1) {
  margin-top: 0;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.35em;
  font-size: 1.8em;
}
.markdown-preview :deep(h2) {
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3em;
  font-size: 1.45em;
}
.markdown-preview :deep(h3) {
  font-size: 1.2em;
}
.markdown-preview :deep(p),
.markdown-preview :deep(ul),
.markdown-preview :deep(ol),
.markdown-preview :deep(blockquote),
.markdown-preview :deep(pre),
.markdown-preview :deep(table) {
  margin: 0.85em 0;
}
.markdown-preview :deep(ul),
.markdown-preview :deep(ol) {
  padding-left: 1.7em;
}
.markdown-preview :deep(ul) {
  list-style: disc;
}
.markdown-preview :deep(ol) {
  list-style: decimal;
}
.markdown-preview :deep(a) {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.markdown-preview :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 1em;
  color: var(--muted-foreground);
}
.markdown-preview :deep(pre) {
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--secondary);
  padding: 0.85em 1em;
}
.markdown-preview :deep(code) {
  border-radius: 0.25rem;
  background: var(--secondary);
  padding: 0.12em 0.3em;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 0.9em;
}
.markdown-preview :deep(pre code) {
  background: transparent;
  padding: 0;
}
.markdown-preview :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.markdown-preview :deep(th),
.markdown-preview :deep(td) {
  border: 1px solid var(--border);
  padding: 0.45em 0.7em;
  text-align: left;
}
.markdown-preview :deep(th) {
  background: var(--secondary);
  font-weight: 600;
}
.markdown-preview :deep(hr) {
  margin: 1.5em 0;
  border: 0;
  border-top: 1px solid var(--border);
}
</style>
