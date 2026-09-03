import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Heart,
  Recycle,
  Trash2,
  Type,
} from "lucide-react";
import { useRef, type PointerEvent } from "react";
import { resultIn } from "../lib/motion";
import { useApp } from "../lib/store";
import type { ResultItem } from "../lib/types";
import {
  copyTextToClipboard,
  downloadBlob,
  downloadUrl,
  extOfMime,
  formatClock,
  resultFileBase,
} from "../lib/utils";
import { useFlash } from "./ui";

async function getBlob(item: ResultItem): Promise<Blob | null> {
  try {
    if (!item.hasBlob || !item.objectUrl) throw new Error("no image content");
    const response = await fetch(item.objectUrl);
    if (response.ok) return await response.blob();
  } catch {
    // Fall back to the remote URL below when the local cache is unavailable.
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

export function ResultCard({
  item,
  index,
  onView,
}: {
  item: ResultItem;
  index: number;
  onView: () => void;
}) {
  const reduced = useReducedMotion();
  const toast = useApp((s) => s.toast);
  const toggleFavorite = useApp((s) => s.toggleFavorite);
  const deleteResult = useApp((s) => s.deleteResult);
  const useResultAsInput = useApp((s) => s.useResultAsInput);
  const resultToNewWorkspace = useApp((s) => s.resultToNewWorkspace);
  const [copied, flashCopied] = useFlash();

  const ref = useRef<HTMLDivElement>(null);
  const rx = useSpring(useMotionValue(0), { stiffness: 220, damping: 16 });
  const ry = useSpring(useMotionValue(0), { stiffness: 220, damping: 16 });

  function onMove(event: PointerEvent<HTMLDivElement>) {
    if (reduced || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    ry.set((px - 0.5) * 14);
    rx.set((0.5 - py) * 14);
    ref.current.style.setProperty("--glare-x", `${px * 100}%`);
    ref.current.style.setProperty("--glare-y", `${py * 100}%`);
  }

  function onLeave() {
    rx.set(0);
    ry.set(0);
  }

  async function handleDownload() {
    const blob = await getBlob(item);
    const filename = resultFileBase(item);
    if (blob) {
      downloadBlob(blob, filename + "." + extOfMime(blob.type));
    } else if (item.remoteUrl || item.url) {
      downloadUrl(item.remoteUrl || item.url || "", filename + "." + extOfMime(item.mime || "image/png"));
    } else {
      toast("没有可下载的数据", "err");
    }
  }

  async function handleCopyPrompt() {
    try {
      await copyTextToClipboard(item.revisedPrompt || item.prompt);
      toast("Prompt 已复制", "ok");
    } catch {
      toast("复制失败", "err");
    }
  }

  async function handleCopyLink() {
    if (!item.remoteUrl) {
      toast("原图仍在上传，完成后才能复制链接", "info");
      return;
    }
    try {
      await copyTextToClipboard(item.remoteUrl);
      flashCopied();
      toast("Remit 直链已复制", "ok");
    } catch {
      toast("复制失败", "err");
    }
  }

  const uploadLabel = item.thumbnailStatus && item.thumbnailStatus !== "succeeded"
    ? ({ pending: "缩略图排队", uploading: "缩略图上传中", retry_wait: "缩略图等待重试", blocked: "缩略图受阻", canceled: "缩略图已取消" } as Record<string, string>)[item.thumbnailStatus] || "缩略图排队"
    : item.uploadStatus === "succeeded"
      ? "图床"
      : item.uploadStatus === "uploading"
        ? "上传中"
        : item.uploadStatus === "retry_wait"
          ? "等待重试"
          : item.uploadStatus === "blocked"
            ? "需处理"
            : "排队";

  return (
    <motion.div
      variants={resultIn}
      exit="exit"
      layout
      style={{ perspective: 900 }}
      className="group relative"
    >
      <motion.div
        ref={ref}
        style={{ rotateX: rx, rotateY: ry, transformStyle: "preserve-3d" }}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        className="neon-border relative overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel-solid)] shadow-[0_8px_30px_-12px_rgba(0,0,0,.5)]"
      >
        <button
          type="button"
          className="block w-full cursor-zoom-in"
          onClick={onView}
          data-tip="点击查看大图"
        >
          {item.thumbnailObjectUrl ? (
            <img
              src={item.thumbnailObjectUrl}
              alt={item.revisedPrompt || item.prompt || "生成图片"}
              loading="lazy"
              className="block aspect-square w-full bg-[var(--bg-soft)] object-cover"
            />
          ) : (
            <div className="grid aspect-square w-full place-items-center bg-[var(--bg-soft)] text-[10px] text-[var(--muted)]">
              缩略图排队
            </div>
          )}
        </button>
        <div className="result-glare group-hover:opacity-100" />

        {/* 角标 */}
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1.5">
          <span className="chip !border-transparent !bg-black/55 !text-white/90 backdrop-blur">
            #{index + 1}
          </span>
          {item.mode === "edit" && (
            <span className="chip !border-transparent !bg-black/55 !text-[var(--accent-2)] backdrop-blur">
              二创
            </span>
          )}
          <span className="chip !border-transparent !bg-black/55 !text-white/90 backdrop-blur">
            {uploadLabel}
          </span>
        </div>

        {/* 收藏 */}
        <button
          type="button"
          onClick={() => void toggleFavorite(item)}
          data-tip={item.favorite ? "取消收藏" : "收藏"}
          className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-black/55 text-white/85 opacity-0 backdrop-blur transition-all duration-300 hover:scale-110 group-hover:opacity-100 data-[fav=true]:opacity-100"
          data-fav={item.favorite}
        >
          <Heart
            size={14}
            className={item.favorite ? "fill-[var(--accent-3)] text-[var(--accent-3)]" : ""}
          />
        </button>

        {/* 悬浮操作栏 */}
        <div className="absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/85 via-black/55 to-transparent p-2 pt-7 opacity-0 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-y-0 group-hover:opacity-100">
          <div className="mb-1.5 truncate text-[10.5px] text-white/70">
            {formatClock(item.createdAt)} · {item.model}
          </div>
          <div className="flex items-center gap-1">
            <ActionIcon tip="下载" onClick={() => void handleDownload()}>
              <Download size={13} />
            </ActionIcon>
            <ActionIcon tip="复制图片链接" onClick={() => void handleCopyLink()}>
              {copied ? <Check size={13} className="text-[var(--ok)]" /> : <Copy size={13} />}
            </ActionIcon>
            <ActionIcon tip="复制 Prompt" onClick={() => void handleCopyPrompt()}>
              <Type size={13} />
            </ActionIcon>
            <ActionIcon
              tip="设为本窗口二创输入"
              onClick={() => void useResultAsInput(item.workspaceId, item)}
            >
              <Recycle size={13} />
            </ActionIcon>
            <ActionIcon tip="开新窗口二创" onClick={() => void resultToNewWorkspace(item)}>
              <ExternalLink size={13} />
            </ActionIcon>
            <span className="flex-1" />
            <ActionIcon tip="删除（含画廊）" onClick={() => void deleteResult(item)} danger>
              <Trash2 size={13} />
            </ActionIcon>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ActionIcon({
  children,
  tip,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  tip: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      data-tip={tip}
      onClick={onClick}
      className={
        "grid size-7.5 min-h-[30px] min-w-[30px] place-items-center rounded-lg text-white/85 transition-all duration-200 hover:scale-110 " +
        (danger ? "hover:bg-[var(--err)]/30 hover:text-[var(--err)]" : "hover:bg-white/20")
      }
    >
      {children}
    </button>
  );
}
