<script setup lang="ts">
// Shown only when the daemon enforces auth and there's no owner session.
// The button is the official "Sign in with Connections" brand asset; it navigates
// to the daemon's /oauth/login, which runs the PKCE dance against AEGIS.
</script>

<template>
  <div class="gate safe-top safe-bottom">
    <div class="card">
      <img src="/icon.svg" alt="" width="56" height="56" class="logo" />
      <h1>GitMob</h1>
      <p class="lead">Your repositories, from anywhere — signed in with Connections.</p>

      <a class="cnx-signin" href="/oauth/login">
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
        <span>Sign in with Connections</span>
      </a>

      <p class="fine">Only the owner of this daemon can sign in.</p>
    </div>
  </div>
</template>

<style scoped>
.gate {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}
.card {
  width: 100%;
  max-width: 340px;
  text-align: center;
}
.logo {
  border-radius: 14px;
}
h1 {
  margin: 14px 0 6px;
  font-size: 22px;
  font-weight: 700;
}
.lead {
  margin: 0 0 24px;
  color: #9a9aa6;
  font-size: 14px;
  line-height: 1.5;
}
.cnx-signin {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 18px;
  border-radius: 9px;
  background: #131314;
  color: #e3e3e3;
  border: 1px solid #5f6368;
  font: 600 14px/1 Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
  text-decoration: none;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}
.cnx-signin:hover {
  background: #1f1f20;
  border-color: #7a7f85;
}
.cnx-signin:active {
  transform: translateY(1px);
}
.fine {
  margin-top: 18px;
  color: #65656f;
  font-size: 12px;
}
</style>
