import { create } from "zustand";
import {
  editImage,
  explainError,
  extractGeminiImages,
  extractImages,
  generateGeminiImage,
  generateImage,
  isRetriable,
  listModels,
  type ApiContext,
  type ExtractedImage,
} from "./api";
import { gallery, inputs, prompts, kvGet, kvSet, type GalleryRecord } from "./db";
import {
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_MODEL,
  GPT_MODEL,
  GPT_MODEL_IDS,
  MODEL_IDS,
  isSupportedModel,
  providerForModel,
} from "./models";
import { getRuntimeConfig } from "./session";
import type {
  ConnectionStatus,
  EditInputMeta,
  GenMode,
  GeminiAspectRatio,
  GeminiImageSize,
  ImageProvider,
  PromptRecord,
  ResultItem,
  RunState,
  Theme,
  Toast,
  Workspace,
} from "./types";
import {
  blobToDataUrl,
  clamp,
  dataUrlToBlob,
  delay,
  downloadBlob,
  fileStamp,
  extOfMime,
  resultFileBase,
  safeFilePart,
  uid,
} from "./utils";

export const DEFAULT_MODEL = GPT_MODEL;
const SETTINGS_KEY = "lucen2-settings";
const LEGACY_SETTINGS_KEY = "lucen-image-studio-settings";
const KEY_SESSION_KEYS = [
  "lucen2-session-key",
  "lucen2-gemini-session-key",
  "lucen-image-studio-session-key",
  "lucen-image-studio-gemini-session-key",
];
const RESULTS_PER_WORKSPACE = 24;
const MAX_INPUTS = 6;

export const SIZE_OPTIONS = [
  { value: "auto", label: "auto", ratio: "智能" },
  { value: "1024x1024", label: "1024×1024", ratio: "1:1" },
  { value: "1536x1024", label: "1536×1024", ratio: "3:2" },
  { value: "1024x1536", label: "1024×1536", ratio: "2:3" },
  { value: "2048x2048", label: "2048×2048", ratio: "1:1" },
  { value: "2048x1152", label: "2048×1152", ratio: "16:9" },
  { value: "3840x2160", label: "3840×2160", ratio: "16:9" },
  { value: "2160x3840", label: "2160×3840", ratio: "9:16" },
];

function safeParse<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

interface InputBlobEntry {
  blob: Blob;
  dataUrl: string;
}

interface ViewerState {
  open: boolean;
  items: ResultItem[];
  index: number;
}

type ProviderConnections = Record<
  ImageProvider,
  { status: ConnectionStatus; message: string }
>;

const controllers = new Map<string, AbortController>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

interface AppStore {
  booted: boolean;

  providers: Record<ImageProvider, boolean>;
  theme: Theme;
  connections: ProviderConnections;

  workspaces: Workspace[];
  runs: Record<string, RunState>;
  results: Record<string, ResultItem[]>;
  inputBlobs: Record<string, InputBlobEntry>;
  focusedId: string | null;

  viewer: ViewerState;
  galleryOpen: boolean;
  paletteOpen: boolean;
  libraryOpen: boolean;
  libraryTargetId: string | null;
  toasts: Toast[];
  galleryVersion: number;
  promptsVersion: number;

  boot: () => Promise<void>;

  setTheme: (theme: Theme) => void;
  testConnection: (provider: ImageProvider) => Promise<void>;

  addWorkspace: (seed?: Partial<Workspace>) => Workspace;
  duplicateWorkspace: (id: string) => void;
  removeWorkspace: (id: string) => Promise<void>;
  updateWorkspace: (id: string, patch: Partial<Workspace>) => void;
  focusWorkspace: (id: string) => void;
  clearResults: (id: string) => void;

  addInputFiles: (id: string, files: File[] | Blob[]) => Promise<void>;
  removeInput: (id: string, inputId: string) => void;
  useResultAsInput: (workspaceId: string, item: ResultItem) => Promise<void>;
  resultToNewWorkspace: (item: ResultItem) => Promise<void>;

