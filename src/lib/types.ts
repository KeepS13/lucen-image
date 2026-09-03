export type GenMode = "text" | "edit";
export type Theme = "dark" | "light";
export type ImageProvider = "gpt" | "gemini";
export type UploadStatus =
  | "pending"
  | "uploading"
  | "retry_wait"
  | "blocked"
  | "succeeded"
  | "canceled";
export type GeminiAspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";
export type GeminiImageSize = "1K" | "2K" | "4K";

export interface EditInputMeta {
  id: string;
  name: string;
  type: string;
}

export interface Workspace {
  id: string;
  title: string;
  mode: GenMode;
  prompt: string;
  size: string;
  count: number;
  model: string;
  aspectRatio: GeminiAspectRatio;
  imageSize: GeminiImageSize;
  inputs: EditInputMeta[];
  collapsed: boolean;
  createdAt: number;
  // 高级参数
  negativePrompt?: string;
  quality?: string;
  style?: string;
  steps?: number;
  cfgScale?: number;
  seed?: number;
}

/** 运行期结果（内存态，objectUrl 由 blob 创建） */
export interface ResultItem {
  id: string;
  workspaceId: string;
  workspaceTitle: string;
  prompt: string;
  revisedPrompt: string;
  model: string;
  size: string;
  mode: GenMode;
  objectUrl: string;
  url?: string;
  remoteUrl?: string;
  thumbnailUrl?: string | null;
  thumbnailObjectUrl?: string;
  thumbnailReady?: boolean;
  thumbnailMime?: string | null;
  thumbnailSha256?: string | null;
  thumbnailStatus?: UploadStatus;
  thumbnailAttempts?: number;
  thumbnailNextRetryAt?: number | null;
  thumbnailLastUploadError?: string | null;
  thumbnailUploadedAt?: number | null;
  thumbnailByteSize?: number | null;
  mime?: string;
  uploadStatus?: UploadStatus;
  uploadAttempts?: number;
  nextRetryAt?: number | null;
  lastUploadError?: string | null;
  uploadedAt?: number | null;
  hasBlob: boolean;
  sourceDataUrl?: string;
  favorite: boolean;
  createdAt: number;
}

export type PromptKind = "fav" | "recent";

export interface PromptRecord {
  id: string;
  kind: PromptKind;
  text: string;
  pinned: 0 | 1;
  usedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RunState {
  busy: boolean;
  done: number;
  total: number;
  startedAt: number;
  message: string;
  kind: "idle" | "run" | "ok" | "err";
}

export interface Toast {
  id: string;
  text: string;
  type: "ok" | "err" | "info";
}

export type ConnectionStatus = "idle" | "testing" | "ok" | "err";
