import { ApiError } from "../api";

const messages: Record<string, string> = {
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
