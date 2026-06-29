// App-wide internationalisation (vue-i18n, Composition API) — English only.
//
// GitMob ships a single locale (English). The i18n layer is kept (rather than inlining raw
// strings) so all user-facing copy stays centralised in one `locales/en.json` and the build's
// `i18n:check` can flag any hardcoded/missing string. To reintroduce other languages later:
// add `locales/<code>.json` (key-parity with en.json) and a small locale switcher back.
import { createI18n } from "vue-i18n";
import en from "./locales/en.json";

export const i18n = createI18n({
  legacy: false,
  globalInjection: true, // `$t` available in every template without useI18n()
  locale: "en",
  fallbackLocale: "en",
  messages: { en },
});

/** Convenience for non-component code (e.g. plain helpers): i18n.global.t under a short name. */
export const t = i18n.global.t;
