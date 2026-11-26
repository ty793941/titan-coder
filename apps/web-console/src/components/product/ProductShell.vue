<script setup lang="ts">
import { Menu, RefreshCw, X } from "lucide-vue-next";
import { ref } from "vue";
import type { Project } from "../../types";
import type { ProductDecision } from "../../product/types";
import type { ProductRoute } from "../../product/routes";

defineProps<{
  route: ProductRoute;
  decisions: ProductDecision[];
  projects: Project[];
  loading: boolean;
  error: string;
  lastSync: string;
}>();
const emit = defineEmits<{
  navigate: [route: ProductRoute];
  refresh: [];
}>();
const mobileOpen = ref(false);
const links: Array<{ label: string; route: ProductRoute }> = [
  { label: "我的决策", route: { name: "inbox" } },
  { label: "项目", route: { name: "inbox" } },
  { label: "交付物", route: { name: "deliveries" } },
  { label: "活动", route: { name: "activity" } },
];
function go(route: ProductRoute) {
  mobileOpen.value = false;
  emit("navigate", route);
}
</script>

<template>
  <div class="product-shell">
    <div v-if="mobileOpen" class="product-scrim" @click="mobileOpen = false" />
    <aside class="product-sidebar" :class="{ open: mobileOpen }" aria-label="产品导航">
      <div class="product-brand"><span class="product-brand-symbol">t.</span><span>TITAN</span></div>
      <div class="product-workspace"><span>当前工作区</span><strong>产品交付</strong><small>项目负责人空间</small></div>
      <nav class="product-nav" aria-label="主导航">
        <button v-for="link in links" :key="link.label" class="product-nav-item" :class="{ active: link.label === '我的决策' && route.name === 'inbox' }" @click="go(link.route)">{{ link.label }}<span v-if="link.label === '我的决策' && decisions.length" class="product-nav-count">{{ decisions.length }}</span></button>
      </nav>
      <div class="product-sidebar-bottom"><span>工作区设置</span><small>环境与权限</small></div>
      <button class="product-close-mobile" aria-label="关闭导航" @click="mobileOpen = false"><X :size="18" /></button>
    </aside>
    <div class="product-main">
      <header class="product-topbar"><button class="product-menu" aria-label="打开产品导航" :aria-expanded="mobileOpen" @click="mobileOpen = true"><Menu :size="20" /></button><div class="product-breadcrumb">Titan <span>/</span> 产品交付</div><div class="product-topbar-actions"><span v-if="lastSync" class="product-last-sync">已同步</span><button class="product-icon-button" aria-label="刷新项目状态" :disabled="loading" @click="emit('refresh')"><RefreshCw :size="16" :class="{ spinning: loading }" /></button><span class="product-user">P</span></div></header>
      <div v-if="error" class="product-error" role="alert">暂时无法更新项目状态。{{ error }} <button @click="emit('refresh')">重试</button></div>
      <slot />
    </div>
  </div>
</template>
