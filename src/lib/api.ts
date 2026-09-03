import { GEMINI_MODEL } from "./models";
import { notifyUnauthorized } from "./session";
import type { GeminiAspectRatio, GeminiImageSize, ImageProvider } from "./types";

export interface ApiContext {
  provider: ImageProvider;
}

export class ApiError extends Error {
  status?: number;
  isNetwork?: boolean;
  code?: string;
  upstreamMessage?: string;
  payload?: unknown;
}

export interface ExtractedImage {
  b64?: string;
  url?: string;
  mime: string;
  revisedPrompt: string;
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function embeddedJson(value: string): any | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(value.slice(start));
  } catch {
    return null;
  }
}

function errorCodeFrom(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const data = value as any;
  return String(data.error_code || data.code || data.error?.error_code || data.error?.code || "");
}

function errorMessageFrom(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const data = value as any;
  const message =
    data.message ||
    data.error_description ||
    data.error?.message ||
    data.error?.error_description ||
    data.detail ||
    data.msg;
  return typeof message === "string" ? message : "";
}

function cleanErrorText(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const embedded = embeddedJson(text);
  const embeddedMessage = errorMessageFrom(embedded);
  if (embeddedMessage) return embeddedMessage;
  return text
    .replace(/\s*\{[\s\S]*\}\s*$/, "")
    .replace(/^poll failed:\s*/i, "")
    .trim();
}

function compactText(value: string, max = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

async function fetchJson(ctx: ApiContext, path: string, init: RequestInit): Promise<any> {
  const url = "/api/lucen/" + ctx.provider + path;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const wrapped = new ApiError(error instanceof Error ? error.message : "网络请求失败");
    wrapped.isNetwork = true;
    throw wrapped;
  }

  const text = await response.text();
  const json = safeJsonParse<any>(text, null);
  if (!response.ok) {
    if (response.status === 401 && errorCodeFrom(json) === "AUTH_REQUIRED") notifyUnauthorized();
    const embedded = typeof text === "string" ? embeddedJson(text) : null;
    const upstreamMessage =
      errorMessageFrom(json) ||
      errorMessageFrom(embedded) ||
      cleanErrorText(text) ||
      response.statusText ||
      "HTTP " + response.status;
    const message =
      upstreamMessage ||
      errorCodeFrom(json) ||
      errorCodeFrom(embedded) ||
      "HTTP " + response.status;
    const error = new ApiError(String(message));
    error.status = response.status;
    error.code = errorCodeFrom(json) || errorCodeFrom(embedded);
    error.upstreamMessage = upstreamMessage;
    error.payload = json ?? embedded ?? text;
    throw error;
  }
  return json ?? {};
}

export async function listModels(ctx: ApiContext, signal?: AbortSignal): Promise<string[]> {
  const json = await fetchJson(ctx, "/models", {
    method: "GET",
    signal,
  });
  if (!Array.isArray(json.data)) return [];
  return json.data
    .map((item: any) =>
      typeof item === "string" ? item : item && typeof item.id === "string" ? item.id : "",
    )
    .filter(Boolean);
}

export interface GenerateParams {
  model: string;
  prompt: string;
  size: string;
  negativePrompt?: string;
  quality?: string;
  style?: string;
  steps?: number;
  cfgScale?: number;
  seed?: number;
}

export async function generateImage(ctx: ApiContext, params: GenerateParams, signal: AbortSignal) {
  const body: any = {
    model: params.model,
    prompt: params.prompt,
    size: params.size,
    n: 1,
  };

  // 添加高级参数（如果有值）
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
  if (params.quality) body.quality = params.quality;
  if (params.style) body.style = params.style;
  if (params.steps) body.steps = params.steps;
  if (params.cfgScale) body.cfg_scale = params.cfgScale;
  if (params.seed !== undefined) body.seed = params.seed;

  return fetchJson(ctx, "/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
}

export interface GeminiGenerateParams {
  prompt: string;
  aspectRatio: GeminiAspectRatio;
  imageSize: GeminiImageSize;
}

export async function generateGeminiImage(
  ctx: ApiContext,
  params: GeminiGenerateParams,
  signal: AbortSignal,
) {
  return fetchJson(ctx, "/v1beta/models/" + GEMINI_MODEL + ":generateContent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: params.prompt }] }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: params.aspectRatio,
          imageSize: params.imageSize,
        },
      },
    }),
    signal,
  });
}

export interface EditParams extends GenerateParams {
  files: File[];
}

export async function editImage(ctx: ApiContext, params: EditParams, signal: AbortSignal) {
  const form = new FormData();
  form.append("model", params.model);
  form.append("prompt", params.prompt);
  form.append("size", params.size);
  form.append("n", "1");

  // 添加高级参数（如果有值）
  if (params.negativePrompt) form.append("negative_prompt", params.negativePrompt);
  if (params.quality) form.append("quality", params.quality);
  if (params.style) form.append("style", params.style);
  if (params.steps) form.append("steps", String(params.steps));
  if (params.cfgScale) form.append("cfg_scale", String(params.cfgScale));
  if (params.seed !== undefined) form.append("seed", String(params.seed));

  if (params.files.length <= 1) {
    const file = params.files[0];
    form.append("image", file, file.name);
  } else {
    for (const file of params.files) form.append("image[]", file, file.name);
  }
  return fetchJson(ctx, "/images/edits", {
    method: "POST",
    body: form,
    signal,
  });
}

