<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import AcceptanceConsole from "./components/AcceptanceConsole.vue";
import { parseProductRoute, type ProductRoute } from "./product/routes";

const route = ref<ProductRoute>(parseProductRoute(window.location.hash));

function updateRoute() {
  route.value = parseProductRoute(window.location.hash);
}

window.addEventListener("hashchange", updateRoute);
onBeforeUnmount(() => window.removeEventListener("hashchange", updateRoute));
</script>

<template>
  <AcceptanceConsole v-if="route.name === 'acceptance'" />
  <main v-else class="product-bootstrap" aria-labelledby="product-bootstrap-title">
    <p class="eyebrow">TITAN / PRODUCT</p>
    <h1 id="product-bootstrap-title">正式产品工作台正在准备</h1>
    <p>项目负责人入口即将替换当前验收控制台。</p>
    <a href="#/acceptance">进入开发验收控制台</a>
  </main>
</template>
