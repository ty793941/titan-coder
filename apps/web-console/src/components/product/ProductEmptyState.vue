<script setup lang="ts">
defineProps<{
  title: string;
  description: string;
  actionLabel?: string;
}>();
const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <section class="product-empty-state">
    <span class="product-empty-mark" aria-hidden="true" />
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
    <button v-if="actionLabel" class="product-secondary-action" @click="emit('action')">
      {{ actionLabel }}
    </button>
  </section>
</template>
