import { AnimatePresence, motion } from "motion/react";
import {
  Archive,
  CheckSquare,
  Copy,
  Download,
  Heart,
  Link2,
  Recycle,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { gallery, type GalleryRecord } from "../lib/db";
import { overlayFade } from "../lib/motion";
import { downloadResultsZip, useApp } from "../lib/store";
import type { ResultItem } from "../lib/types";
import {
  copyTextToClipboard,
  downloadBlob,
  downloadUrl,
  extOfMime,
  formatDateTime,
  resultFileBase,
} from "../lib/utils";

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "fav", label: "♥ 收藏" },
  { key: "text", label: "文生图" },
  { key: "edit", label: "二创" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const GALLERY_PAGE_SIZE = 32;

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
    mode: record.mode as any,
    objectUrl,
    url: record.url,
    remoteUrl: record.remoteUrl,
    thumbnailUrl: record.thumbnailUrl,
    thumbnailObjectUrl,
    thumbnailReady: Boolean(record.thumbnailReady),
    thumbnailMime: record.thumbnailMime,
    thumbnailSha256: record.thumbnailSha256,
    thumbnailStatus: record.thumbnailStatus,
    thumbnailAttempts: record.thumbnailAttempts,
    thumbnailNextRetryAt: record.thumbnailNextRetryAt,
    thumbnailLastUploadError: record.thumbnailLastUploadError,
    thumbnailUploadedAt: record.thumbnailUploadedAt,
    thumbnailByteSize: record.thumbnailByteSize,
    mime: record.mime,
    uploadStatus: record.uploadStatus,
    uploadAttempts: record.uploadAttempts,
    nextRetryAt: record.nextRetryAt,
    lastUploadError: record.lastUploadError,
    uploadedAt: record.uploadedAt,
    hasBlob: Boolean(record.filename || record.remoteUrl),
    sourceDataUrl: record.sourceDataUrl,
    favorite: record.favorite === 1,
    createdAt: record.createdAt,
  };
}

