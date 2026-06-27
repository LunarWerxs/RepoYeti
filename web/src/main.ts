import { createApp } from "vue";
import { createPinia } from "pinia";
import { autoAnimatePlugin } from "@formkit/auto-animate/vue";
import App from "./App.vue";
import "./style.css";

createApp(App).use(createPinia()).use(autoAnimatePlugin).mount("#app");
