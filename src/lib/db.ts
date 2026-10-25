// 本地文件系统存储（通过后端 API），替代 IndexedDB

import { notifyUnauthorized } from "./session";

const API_BASE = "/api/local";

export interface KvRecord {
  key: string;
  value: string;
}

export interface GalleryRecord {
  id: string;
  workspaceId: string;
  workspaceTitle: string;
  prompt: string;
  revisedPrompt: string;
  model: string;
  size: string;
  mode: string;
  filename: string | null;
  url?: string;
  mime?: string;
  contentSha256?: string;
  expiresAt: number | null;
  thumbnailMime?: string | null;
  thumbnailSha256?: string | null;
  thumbnailByteSize?: number | null;
  thumbnailReady?: boolean;
  sourceDataUrl?: string;
  favorite: 0 | 1;
  createdAt: number;
}

export interface GalleryQuery {
  workspaceId?: string;
  limit?: number;
  offset?: number;
  filter?: "all" | "fav" | "text" | "edit";
  query?: string;
}

export interface GalleryPage {
  items: GalleryRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface StorageStatus {
  retentionDays: number;
  nextCleanupAt: number;
  lastCleanupAt: number | null;
  lastDeletedCount: number;
  galleryCount: number;
  inputCount: number;
  lastError: string | null;
}

export interface StorageUpdateResult extends StorageStatus {
  deleted: number;
  failures: { id: string; message: string }[];
}

export interface InputRecord {
  id: string;
  filename: string;
  name: string;
  type: string;
  createdAt: number;
}

export interface PromptRecord {
  id: string;
  kind: "fav" | "recent";
  text: string;
  pinned: 0 | 1;
  usedCount: number;
  createdAt: number;
  updatedAt: number;
}

async function fetchApi(path: string, options?: RequestInit): Promise<any> {
  const response = await fetch(API_BASE + path, options);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) notifyUnauthorized();
  if (!response.ok) throw new Error(data?.error?.message || data?.error || "API error: " + response.status);
  return data;
}

// KV 存储
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const data = await fetchApi("/kv?key=" + encodeURIComponent(key));
  return data.value ? (JSON.parse(data.value) as T) : undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await fetchApi("/kv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
}

// Gallery
export const gallery = {
  async getAll(workspaceId?: string, limit = 300, offset = 0): Promise<GalleryRecord[]> {
    const data = await this.getPage({ workspaceId, limit, offset });
    return data.items;
  },

  async getPage(options: GalleryQuery = {}): Promise<GalleryPage> {
    const params = new URLSearchParams();
    if (options.workspaceId) params.set("workspaceId", options.workspaceId);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined && options.offset > 0) params.set("offset", String(options.offset));
    if (options.filter && options.filter !== "all") params.set("filter", options.filter);
    const query = options.query?.trim();
    if (query) params.set("query", query);
    return fetchApi("/gallery?" + params);
  },

  async add(
    record: Omit<GalleryRecord, "filename" | "favorite" | "expiresAt" | "thumbnailReady"> & { blob?: string; mime?: string },
  ): Promise<GalleryRecord> {
    const data = await fetchApi("/gallery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    return data.record as GalleryRecord;
  },

  async get(id: string): Promise<GalleryRecord> {
    return fetchApi("/gallery/" + encodeURIComponent(id));
  },

  async updateFavorite(id: string, favorite: boolean): Promise<void> {
    await fetchApi("/gallery/favorite", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, favorite }),
    });
  },

  async delete(id: string): Promise<void> {
    await fetchApi("/gallery/" + id, { method: "DELETE" });
  },

  getImageUrl(filename: string): string {
    return API_BASE + "/image/" + filename;
  },

  getContentUrl(id: string): string {
    return API_BASE + "/gallery/" + encodeURIComponent(id) + "/content";
  },

  getThumbnailUrl(id: string): string {
    return API_BASE + "/gallery/" + encodeURIComponent(id) + "/thumbnail";
  },
};

export const storage = {
  async getStatus(): Promise<StorageStatus> {
    return fetchApi("/storage");
  },

  async updateRetentionDays(retentionDays: number): Promise<StorageUpdateResult> {
    return fetchApi("/storage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retentionDays }),
    });
  },
};

// Inputs
export const inputs = {
  async get(id: string): Promise<InputRecord & { blob: string }> {
    const data = await fetchApi("/inputs?id=" + encodeURIComponent(id));
    return data;
  },

  async add(record: Omit<InputRecord, "filename"> & { blob: string }): Promise<void> {
    await fetchApi("/inputs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  },

  async delete(id: string): Promise<void> {
    await fetchApi("/inputs/" + id, { method: "DELETE" });
  },
};

// Prompts
export const prompts = {
  async getByKind(kind: "fav" | "recent"): Promise<PromptRecord[]> {
    const data = await fetchApi("/prompts?kind=" + kind);
    return data.items;
  },

  async add(record: PromptRecord): Promise<void> {
    await fetchApi("/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  },

  async update(id: string, updates: Partial<Pick<PromptRecord, "pinned" | "usedCount" | "updatedAt">>): Promise<void> {
    await fetchApi("/prompts/update", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...updates }),
    });
  },

  async delete(id: string): Promise<void> {
    await fetchApi("/prompts/" + id, { method: "DELETE" });
  },
};