  runWorkspace: (id: string) => Promise<void>;
  cancelRun: (id: string) => void;

  deleteResult: (item: ResultItem) => Promise<void>;
  toggleFavorite: (item: ResultItem) => Promise<void>;

  savePromptFav: (text: string) => Promise<void>;
  bumpPrompts: () => void;

  openViewer: (items: ResultItem[], index: number) => void;
  closeViewer: () => void;
  setViewerIndex: (index: number) => void;
  setGalleryOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setLibraryOpen: (open: boolean, targetId?: string | null) => void;
  toast: (text: string, type?: Toast["type"]) => void;
  dismissToast: (id: string) => void;
  bumpGallery: () => void;
  syncGallery: () => Promise<void>;
}

function makeRun(partial?: Partial<RunState>): RunState {
  return {
    busy: false,
    done: 0,
    total: 0,
    startedAt: 0,
    message: "就绪",
    kind: "idle",
    ...partial,
  };
}

function recordToItem(record: GalleryRecord): ResultItem {
  const objectUrl = gallery.getContentUrl(record.id);
  const thumbnailObjectUrl = record.thumbnailReady ? gallery.getThumbnailUrl(record.id) : "";
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workspaceTitle: record.workspaceTitle,
    prompt: record.prompt,
    revisedPrompt: record.revisedPrompt,
    model: record.model,
    size: record.size,
    mode: record.mode as GenMode,
    objectUrl,
    url: record.url,
    thumbnailObjectUrl,
    thumbnailReady: Boolean(record.thumbnailReady),
    thumbnailMime: record.thumbnailMime,
    thumbnailSha256: record.thumbnailSha256,
    thumbnailByteSize: record.thumbnailByteSize,
    mime: record.mime,
    expiresAt: record.expiresAt,
    hasBlob: Boolean(record.filename),
    sourceDataUrl: record.sourceDataUrl,
    favorite: record.favorite === 1,
    createdAt: record.createdAt,
  };
}

function normalizedWorkspace(workspace: Workspace): Workspace {
  const model = isSupportedModel(workspace.model) ? workspace.model : GPT_MODEL;
  const aspectRatio = GEMINI_ASPECT_RATIOS.includes(workspace.aspectRatio as GeminiAspectRatio)
    ? workspace.aspectRatio
    : "1:1";
  const imageSize = GEMINI_IMAGE_SIZES.includes(workspace.imageSize as GeminiImageSize)
    ? workspace.imageSize
    : "1K";
  return {
    ...workspace,
    model,
    mode: model === GEMINI_MODEL ? "text" : workspace.mode || "text",
    size: workspace.size || "auto",
    aspectRatio,
    imageSize,
    inputs: Array.isArray(workspace.inputs) ? workspace.inputs : [],
  };
}

