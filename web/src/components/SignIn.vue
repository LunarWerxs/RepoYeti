<script setup lang="ts">
// Shown only in remote mode with no owner session. The button navigates to the daemon's
// /oauth/login (the PKCE dance). When the request is local, we also offer "Continue local
// for now" — a loopback-only bypass so the owner is never locked out at their own desk.
import { ref } from "vue";
import { Laptop, Loader2 } from "@lucide/vue";
import { useStore } from "../store";

const store = useStore();
const continuing = ref(false);
async function continueLocal(): Promise<void> {
  continuing.value = true;
  try {
    await store.continueLocal(); // reloads into the dashboard on success
  } finally {
    continuing.value = false;
  }
}
</script>

<template>
  <div
    class="safe-top safe-bottom grid min-h-dvh place-items-center px-6"
    style="background-image: var(--brand-glow); background-repeat: no-repeat"
  >
    <div class="w-full max-w-sm text-center">
      <!-- Full horizontal lockup, swapped by theme: black wordmark on light, white on dark. -->
      <h1 class="mb-1.5">
        <img src="/logo-light.svg" alt="RepoYeti" class="mx-auto h-14 w-auto dark:hidden" />
        <img src="/logo-dark.svg" alt="RepoYeti" class="mx-auto hidden h-14 w-auto dark:block" />
      </h1>
      <p class="mx-auto mb-7 max-w-xs text-sm leading-relaxed text-muted-foreground">
        {{ $t("signIn.tagline") }}
      </p>

      <a
        class="inline-flex h-11 items-center gap-2.5 rounded-xl border border-border bg-secondary px-5 text-sm font-semibold text-foreground transition-colors hover:bg-accent active:translate-y-px"
        href="/oauth/login"
      >
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
          <rect x="11" y="9.5" width="26" height="7" rx="3.5" fill="#4285F4" />
          <circle cx="11" cy="13" r="7" fill="#4285F4" />
          <circle cx="37" cy="13" r="7" fill="#EA4335" />
          <circle cx="10" cy="24" r="4.5" fill="#9AA0A6" />
          <rect x="23" y="20.5" width="15" height="7" rx="3.5" fill="#FBBC05" />
          <circle cx="23" cy="24" r="7" fill="#FBBC05" />
          <circle cx="38" cy="24" r="5.5" fill="#F9AB00" />
          <rect x="14" y="31.5" width="26" height="7" rx="3.5" fill="#34A853" />
          <circle cx="14" cy="35" r="7" fill="#34A853" />
          <circle cx="40" cy="35" r="7" fill="#34A853" />
        </svg>
        <span>{{ $t("signIn.buttonLabel") }}</span>
      </a>

      <p class="mt-5 text-xs text-muted-foreground/70">{{ $t("signIn.ownerOnly") }}</p>

      <!-- loopback-only escape hatch: never offered to a request that came over the tunnel -->
      <div v-if="store.canContinueLocal" class="mt-6 border-t border-border/50 pt-5">
        <button
          type="button"
          class="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
          :disabled="continuing"
          @click="continueLocal"
        >
          <Loader2 v-if="continuing" :size="15" class="animate-spin" />
          <Laptop v-else :size="15" />
          {{ $t("signIn.continueLocal") }}
        </button>
        <p class="mt-2 text-[11px] text-muted-foreground/60">{{ $t("signIn.continueLocalHint") }}</p>
      </div>
    </div>
  </div>
</template>
