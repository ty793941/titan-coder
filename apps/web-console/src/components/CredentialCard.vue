<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from "vue";
import { ArrowUpRight, KeyRound, LockKeyhole, Check } from "lucide-vue-next";
import { api } from "../api";
import type { CredentialStatus, Provider } from "../types";
const props = defineProps<{
  provider: Provider;
  csrfToken?: string;
  credential?: CredentialStatus;
}>();
const emit = defineEmits<{ changed: []; notify: [message: string] }>();
const key = ref("");
const baseUrl = ref("");
const busy = ref(false);
const error = ref("");
const isQwen = computed(() => props.provider === "qwen");
async function save() {
  if (busy.value || !key.value.trim() || !props.csrfToken) return;
  busy.value = true;
  error.value = "";
  const request = api.saveCredential(
    props.provider,
    key.value.trim(),
    props.csrfToken,
  );
  key.value = "";
  try {
    const result = await request;
    if (!result.configured) throw new Error("not configured");
    emit("changed");
    emit("notify", "Key 已交给本机密钥链保存；请创建运行完成真实模型验收。");
  } catch {
    error.value = "Key 未保存，请检查本机网关与密钥链权限后重新输入。";
  } finally {
    busy.value = false;
  }
}
async function saveBaseUrl() {
  if (busy.value || isQwen.value || !baseUrl.value.trim() || !props.csrfToken) return;
  busy.value = true;
  error.value = "";
  try {
    await api.saveProviderUrl(props.provider, baseUrl.value.trim(), props.csrfToken);
    baseUrl.value = "";
    emit("changed");
    emit("notify", "Codex API URL 已保存到本机密钥链。");
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "API URL 保存失败。";
  } finally { busy.value = false; }
}
onBeforeUnmount(() => {
  key.value = "";
});
</script>

<template>
  <article class="credential-card panel">
    <div class="provider-heading">
      <span class="provider-mark" :class="{ qwen: isQwen }">{{
        isQwen ? "Q" : "C"
      }}</span>
      <div>
        <h3>{{ isQwen ? "Qwen" : "Codex" }}</h3>
        <span class="eyebrow">{{
          isQwen ? "DASHSCOPE · 官方 API" : "OPENAI · APP SERVER"
        }}</span>
      </div>
      <span class="credential-state" :class="{ ready: credential?.configured }"
        ><Check v-if="credential?.configured" :size="13" />{{
          credential?.configured ? "已配置" : "待配置"
        }}</span
      >
    </div>
    <p class="provider-description">
      {{
        isQwen
          ? "通过阿里云百炼官方接口执行任务。Key 所属地域须与服务端 endpoint 一致，默认北京。"
          : "通过本机 Codex App Server 执行任务，使用 API Key 认证。模型以你的账户权限为准。"
      }}
    </p>
    <form @submit.prevent="save">
      <template v-if="!isQwen">
        <label :for="`base-url-${provider}`">Responses API URL <LockKeyhole :size="13" /></label>
        <input :id="`base-url-${provider}`" v-model="baseUrl" type="url" autocomplete="off" spellcheck="false" :disabled="busy" placeholder="https://api.example.com/v1" maxlength="4096" />
        <p class="field-help">必须兼容 OpenAI Responses API；本机 HTTP 仅允许 localhost。</p>
        <button class="button full-width" type="button" :disabled="busy || !baseUrl.trim() || !csrfToken" @click="saveBaseUrl">保存 Codex API URL</button>
        <div class="credential-reference"><span>URL 状态</span><code>{{ credential?.baseUrlConfigured ? "已配置" : "待配置" }}</code></div>
      </template>
      <label :for="`key-${provider}`">API Key <LockKeyhole :size="13" /></label>
      <input
        :id="`key-${provider}`"
        v-model="key"
        type="password"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy"
        :placeholder="
          credential?.configured
            ? '输入新的 Key 以替换'
            : '在本机输入你的 API Key'
        "
        required
        maxlength="4096"
        :aria-describedby="`key-help-${provider}`"
      />
      <p :id="`key-help-${provider}`" class="field-help">
        保存后清空输入框。浏览器不保留 Key，页面只显示配置状态。
      </p>
      <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
      <button
        class="button primary full-width"
        type="submit"
        :disabled="busy || !key.trim() || !csrfToken"
      >
        <KeyRound :size="15" />{{
          busy
            ? "正在安全保存…"
            : credential?.configured
              ? "更新本机 Key"
              : "保存到本机密钥链"
        }}
      </button>
    </form>
    <div class="credential-reference">
      <span>凭证引用</span
      ><code>{{
        credential?.credentialRef ||
        (isQwen ? "keychain://titan-qwen" : "keychain://titan-openai")
      }}</code>
    </div>
    <a
      class="text-link"
      :href="
        isQwen
          ? 'https://bailian.console.aliyun.com/'
          : 'https://platform.openai.com/api-keys'
      "
      target="_blank"
      rel="noopener noreferrer"
      >{{ isQwen ? "前往百炼管理 Key" : "前往 OpenAI 管理 Key"
      }}<ArrowUpRight :size="13"
    /></a>
  </article>
</template>