function clearStoredProviderKeys() {
  for (const key of [SETTINGS_KEY, LEGACY_SETTINGS_KEY]) {
    const saved = safeParse<Record<string, unknown>>(localStorage.getItem(key), {});
    let changed = false;
    for (const field of ["apiKey", "gptApiKey", "geminiApiKey", "persistKey"]) {
      if (Object.hasOwn(saved, field)) {
        delete saved[field];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(key, JSON.stringify(saved));
  }
  for (const key of KEY_SESSION_KEYS) sessionStorage.removeItem(key);
}

function resultSize(workspace: Workspace): string {
  return workspace.model === GEMINI_MODEL
    ? workspace.imageSize + " · " + workspace.aspectRatio
    : workspace.size;
}

export const useApp = create<AppStore>()((set, get) => {
  function persistSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: get().theme }));
  }

  function persistWorkspaces() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void kvSet("workspaces", get().workspaces);
    }, 250);
  }

  function setRun(id: string, patch: Partial<RunState>) {
    set((state) => ({ runs: { ...state.runs, [id]: { ...makeRun(), ...state.runs[id], ...patch } } }));
  }

  function prependResult(id: string, item: ResultItem) {
    set((state) => ({
      results: { ...state.results, [id]: [item, ...(state.results[id] || [])] },
    }));
  }

  async function recordRecentPrompt(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const existing = await prompts.getByKind("recent");
    const match = existing.find((p) => p.text === trimmed);
    const now = Date.now();
    if (match) {
      await prompts.update(match.id, { usedCount: match.usedCount + 1, updatedAt: now });
    } else {
      const record: PromptRecord = {
        id: uid(),
        kind: "recent",
        text: trimmed,
        pinned: 0,
        usedCount: 1,
        createdAt: now,
        updatedAt: now,
      };
      await prompts.add(record);
      const recents = existing.sort((a, b) => b.updatedAt - a.updatedAt);
      if (recents.length >= 50) {
        for (const stale of recents.slice(49)) await prompts.delete(stale.id);
      }
    }
    get().bumpPrompts();
  }

  async function materializeImage(
    workspace: Workspace,
    image: ExtractedImage,
    sourceDataUrl?: string,
  ): Promise<ResultItem> {
    let blobBase64: string | undefined;
    let url = image.url;
    if (image.b64) {
      const dataUrl = image.b64.startsWith("data:")
        ? image.b64
        : "data:" + image.mime + ";base64," + image.b64;
      blobBase64 = image.b64.startsWith("data:") ? image.b64.split(",")[1] : image.b64;
    } else if (image.url) {
      try {
        const response = await fetch(image.url);
        if (response.ok) {
          const blob = await response.blob();
          const dataUrl = await blobToDataUrl(blob);
          blobBase64 = dataUrl.split(",")[1];
          image = { ...image, mime: blob.type || image.mime };
        }
      } catch {
        // URL 拉取失败时保留 url 直接展示
      }
    }

    const id = uid();
    const now = Date.now();
    const stored = await gallery.add({
      id,
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      prompt: workspace.prompt,
      revisedPrompt: image.revisedPrompt,
      model: workspace.model,
      size: resultSize(workspace),
      mode: workspace.model === GEMINI_MODEL ? "text" : workspace.mode,
      blob: blobBase64,
      mime: image.mime,
      url,
      sourceDataUrl,
      createdAt: now,
    });

    get().bumpGallery();
    return recordToItem(stored);
  }

  return {
    booted: false,

    providers: { gpt: false, gemini: false },
    theme: "dark",
    connections: {
      gpt: { status: "idle", message: "未连接" },
      gemini: { status: "idle", message: "未连接" },
    },

    workspaces: [],
    runs: {},
    results: {},
    inputBlobs: {},
    focusedId: null,

    viewer: { open: false, items: [], index: 0 },
    galleryOpen: false,
    paletteOpen: false,
    libraryOpen: false,
    libraryTargetId: null,
    toasts: [],
    galleryVersion: 0,
    promptsVersion: 0,

    boot: async () => {
      // 1. 清理历史浏览器密钥，只保留无敏感信息的界面设置。
      clearStoredProviderKeys();
      const saved = safeParse<Record<string, any>>(localStorage.getItem(SETTINGS_KEY), {});
      const theme: Theme = saved.theme === "light" ? "light" : "dark";
      document.documentElement.dataset.theme = theme;
      let providers: Record<ImageProvider, boolean> = { gpt: false, gemini: false };
      let connections: ProviderConnections = {
        gpt: { status: "err", message: "服务端未配置" },
        gemini: { status: "err", message: "服务端未配置" },
      };
      try {
        providers = (await getRuntimeConfig()).providers;
        connections = {
          gpt: {
            status: providers.gpt ? "ok" : "err",
            message: providers.gpt ? "服务端已配置" : "服务端未配置",
          },
          gemini: {
            status: providers.gemini ? "ok" : "err",
            message: providers.gemini ? "服务端已配置" : "服务端未配置",
          },
        };
      } catch {
        connections = {
          gpt: { status: "err", message: "配置状态读取失败" },
          gemini: { status: "err", message: "配置状态读取失败" },
        };
      }
      set({ providers, connections, theme });
      persistSettings();

      // 2-4. 工作区 / 输入图 / 历史结果（本地 API 故障时退化为全新会话）
      let workspaces: Workspace[] = [];
      const inputBlobs: Record<string, InputBlobEntry> = {};
      const results: Record<string, ResultItem[]> = {};
      const runs: Record<string, RunState> = {};
      try {
        workspaces = (await kvGet<Workspace[]>("workspaces")) || [];
        if (!Array.isArray(workspaces)) workspaces = [];
        workspaces = workspaces.map(normalizedWorkspace);

        for (const workspace of workspaces) {
          const alive: EditInputMeta[] = [];
          for (const meta of workspace.inputs || []) {
            try {
              const record = await inputs.get(meta.id);
              if (record && record.blob) {
                const dataUrl = "data:" + record.type + ";base64," + record.blob;
                const blob = await dataUrlToBlob(dataUrl);
                inputBlobs[meta.id] = { blob, dataUrl };
                alive.push(meta);
              }
            } catch {
              // 输入图丢失，跳过
            }
          }
          workspace.inputs = alive;
        }

        for (const workspace of workspaces) {
          const records = await gallery.getAll(workspace.id, RESULTS_PER_WORKSPACE);
          results[workspace.id] = records.map(recordToItem);
          runs[workspace.id] = makeRun();
        }
      } catch (error) {
        console.error("[lucen] 本地数据加载失败", error);
        setTimeout(
          () => get().toast("本地历史数据加载失败，已以全新会话启动", "err"),
          600,
        );
      }

      if (workspaces.length === 0) {
        const fresh: Workspace = {
          id: uid(),
          title: "窗口 1",
          mode: "text",
          prompt: "",
          size: "auto",
          count: 1,
          model: DEFAULT_MODEL,
          aspectRatio: "1:1",
          imageSize: "1K",
          inputs: [],
          collapsed: false,
          createdAt: Date.now(),
        };
        workspaces = [fresh];
        results[fresh.id] = [];
        runs[fresh.id] = makeRun();
      }

      set({
        workspaces,
        results,
        runs,
        inputBlobs,
        focusedId: workspaces[0]?.id || null,
        booted: true,
      });
      void kvSet("workspaces", workspaces).catch(() => undefined);

    },
    setTheme: (theme) => {
      document.documentElement.dataset.theme = theme;
      set({ theme });
      persistSettings();
    },

    testConnection: async (provider) => {
      const state = get();
      const expectedModels = provider === "gpt" ? GPT_MODEL_IDS : [GEMINI_MODEL];
      if (!state.providers[provider]) {
        set((current) => ({
          connections: {
            ...current.connections,
            [provider]: { status: "err", message: "服务端未配置" },
          },
        }));
        return;
      }
      set((current) => ({
        connections: {
          ...current.connections,
          [provider]: { status: "testing", message: "正在测试连接…" },
        },
      }));
      try {
        const ids = await listModels({ provider });
        const missingModels = expectedModels.filter((model) => !ids.includes(model));
        const available = missingModels.length === 0;
        set((current) => ({
          connections: {
            ...current.connections,
            [provider]: {
              status: available ? "ok" : "err",
              message: available
                ? "连接成功，模型可用"
                : "连接成功，但未发现 " + missingModels.join("、"),
            },
          },
        }));
      } catch (error) {
        const info = explainError(error);
        set((current) => ({
          connections: {
            ...current.connections,
            [provider]: {
              status: "err",
              message: info.short,
            },
          },
        }));
        if (info.hint) get().toast(info.hint, "err");
      }
    },

    addWorkspace: (seed) => {
      const number = get().workspaces.length + 1;
      const workspace = normalizedWorkspace({
        id: uid(),
        title: seed?.title || "窗口 " + number,
        mode: seed?.mode || "text",
        prompt: seed?.prompt || "",
        size: seed?.size || "auto",
        count: seed?.count || 1,
        model: seed?.model && isSupportedModel(seed.model) ? seed.model : DEFAULT_MODEL,
        aspectRatio: seed?.aspectRatio || "1:1",
        imageSize: seed?.imageSize || "1K",
        inputs: seed?.inputs || [],
        collapsed: false,
        createdAt: Date.now(),
      });
      set((state) => ({
        workspaces: [workspace, ...state.workspaces],
        runs: { ...state.runs, [workspace.id]: makeRun() },
        results: { ...state.results, [workspace.id]: [] },
        focusedId: workspace.id,
      }));
      persistWorkspaces();
      return workspace;
    },

    duplicateWorkspace: (id) => {
      const source = get().workspaces.find((w) => w.id === id);
      if (!source) return;
      // 复制输入图引用：为副本生成新的 input 记录，避免删除联动
      const copyInputs = async () => {
        const metas: EditInputMeta[] = [];
        const blobs: Record<string, InputBlobEntry> = {};
        for (const meta of source.inputs) {
          const entry = get().inputBlobs[meta.id];
          if (!entry) continue;
          const newId = uid();
          metas.push({ ...meta, id: newId });
          blobs[newId] = entry;
          const blobBase64 = entry.dataUrl.split(",")[1];
          await inputs.add({
            id: newId,
            name: meta.name,
            type: meta.type,
            blob: blobBase64,
            createdAt: Date.now(),
          });
        }
        return { metas, blobs };
      };
      void copyInputs().then(({ metas, blobs }) => {
        const workspace = get().addWorkspace({
          title: source.title + " 副本",
          mode: source.mode,
          prompt: source.prompt,
          size: source.size,
          count: source.count,
          model: source.model,
          aspectRatio: source.aspectRatio,
          imageSize: source.imageSize,
          inputs: metas,
        });
        set((state) => ({ inputBlobs: { ...state.inputBlobs, ...blobs } }));
        get().toast("已复制「" + source.title + "」", "ok");
        void workspace;
      });
    },

    removeWorkspace: async (id) => {
      const { workspaces, results } = get();
      const workspace = workspaces.find((w) => w.id === id);
      if (!workspace) return;
      get().cancelRun(id);
      for (const meta of workspace.inputs) {
        await inputs.delete(meta.id).catch(() => undefined);
      }
      set((state) => {
        const nextWorkspaces = state.workspaces.filter((w) => w.id !== id);
        const { [id]: _r, ...runs } = state.runs;
        const { [id]: _res, ...resultsRest } = state.results;
        const inputBlobs = { ...state.inputBlobs };
        for (const meta of workspace.inputs) delete inputBlobs[meta.id];
        return {
          workspaces: nextWorkspaces,
          runs,
          results: resultsRest,
          inputBlobs,
          focusedId: nextWorkspaces[0]?.id || null,
        };
      });
      if (get().workspaces.length === 0) {
        get().addWorkspace();
      }
      persistWorkspaces();
    },

    updateWorkspace: (id, patch) => {
      set((state) => ({
        workspaces: state.workspaces.map((workspace) => {
          if (workspace.id !== id) return workspace;
          const next = { ...workspace, ...patch };
          if (next.model === GEMINI_MODEL) next.mode = "text";
          return normalizedWorkspace(next);
        }),
      }));
      persistWorkspaces();
    },

    focusWorkspace: (id) => set({ focusedId: id }),

    clearResults: (id) => {
      set((state) => ({ results: { ...state.results, [id]: [] } }));
      get().toast("已清空卡片，历史仍保留在画廊", "info");
    },

    addInputFiles: async (id, files) => {
      const workspace = get().workspaces.find((w) => w.id === id);
      if (!workspace) return;
      if (workspace.model === GEMINI_MODEL) {
        get().toast("Gemini 仅支持文生图，请先切换到 GPT Image 2", "err");
        return;
      }
      const room = MAX_INPUTS - workspace.inputs.length;
      const list = Array.from(files).slice(0, Math.max(0, room));
      if (!list.length) {
        get().toast("最多 " + MAX_INPUTS + " 张输入图", "err");
        return;
      }
      const metas: EditInputMeta[] = [];
      const blobs: Record<string, InputBlobEntry> = {};
      for (const blobLike of list) {
        const blob = blobLike instanceof Blob ? blobLike : new Blob([blobLike]);
        if (!blob.type.startsWith("image/")) continue;
        const name =
          blobLike instanceof File ? blobLike.name : "pasted-" + Date.now() + ".png";
        const inputId = uid();
        const dataUrl = await blobToDataUrl(blob);
        const blobBase64 = dataUrl.split(",")[1];
        await inputs.add({
          id: inputId,
          name,
          type: blob.type || "image/png",
          blob: blobBase64,
          createdAt: Date.now(),
        });
        metas.push({ id: inputId, name, type: blob.type || "image/png" });
        blobs[inputId] = { blob, dataUrl };
      }
      if (!metas.length) return;
      set((state) => ({ inputBlobs: { ...state.inputBlobs, ...blobs } }));
      get().updateWorkspace(id, {
        inputs: [...workspace.inputs, ...metas],
        mode: "edit",
      });
    },

    removeInput: (id, inputId) => {
      const workspace = get().workspaces.find((w) => w.id === id);
      if (!workspace) return;
      void inputs.delete(inputId).catch(() => undefined);
      set((state) => {
        const inputBlobs = { ...state.inputBlobs };
        delete inputBlobs[inputId];
        return { inputBlobs };
      });
      get().updateWorkspace(id, { inputs: workspace.inputs.filter((m) => m.id !== inputId) });
    },

    useResultAsInput: async (workspaceId, item) => {
      let blob: Blob | null = null;
      try {
        if (item.hasBlob && item.objectUrl) {
          const response = await fetch(item.objectUrl);
          if (response.ok) blob = await response.blob();
        }
      } catch {
        blob = null;
      }
      if (!blob && item.url) {
        try {
          const response = await fetch(item.url);
          if (response.ok) blob = await response.blob();
        } catch {
          blob = null;
        }
      }
      if (!blob) {
        get().toast("无法读取图片数据，可先下载后手动上传", "err");
        return;
      }
      const file = new File([blob], resultFileBase(item) + "." + extOfMime(blob.type), {
        type: blob.type || "image/png",
      });
      await get().addInputFiles(workspaceId, [file]);
      get().toast("已设为二创输入", "ok");
    },

    resultToNewWorkspace: async (item) => {
      const workspace = get().addWorkspace({
        title: "二创 · " + item.workspaceTitle,
        mode: "edit",
        prompt: item.prompt,
        size: item.model === GEMINI_MODEL ? "auto" : item.size,
        model: GPT_MODEL,
      });
      await get().useResultAsInput(workspace.id, item);
    },

    runWorkspace: async (id) => {
      const state = get();
      const workspace = state.workspaces.find((w) => w.id === id);
      if (!workspace || state.runs[id]?.busy) return;

      const prompt = workspace.prompt.trim();
      if (!prompt) {
        setRun(id, { message: "请填写 prompt", kind: "err" });
        return;
      }
      const inputEntries = workspace.inputs
        .map((meta) => ({ meta, entry: state.inputBlobs[meta.id] }))
        .filter((x): x is { meta: EditInputMeta; entry: InputBlobEntry } => Boolean(x.entry));
      if (workspace.mode === "edit" && inputEntries.length === 0) {
        setRun(id, { message: "请先添加至少一张输入图", kind: "err" });
        return;
      }

      void recordRecentPrompt(prompt);

      const controller = new AbortController();
      controllers.set(id, controller);
      const total = clamp(workspace.count, 1, 4);
      setRun(id, {
        busy: true,
        done: 0,
        total,
        startedAt: Date.now(),
        message: "并发生成 0 / " + total + " …",
        kind: "run",
      });

      const provider = providerForModel(workspace.model);
      if (!state.providers[provider]) {
        setRun(id, { message: "该模型的服务端密钥未配置", kind: "err" });
        return;
      }
      const ctx: ApiContext = { provider };
      const files = inputEntries.map(
        ({ meta, entry }) =>
          new File([entry.blob], meta.name, { type: meta.type || "image/png" }),
      );
      const sourceDataUrl =
        workspace.mode === "edit" ? inputEntries[0]?.entry.dataUrl : undefined;

      const task = async (): Promise<number> => {
        let attempt = 0;
        for (;;) {
          try {
            const json =
              provider === "gemini"
                ? await generateGeminiImage(
                    ctx,
                    {
                      prompt,
                      aspectRatio: workspace.aspectRatio,
                      imageSize: workspace.imageSize,
                    },
                    controller.signal,
                  )
                : workspace.mode === "edit"
                ? await editImage(
                    ctx,
                    {
                      model: workspace.model,
                      prompt,
                      size: workspace.size,
                      files,
                      negativePrompt: workspace.negativePrompt,
                      quality: workspace.quality,
                      style: workspace.style,
                      steps: workspace.steps,
                      cfgScale: workspace.cfgScale,
                      seed: workspace.seed,
                    },
                    controller.signal,
                  )
                : await generateImage(
                    ctx,
                    {
                      model: workspace.model,
                      prompt,
                      size: workspace.size,
                      negativePrompt: workspace.negativePrompt,
                      quality: workspace.quality,
                      style: workspace.style,
                      steps: workspace.steps,
                      cfgScale: workspace.cfgScale,
                      seed: workspace.seed,
                    },
                    controller.signal,
                  );
            const images = provider === "gemini" ? extractGeminiImages(json) : extractImages(json);
            if (!images.length) throw new Error("接口返回成功，但没有可显示的图片字段");
            for (const image of images) {
              const item = await materializeImage(workspace, image, sourceDataUrl);
              prependResult(id, item);
            }
            return images.length;
          } catch (error) {
            if (controller.signal.aborted || !isRetriable(error) || attempt >= 1) throw error;
            attempt += 1;
            await delay(900);
          }
        }
      };

      const settled = await Promise.allSettled(
        Array.from({ length: total }, () =>
          task().finally(() => {
            const run = get().runs[id];
            if (run?.busy) {
              setRun(id, {
                done: run.done + 1,
                message: "并发生成 " + (run.done + 1) + " / " + total + " …",
              });
            }
          }),
        ),
      );

      controllers.delete(id);
      const succeeded = settled.filter((s) => s.status === "fulfilled");
      const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      const elapsed = ((Date.now() - get().runs[id].startedAt) / 1000).toFixed(1);
      const count = succeeded.reduce(
        (sum, s) => sum + (s as PromiseFulfilledResult<number>).value,
        0,
      );

      if (count === 0) {
        const info = explainError(failed[0]?.reason);
        setRun(id, { busy: false, message: info.short, kind: "err" });
        if (info.hint) get().toast(info.hint, "err");
      } else if (failed.length > 0) {
        const info = explainError(failed[0]?.reason);
        setRun(id, {
          busy: false,
          message: "完成 " + count + " 张（" + failed.length + " 个请求失败：" + info.short + "）",
          kind: "err",
        });
      } else {
        setRun(id, {
          busy: false,
          message: "完成 " + count + " 张 · 耗时 " + elapsed + " 秒",
          kind: "ok",
        });
      }
    },

    cancelRun: (id) => {
      controllers.get(id)?.abort();
    },

    deleteResult: async (item) => {
      if (!window.confirm("这会永久删除本地原图、缩略图和画廊记录。继续吗？")) return;
      try {
        await gallery.delete(item.id);
      } catch (error) {
        get().toast(error instanceof Error ? error.message : "删除失败", "err");
        return;
      }
      set((state) => ({
        results: {
          ...state.results,
          [item.workspaceId]: (state.results[item.workspaceId] || []).filter(
            (r) => r.id !== item.id,
          ),
        },
      }));
      get().bumpGallery();
      get().toast("已删除本地图片", "ok");
    },

    toggleFavorite: async (item) => {
      const next = !item.favorite;
      try {
        await gallery.updateFavorite(item.id, next);
      } catch (error) {
        get().toast(error instanceof Error ? error.message : "收藏状态更新失败", "err");
        return;
      }
      try {
        const updated = recordToItem(await gallery.get(item.id));
        set((state) => ({
          results: {
            ...state.results,
            [item.workspaceId]: (state.results[item.workspaceId] || []).map((r) =>
              r.id === item.id ? updated : r,
            ),
          },
        }));
      } catch {
        set((state) => ({
          results: {
            ...state.results,
            [item.workspaceId]: (state.results[item.workspaceId] || []).filter((r) => r.id !== item.id),
          },
        }));
        get().toast("该图片已超过保留期限并被清理", "info");
      }
      get().bumpGallery();
    },

    savePromptFav: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        get().toast("Prompt 为空", "err");
        return;
      }
      const favs = await prompts.getByKind("fav");
      if (favs.some((p) => p.text === trimmed)) {
        get().toast("已在 Prompt 库中", "info");
        return;
      }
      const now = Date.now();
      await prompts.add({
        id: uid(),
        kind: "fav",
        text: trimmed,
        pinned: 0,
        usedCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      get().bumpPrompts();
      get().toast("已收藏到 Prompt 库", "ok");
    },

    bumpPrompts: () => set((state) => ({ promptsVersion: state.promptsVersion + 1 })),

    openViewer: (items, index) =>
      set({ viewer: { open: true, items, index: clamp(index, 0, items.length - 1) } }),
    closeViewer: () => set((state) => ({ viewer: { ...state.viewer, open: false } })),
    setViewerIndex: (index) =>
      set((state) => ({
        viewer: {
          ...state.viewer,
          index: clamp(index, 0, Math.max(0, state.viewer.items.length - 1)),
        },
      })),

    setGalleryOpen: (open) => set({ galleryOpen: open }),
    setPaletteOpen: (open) => set({ paletteOpen: open }),
    setLibraryOpen: (open, targetId = null) =>
      set({ libraryOpen: open, libraryTargetId: targetId }),

    toast: (text, type = "info") => {
      const id = uid();
      set((state) => ({ toasts: [...state.toasts, { id, text, type }] }));
      setTimeout(() => get().dismissToast(id), 3200);
    },
    dismissToast: (id) =>
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

    bumpGallery: () => set((state) => ({ galleryVersion: state.galleryVersion + 1 })),

    syncGallery: async () => {
      const workspaces = get().workspaces;
      const refreshed: Record<string, ResultItem[]> = {};
      await Promise.all(
        workspaces.map(async (workspace) => {
          const records = await gallery.getAll(workspace.id, RESULTS_PER_WORKSPACE);
          refreshed[workspace.id] = records.map(recordToItem);
        }),
      );
      set((state) => ({ results: { ...state.results, ...refreshed } }));
      get().bumpGallery();
    },
  };
});

/** 批量打包下载（动态加载 jszip） */
export async function downloadResultsZip(items: ResultItem[], nameHint: string) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  let added = 0;
  for (const item of items) {
    let blob: Blob | null = null;
    if (item.hasBlob && item.objectUrl) {
      try {
        const response = await fetch(item.objectUrl);
        if (response.ok) blob = await response.blob();
      } catch {
        blob = null;
      }
    }
    if (!blob) continue;
    added += 1;
    zip.file(resultFileBase(item) + "." + extOfMime(blob.type), blob);
  }
  if (!added) throw new Error("没有可下载的图片数据");
  const content = await zip.generateAsync({ type: "blob" });
  downloadBlob(content, "lucen-" + safeFilePart(nameHint, "gallery", 28) + "-" + fileStamp() + ".zip");
  return added;
}
