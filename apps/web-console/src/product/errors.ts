import { ApiError } from "../api";

const messages: Record<string, string> = {
  CONVERSATION_PROPOSAL_CONFLICT:
    "此提案版本无法确认，请重新读取历史并审阅保存的版本。",
  CONTROL_PLANE_UNAVAILABLE:
    "保存服务暂不可用，可用同一提案重试确认，不会重复建立目标。",
  CSRF_UNAVAILABLE: "本机连接尚未就绪，请刷新项目状态后重试。",
  CONVERSATION_UNAVAILABLE: "项目经理对话暂不可用，请稍后重试。",
  CONVERSATION_BUSY: "这个项目正在回复，或本机对话繁忙，请稍后再发送。",
  CONVERSATION_CREDENTIAL_REQUIRED:
    "请先配置模型凭证；使用 Codex 还需要配置 API URL。",
  CONVERSATION_SENSITIVE_INPUT:
    "问题中可能包含凭证，请移除 Key、Token 或私有 API URL 后重试。",
  CONVERSATION_REQUEST_CONFLICT: "该发送请求已被使用，请调整问题后重新发送。",
  CONVERSATION_HISTORY_INVALID:
    "无法安全读取本机对话历史，请检查私有状态目录。",
  NETWORK_UNAVAILABLE: "暂时无法连接项目服务，请确认服务在线后重试。",
  INVALID_RESPONSE: "项目服务返回了无法识别的结果，请刷新后重试。",
  EVENT_STREAM_UNAVAILABLE: "实时活动暂时不可用，稍后会自动重试。",
  VERSION_CONFLICT: "内容已更新，请重新打开并审阅最新版本。",
};

export function productErrorMessage(error: unknown) {
  if (error instanceof ApiError)
    return messages[error.code] || "项目状态暂时无法更新，请稍后重试。";
  if (error instanceof Error && error.name === "AbortError") return "";
  return "项目状态暂时无法更新，请稍后重试。";
}
