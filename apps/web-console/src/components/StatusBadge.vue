<script setup lang="ts">
import { statusLabel } from "../workflow";
defineProps<{ status: string }>();
</script>

<template>
  <span class="status-badge" :data-status="status"
    ><span class="status-dot" />{{ statusLabel(status) }}</span
  >
</template>