/** 兼容多种返回字段：data[].b64_json / url / output[] 等 */
export function extractImages(json: any): ExtractedImage[] {
  const items: any[] = [];
  if (Array.isArray(json?.data)) items.push(...json.data);
  if (Array.isArray(json?.output)) items.push(...json.output);
  if (json && (json.b64_json || json.url)) items.push(json);

  const results: ExtractedImage[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const b64 = item.b64_json || item.image_base64 || item.base64 || item.result;
    const url = item.url || item.image_url || item.uri;
    const revisedPrompt = item.revised_prompt || item.prompt || "";
    const mime = item.mime_type || item.mime || "image/png";
    if (b64) {
      results.push({ b64: String(b64), mime, revisedPrompt });
    } else if (url) {
      results.push({ url: String(url), mime, revisedPrompt });
    }
  }
  return results;
}

export function extractGeminiImages(json: any): ExtractedImage[] {
  const results: ExtractedImage[] = [];
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data;
      if (!inline?.data) continue;
      results.push({
        b64: String(inline.data),
        mime: String(inline.mimeType || inline.mime_type || "image/png"),
        revisedPrompt: "",
      });
    }
  }
  return results;
}

export function isRetriable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  const apiError = error as ApiError;
  if (apiError.isNetwork) return true;
  if (apiError.status && (apiError.status >= 500 || apiError.status === 429)) return true;
  return false;
}

export interface ErrorInfo {
  short: string;
  hint?: string;
}

const ERROR_CODE_MESSAGES: Record<string, ErrorInfo> = {
  image_unsafe: {
    short: "生成内容被安全策略拦截",
    hint: "请把 prompt 改得更明确为非露骨、非擦边内容，或更换 seed 后重试。",
  },
  content_policy_violation: {
    short: "请求内容触发安全策略",
    hint: "请删掉敏感、露骨、暴力、侵权或违法相关描述后重试。",
  },
  invalid_api_key: {
    short: "API key 无效",
    hint: "请让服务管理员检查对应 Provider 的环境变量、有效期和模型权限。",
  },
  insufficient_quota: {
    short: "额度不足",
    hint: "请检查账号余额、套餐额度或服务商用量限制。",
  },
  rate_limit_exceeded: {
    short: "请求过于频繁",
    hint: "请降低并发张数或稍等后重试。",
  },
  model_not_found: {
    short: "模型不可用",
    hint: "请点击测试连接刷新模型列表，或改用可用模型。",
  },
  invalid_request_error: {
    short: "请求参数不被接口接受",
    hint: "请检查尺寸、模型、图片数量或高级参数设置。",
  },
  invalid_image: {
    short: "输入图片无效",
    hint: "请换一张 PNG/JPG/WebP 图片，或减少图片大小后重试。",
  },
  file_too_large: {
    short: "上传图片过大",
    hint: "请压缩图片或减少输入图片数量。",
  },
};

function statusError(status: number): ErrorInfo | null {
  if (status === 400) {
    return { short: "请求参数有误", hint: "请检查 prompt、尺寸、模型和高级参数。" };
  }
  if (status === 401 || status === 403) {
    return { short: "Provider 认证失败", hint: "请让服务管理员检查对应 Provider 的环境变量和模型权限。" };
  }
  if (status === 404) {
    return { short: "接口或模型不存在", hint: "请确认所选模型仍受固定上游支持。" };
  }
  if (status === 408) {
    return { short: "请求超时", hint: "请稍后重试，或减少并发张数。" };
  }
  if (status === 413) {
    return { short: "上传内容过大", hint: "请压缩图片或减少输入图片数量。" };
  }
  if (status === 415) {
    return { short: "文件格式不支持", hint: "请使用 PNG、JPG 或 WebP 图片。" };
  }
  if (status === 422) {
    return { short: "请求内容无法处理", hint: "请检查 prompt、输入图片和高级参数。" };
  }
  if (status === 429) {
    return { short: "请求被限流", hint: "请降低并发张数，稍等后重试。" };
  }
  if (status === 451) {
    return {
      short: "生成内容被安全策略拦截",
      hint: "请把 prompt 改得更明确为非露骨、非擦边内容，或更换 seed 后重试。",
    };
  }
  if (status === 524) {
    return {
      short: "上游图像任务处理超时",
      hint: "图生图任务已在服务商侧等待过久。请减少输入图数量/图片尺寸，降低并发，或稍后重试。",
    };
  }
  if (status >= 500) {
    return { short: "上游服务暂时不可用", hint: "请稍后重试；如果持续失败，可能是服务商接口异常。" };
  }
  return null;
}

export function explainError(error: unknown): ErrorInfo {
  const err = error as ApiError | undefined;
  if (err && err.name === "AbortError") {
    return { short: "请求已取消" };
  }
  if (err && err.isNetwork) {
    return {
      short: "网络或跨域请求失败",
      hint: "请检查网络连接，并确认本地工作台代理仍在运行。",
    };
  }
  const code = String(err?.code || "").toLowerCase();
  if (code && ERROR_CODE_MESSAGES[code]) {
    return ERROR_CODE_MESSAGES[code];
  }
  if (err?.status) {
    const mapped = statusError(err.status);
    if (mapped) return mapped;
  }
  if (err?.status) {
    const detail = compactText(cleanErrorText(err.upstreamMessage || err.message));
    return { short: "接口错误 " + err.status + (detail ? "：" + detail : "") };
  }
  return { short: compactText(cleanErrorText(err?.message || "未知错误")) };
}
