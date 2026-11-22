<script setup lang="ts">
import { Layers3 } from "lucide-vue-next";
defineProps<{ title: string; description: string; compact?: boolean }>();
</script>

<template>
  <div class="empty-state" :class="{ compact }">
    <div class="empty-symbol"><Layers3 :size="25" :stroke-width="1.4" /></div>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>
