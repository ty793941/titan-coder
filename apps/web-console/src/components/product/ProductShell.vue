<script setup lang="ts">
import {
  CheckCheck,
  Folder,
  Files,
  History,
  Menu,
  RefreshCw,
  Settings2,
  X,
} from "lucide-vue-next";
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
  partialErrors: string[];
  lastSync: string;
}>();
const emit = defineEmits<{
  navigate: [route: ProductRoute];
  refresh: [];
}>();
const mobileOpen = ref(false);
const links = [
  {
    label: "我的决策",
    route: { name: "inbox" } as ProductRoute,
    icon: CheckCheck,
  },
  { label: "项目", route: { name: "projects" } as ProductRoute, icon: Folder },
  {
    label: "交付物",
    route: { name: "deliveries" } as ProductRoute,
    icon: Files,
  },
  { label: "活动", route: { name: "activity" } as ProductRoute, icon: History },
];
function go(route: ProductRoute) {
  mobileOpen.value = false;
  emit("navigate", route);
}
</script>

<template>
  <div class="product-shell" @keydown.esc="mobileOpen = false">
    <a
      href="#product-content"
      class="skip-link"
      @click.prevent="
        () => {
          $el.querySelector('#product-content')?.focus();
        }
      "
      >跳至主要内容</a
    >
    <div v-if="mobileOpen" class="product-scrim" @click="mobileOpen = false" />
    <aside
      class="product-sidebar"
      :class="{ open: mobileOpen }"
      aria-label="产品导航"
    >
      <div class="product-brand">
        <span class="product-brand-symbol">t.</span><span>TITAN</span>
      </div>
      <div class="product-workspace">
        <span>当前工作区</span><strong>产品交付</strong
        ><small>项目负责人空间</small>
      </div>
      <nav class="product-nav" aria-label="主导航">
        <button
          v-for="link in links"
          :key="link.label"
          class="product-nav-item"
          :aria-current="route.name === link.route.name ? 'page' : undefined"
          :class="{
            active:
              route.name === link.route.name ||
              (link.label === '项目' &&
                ['project', 'task', 'execution'].includes(route.name)),
          }"
          @click="go(link.route)"
        >
          <component :is="link.icon" :size="18" :stroke-width="1.6" /><span>{{
            link.label
          }}</span
          ><span
            v-if="link.label === '我的决策' && decisions.length"
            class="product-nav-count"
            >{{ decisions.length }}</span
          >
        </button>
      </nav>
      <div class="product-sidebar-bottom">
        <button class="product-nav-item" @click="go({ name: 'settings' })">
          <Settings2 :size="18" />环境设置</button
        ><small>你的项目，你的判断。</small>
      </div>
      <button
        class="product-close-mobile"
        aria-label="关闭导航"
        @click="mobileOpen = false"
      >
        <X :size="18" />
      </button>
    </aside>
    <div class="product-main">
      <header class="product-topbar">
        <button
          class="product-menu"
          aria-label="打开产品导航"
          :aria-expanded="mobileOpen"
          @click="mobileOpen = true"
        >
          <Menu :size="20" />
        </button>
        <div class="product-breadcrumb">Titan <span>/</span> 产品交付</div>
        <div class="product-topbar-actions">
          <span v-if="lastSync" class="product-last-sync">已同步</span
          ><button
            class="product-icon-button"
            aria-label="刷新项目状态"
            :disabled="loading"
            @click="emit('refresh')"
          >
            <RefreshCw :size="16" :class="{ spinning: loading }" /></button
          ><span class="product-user">P</span>
        </div>
      </header>
      <div v-if="error" class="product-error" role="alert">
        暂时无法更新项目状态。{{ error }}
        <button @click="emit('refresh')">重试</button>
      </div>
      <div
        v-if="partialErrors.length"
        class="product-partial-error"
        role="status"
      >
        部分项目资料尚未同步，当前决策列表可能不完整。<button
          @click="emit('refresh')"
        >
          重新同步
        </button>
      </div>
      <div id="product-content" tabindex="-1"><slot /></div>
    </div>
  </div>
</template>
