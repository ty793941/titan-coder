<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import AcceptanceConsole from "./components/AcceptanceConsole.vue";
import DecisionInbox from "./components/product/DecisionInbox.vue";
import ProductShell from "./components/product/ProductShell.vue";
import { parseProductRoute, productRoute, type ProductRoute } from "./product/routes";
import { useProductData } from "./product/useProductData";

const route = ref<ProductRoute>(parseProductRoute(window.location.hash));
const product = useProductData();

function updateRoute() {
  route.value = parseProductRoute(window.location.hash);
}

function navigate(next: ProductRoute) {
  window.location.hash = productRoute(next);
}

window.addEventListener("hashchange", updateRoute);
onBeforeUnmount(() => window.removeEventListener("hashchange", updateRoute));
</script>

<template>
  <AcceptanceConsole v-if="route.name === 'acceptance'" />
  <ProductShell
    v-else
    :route="route"
    :decisions="product.decisions.value"
    :projects="product.projects.value"
    :loading="product.loading.value"
    :error="product.error.value"
    :last-sync="product.lastSync.value"
    @navigate="navigate"
    @refresh="product.refresh"
  >
    <DecisionInbox
      v-if="route.name === 'inbox'"
      :decisions="product.decisions.value"
      :projects="product.projects.value"
      :loading="product.loading.value"
      @decision="(id) => navigate({ name: 'decision', decisionId: id })"
      @project="(id) => navigate({ name: 'project', projectId: id })"
    />
    <main v-else class="product-placeholder" aria-live="polite">
      <span class="product-kicker">TITAN / PRODUCT</span>
      <h1>这个空间正在准备</h1>
      <p>从项目负责人视角整理目标、判断和交付。</p>
      <button class="product-secondary-action" @click="navigate({ name: 'inbox' })">返回我的决策</button>
    </main>
  </ProductShell>
</template>
