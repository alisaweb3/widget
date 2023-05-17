import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

const root = createApp(App);
const pinia = createPinia();
root.use(pinia);
root.mount('#app');