async function getResultBlob(item: ResultItem): Promise<Blob | null> {
  try {
    if (item.hasBlob && item.objectUrl) {
      const response = await fetch(item.objectUrl);
      if (response.ok) return await response.blob();
    }
  } catch {
    // Fall back to the remote URL below.
  }
  const fallbackUrl = item.remoteUrl || item.url;
  if (!fallbackUrl) return null;
  try {
    const response = await fetch(fallbackUrl);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

function GalleryActionButton({
  tip,
  children,
  onClick,
}: {
  tip: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={tip}
      data-gallery-tip={tip}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="gallery-action-button grid size-7 place-items-center rounded-full bg-black/60 text-white/90 shadow-lg backdrop-blur transition-all hover:scale-110 hover:bg-white/20"
    >
      {children}
    </button>
  );
}

export function GalleryDrawer() {
  const open = useApp((s) => s.galleryOpen);
  const setOpen = useApp((s) => s.setGalleryOpen);
  const version = useApp((s) => s.galleryVersion);
  const openViewer = useApp((s) => s.openViewer);
  const toggleFavorite = useApp((s) => s.toggleFavorite);
  const deleteResult = useApp((s) => s.deleteResult);
  const resultToNewWorkspace = useApp((s) => s.resultToNewWorkspace);
  const toast = useApp((s) => s.toast);

  const [items, setItems] = useState<ResultItem[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadPage = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const page = await gallery.getPage({
          limit: GALLERY_PAGE_SIZE,
          offset,
          filter,
          query: debouncedQuery,
        });
        const nextItems = page.items.map(recordToItem);
        setItems((current) => (offset === 0 ? nextItems : [...current, ...nextItems]));
        setLoadedCount(offset + nextItems.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        toast("鐢诲粖鍔犺浇澶辫触", "err");
      } finally {
        setLoading(false);
      }
    },
    [debouncedQuery, filter, toast],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 260);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setLoadedCount(0);
    setTotal(0);
    setHasMore(true);
    setSelected(new Set());
    scrollRef.current?.scrollTo({ top: 0 });
    void loadPage(0);
  }, [debouncedQuery, filter, open, version]);

  useEffect(() => {
    if (!open || !hasMore || loading) return;
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadPage(loadedCount);
      },
      { root, rootMargin: "360px 0px", threshold: 0.01 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadedCount, loading, loadPage, open]);

  useEffect(() => {
    if (!open) {
      setSelectMode(false);
      setSelected(new Set());
    }
  }, [open]);

  const filtered = items;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedItems = filtered.filter((item) => selected.has(item.id));

  async function batchZip() {
    if (!selectedItems.length) return;
    try {
      const count = await downloadResultsZip(selectedItems, "gallery");
      toast("已打包 " + count + " 张图片", "ok");
    } catch (error) {
      toast(error instanceof Error ? error.message : "打包失败", "err");
    }
  }

  async function batchDelete() {
    if (!selectedItems.length) return;
    for (const item of selectedItems) await deleteResult(item);
    setSelected(new Set());
    toast("已删除 " + selectedItems.length + " 张", "ok");
  }

  async function downloadOne(item: ResultItem) {
    const filename = resultFileBase(item);
    const blob = await getResultBlob(item);
    if (blob) {
      downloadBlob(blob, filename + "." + extOfMime(blob.type));
      toast("已开始下载", "ok");
    } else if (item.remoteUrl || item.url) {
      downloadUrl(item.remoteUrl || item.url || "", filename + "." + extOfMime(item.mime || "image/png"));
      toast("已打开下载链接", "info");
    } else {
      toast("没有可下载的数据", "err");
    }
  }

  async function editInNewWorkspace(item: ResultItem) {
    await resultToNewWorkspace(item);
    setOpen(false);
  }

  async function copyOriginalPrompt(item: ResultItem) {
    const prompt = item.prompt.trim();
    if (!prompt) {
      toast("没有可复制的提示词", "err");
      return;
    }
    try {
      await copyTextToClipboard(prompt);
      toast("已复制提示词", "ok");
    } catch {
      toast("复制失败", "err");
    }
  }

  async function copyRemoteLink(item: ResultItem) {
    if (!item.remoteUrl) return;
    try {
      await copyTextToClipboard(item.remoteUrl);
      toast("Remit 直链已复制", "ok");
    } catch {
      toast("复制失败", "err");
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          variants={overlayFade}
          initial="hidden"
          animate="show"
          exit="exit"
          className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0, transition: { type: "spring", stiffness: 300, damping: 30 } }}
            exit={{ x: "100%", transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
            className="glass-strong absolute inset-y-0 right-0 flex w-[min(900px,96vw)] flex-col rounded-l-3xl"
          >
            {/* 头部 */}
            <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] p-4">
              <h2 className="font-display m-0 mr-1 text-[16px] font-bold tracking-tight">
                画廊
                <span className="ml-2 text-[12px] font-normal text-[var(--muted)]">
                  {items.length} / {total}
                </span>
              </h2>
              <div className="relative min-w-[160px] flex-1">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
                />
                <input
                  className="input !min-h-[36px] !pl-9"
                  placeholder="搜索 prompt / 窗口名…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="flex gap-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key)}
                    className="chip cursor-pointer transition-all duration-200"
                    style={
                      filter === f.key
                        ? {
                            borderColor: "var(--accent)",
                            color: "var(--ink)",
                            background:
                              "color-mix(in oklab, var(--accent) 18%, transparent)",
                          }
                        : undefined
                    }
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <button
                className="btn !min-h-[34px] text-[12px]"
                onClick={() => {
                  setSelectMode((v) => !v);
                  setSelected(new Set());
                }}
              >
                {selectMode ? <CheckSquare size={14} /> : <Square size={14} />}
                {selectMode ? "退出多选" : "多选"}
              </button>
              <button className="btn icon-btn" onClick={() => setOpen(false)} data-tip="关闭">
                <X size={16} />
              </button>
            </div>

            {/* 批量操作条 */}
            <AnimatePresence>
              {selectMode && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  className="overflow-hidden border-b border-[var(--line)]"
                >
                  <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[12px]">
                    <span className="text-[var(--muted)]">已选 {selected.size} 张</span>
                    <button
                      className="btn !min-h-[32px] text-[12px]"
                      onClick={() =>
                        setSelected(
                          selected.size === filtered.length
                            ? new Set()
                            : new Set(filtered.map((i) => i.id)),
                        )
                      }
                    >
                      {selected.size === filtered.length ? "取消全选" : "全选"}
                    </button>
                    <button
                      className="btn !min-h-[32px] text-[12px]"
                      disabled={!selected.size}
                      onClick={() => void batchZip()}
                    >
                      <Archive size={13} /> 打包下载
                    </button>
                    <button
                      className="btn btn-danger !min-h-[32px] text-[12px]"
                      disabled={!selected.size}
                      onClick={() => void batchDelete()}
                    >
                      <Trash2 size={13} /> 删除所选
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 时间顺序网格 */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
              {filtered.length === 0 && !loading ? (
                <div className="grid h-full place-items-center text-[13px] text-[var(--muted)]">
                  {items.length === 0 ? "还没有生成过图片" : "没有匹配的结果"}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 items-start gap-3 md:grid-cols-4">
                    {filtered.map((item, index) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 22, scale: 0.95 }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        scale: 1,
                        transition: {
                          type: "spring",
                          stiffness: 320,
                          damping: 24,
                          delay: Math.min(index * 0.025, 0.5),
                        },
                      }}
                      className="group relative overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel-solid)]"
                    >
                      <button
                        type="button"
                        className="block w-full cursor-zoom-in"
                        onClick={() => {
                          if (selectMode) toggleSelect(item.id);
                          else openViewer(filtered, index);
                        }}
                      >
                        {item.thumbnailObjectUrl ? (
                          <img
                            src={item.thumbnailObjectUrl}
                            alt={item.prompt}
                            loading="lazy"
                            className="block aspect-square w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
                          />
                        ) : (
                          <div className="grid aspect-square w-full place-items-center bg-[var(--bg-soft)] text-[10px] text-[var(--muted)]">
                            缩略图排队
                          </div>
                        )}
                      </button>

                      {selectMode && (
                        <button
                          type="button"
                          onClick={() => toggleSelect(item.id)}
                          className={
                            "absolute left-2 top-2 grid size-6 place-items-center rounded-md border-2 transition-all " +
                            (selected.has(item.id)
                              ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                              : "border-white/70 bg-black/40 text-transparent")
                          }
                        >
                          ✓
                        </button>
                      )}

                      {!selectMode && (
                        <span className="chip pointer-events-none absolute left-2 top-2 !border-transparent !bg-black/60 !text-white/90">
                          {item.thumbnailStatus && item.thumbnailStatus !== "succeeded"
                            ? ({ pending: "缩略图排队", uploading: "缩略图上传中", retry_wait: "缩略图等待重试", blocked: "缩略图受阻", canceled: "缩略图已取消" } as Record<string, string>)[item.thumbnailStatus] || "缩略图排队"
                            : item.uploadStatus === "succeeded"
                            ? "图床"
                            : item.uploadStatus === "uploading"
                              ? "上传中"
                              : item.uploadStatus === "retry_wait"
                                ? "等待重试"
                                : item.uploadStatus === "blocked"
                                  ? "需处理"
                                  : "排队"}
                        </span>
                      )}

                      <div
                        className="absolute right-2 top-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 data-[fav=true]:opacity-100"
                        data-fav={item.favorite}
                      >
                        <GalleryActionButton tip="二创" onClick={() => void editInNewWorkspace(item)}>
                          <Recycle size={13} />
                        </GalleryActionButton>
                        <GalleryActionButton tip="复制提示词" onClick={() => void copyOriginalPrompt(item)}>
                          <Copy size={13} />
                        </GalleryActionButton>
                        {item.remoteUrl && (
                          <GalleryActionButton tip="复制 Remit 直链" onClick={() => void copyRemoteLink(item)}>
                            <Link2 size={13} />
                          </GalleryActionButton>
                        )}
                        <GalleryActionButton tip="下载" onClick={() => void downloadOne(item)}>
                          <Download size={13} />
                        </GalleryActionButton>
                        <GalleryActionButton
                          tip={item.favorite ? "取消收藏" : "收藏"}
                          onClick={() => void toggleFavorite(item)}
                        >
                          <Heart
                            size={13}
                            className={
                              item.favorite ? "fill-[var(--accent-3)] text-[var(--accent-3)]" : ""
                            }
                          />
                        </GalleryActionButton>
                      </div>

                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2.5 pt-6 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                        <div className="truncate text-[11px] text-white/90">{item.prompt}</div>
                        <div className="mt-0.5 text-[10px] text-white/60">
                          {item.workspaceTitle} · {formatDateTime(item.createdAt)}
                        </div>
                      </div>
                    </motion.div>
                    ))}
                  </div>
                  <div
                    ref={sentinelRef}
                    className="grid min-h-12 place-items-center py-3 text-[12px] text-[var(--muted)]"
                  >
                    {loading ? "加载中..." : hasMore ? "继续滚动加载更多" : items.length ? "已加载全部" : ""}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
