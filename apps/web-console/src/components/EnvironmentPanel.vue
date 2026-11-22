<script setup lang="ts">
import { ref } from "vue";
import {
  Cpu,
  HardDrive,
  Play,
  Square,
  RefreshCw,
  ShieldCheck,
  Server,
} from "lucide-vue-next";
import { api, errorMessage } from "../api";
import type { Daemon, LocalStatus } from "../types";
import CredentialCard from "./CredentialCard.vue";
import StatusBadge from "./StatusBadge.vue";
const props = defineProps<{
  status: LocalStatus | null;
  daemons: Daemon[];
  error?: string;
}>();
const emit = defineEmits<{ refresh: []; notify: [message: string] }>();
const busy = ref(false);
const actionError = ref("");
async function daemonAction(action: "start" | "stop") {
  if (!props.status || busy.value) return;
  busy.value = true;
  actionError.value = "";
  try {
    await api.daemon(action, props.status.csrfToken);
    emit("refresh");
    emit(
      "notify",
      action === "start"
        ? "已发送启动请求，设备注册后可运行任务。"
        : "本机 Daemon 已停止。",
    );
  } catch (error) {
    actionError.value = errorMessage(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="view-intro">
    <div>
      <div class="eyebrow">LOCAL ENVIRONMENT</div>
      <h2>让本机准备就绪<span class="accent">.</span></h2>
      <p>连接执行环境，安全配置模型凭证，然后开始真实验收。</p>
    </div>
    <button class="button" @click="emit('refresh')">
      <RefreshCw :size="15" />刷新状态
    </button>
  </section>
  <div v-if="error" role="alert" class="notice error">
    <Server :size="18" />
    <div>
      <strong>本机网关暂不可用</strong>
      <p>{{ error }}</p>
    </div>
  </div>
  <section class="panel machine-panel">
    <div class="panel-heading">
      <div class="heading-with-icon">
        <div class="icon-tile"><Cpu :size="20" /></div>
        <div>
          <h3>本机执行环境</h3>
          <p>Daemon 负责隔离运行、事件同步与恢复。</p>
        </div>
      </div>
      <StatusBadge :status="status?.daemon.running ? 'online' : 'offline'" />
    </div>
    <div class="machine-details">
      <div>
        <span class="meta-label">控制面</span
        ><strong
          ><i
            class="small-dot"
            :class="{ green: status?.controlPlane.reachable }"
          />{{
            status
              ? status.controlPlane.reachable
                ? "连接正常"
                : "无法连接"
              : "状态未知"
          }}</strong
        >
      </div>
      <div>
        <span class="meta-label">操作系统</span
        ><strong>{{ status?.platform || "等待本机状态" }}</strong>
      </div>
      <div class="workspace-detail">
        <span class="meta-label">授权工作区</span
        ><code>{{ status?.workspaceRoot || "等待本机网关返回工作区" }}</code>
      </div>
    </div>
    <div class="machine-footer">
      <span class="helper-text"
        ><HardDrive :size="14" /><code>{{
          status?.daemon.daemonId || "尚无本机设备 ID"
        }}</code></span
      ><button
        v-if="status?.daemon.running"
        class="button danger-quiet"
        :disabled="busy"
        @click="daemonAction('stop')"
      >
        <Square :size="14" />{{ busy ? "停止中…" : "停止 Daemon" }}</button
      ><button
        v-else
        class="button primary"
        :disabled="busy || !status || !status.controlPlane.reachable"
        @click="daemonAction('start')"
      >
        <Play :size="14" />{{ busy ? "启动中…" : "启动本机 Daemon" }}
      </button>
    </div>
    <p v-if="actionError" role="alert" class="inline-error padded-error">
      {{ actionError }}
    </p>
  </section>
  <div class="section-heading">
    <div>
      <h3>模型与凭证</h3>
      <p>只保存在当前机器，每个提供方独立配置。</p>
    </div>
    <span class="eyebrow">02 PROVIDERS</span>
  </div>
  <div class="credential-grid">
    <CredentialCard
      v-for="provider in ['qwen', 'codex'] as const"
      :key="provider"
      :provider="provider"
      :credential="
        status?.credentials.find((item) => item.provider === provider)
      "
      :csrf-token="status?.csrfToken"
      @changed="emit('refresh')"
      @notify="(message) => emit('notify', message)"
    />
  </div>
  <div class="notice">
    <ShieldCheck :size="19" />
    <div>
      <strong>配置完成后，还需要一次真实运行</strong>
      <p>
        “已配置”表示密钥链已有凭证。模型权限、网络和工具产出以运行记录为准；启动运行可能产生
        API 费用。
      </p>
    </div>
  </div>
  <section v-if="daemons.length" class="panel registered-devices">
    <div class="panel-heading">
      <h3>已注册执行设备</h3>
      <span class="count-label">{{ daemons.length }} 台设备</span>
    </div>
    <div v-for="daemon in daemons" :key="daemon.daemonId" class="device-row">
      <Server :size="16" />
      <div>
        <strong>{{ daemon.machineName }}</strong
        ><code>{{ daemon.daemonId }}</code>
      </div>
      <StatusBadge :status="daemon.status" />
    </div>
  </section>
</template>
