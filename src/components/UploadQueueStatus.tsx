import { AlertTriangle, Check, CloudUpload, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { uploads, type UploadSummary } from "../lib/db";
import { useApp } from "../lib/store";

const EMPTY: UploadSummary = {
  counts: {},
  items: [],
  historical: { total: 0, succeeded: 0, blocked: 0 },
  worker: { running: false, enabled: true, lastError: "" },
};

export function UploadQueueStatus() {
  const [summary, setSummary] = useState<UploadSummary>(EMPTY);
  const [retrying, setRetrying] = useState(false);
  const toast = useApp((state) => state.toast);

  const load = useCallback(async () => {
    try {
      setSummary(await uploads.getSummary(40));
    } catch {
      // Queue visibility must not block image generation.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const active =
    (summary.counts.pending || 0) +
    (summary.counts.uploading || 0) +
    (summary.counts.retry_wait || 0);
  const blocked = summary.counts.blocked || 0;
  const failures = summary.items.filter((item) => item.status === "blocked" || item.status === "retry_wait").slice(0, 2);
  const historical = summary.historical;

  async function retry(id: string, variant?: "original" | "thumbnail") {
    setRetrying(true);
    try {
      await uploads.retry(id, variant);
      toast("已加入立即重试队列", "ok");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "重试失败", "err");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className="grid gap-2.5 border-t border-[var(--line)] pt-4" aria-label="Remit 图床队列">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px] font-semibold">
          {summary.worker.running ? (
            <LoaderCircle size={14} className="shrink-0 animate-spin text-[var(--accent-2)]" />
          ) : active > 0 ? (
            <CloudUpload size={14} className="shrink-0 text-[var(--accent-2)]" />
          ) : (
            <Check size={14} className="shrink-0 text-[var(--ok)]" />
          )}
          <span className="truncate">Remit 图床队列</span>
        </div>
        <button className="icon-btn btn !size-7 !min-h-7" onClick={() => void load()} data-tip="刷新队列">
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1.5 text-center text-[10.5px]">
        <span className="rounded-md bg-[var(--bg-soft)] px-1.5 py-1.5">处理中 {active}</span>
        <span className="rounded-md bg-[var(--bg-soft)] px-1.5 py-1.5">已完成 {summary.counts.succeeded || 0}</span>
        <span className="rounded-md bg-[var(--bg-soft)] px-1.5 py-1.5 text-[var(--warn)]">需处理 {blocked}</span>
      </div>
      {summary.breakdown && (
        <div className="text-[10.5px] text-[var(--muted)]">
          原图 {summary.breakdown.original.succeeded || 0} / {(summary.breakdown.original.pending || 0) + (summary.breakdown.original.uploading || 0) + (summary.breakdown.original.retry_wait || 0)} 待处理 · 缩略图 {summary.breakdown.thumbnail.succeeded || 0} / {(summary.breakdown.thumbnail.pending || 0) + (summary.breakdown.thumbnail.uploading || 0) + (summary.breakdown.thumbnail.retry_wait || 0)} 待处理
        </div>
      )}

      {historical.total > 0 && (
        <div className="grid gap-1 text-[10.5px] text-[var(--muted)]">
          <div className="flex justify-between gap-2">
            <span>历史迁移</span>
            <span>{historical.succeeded} / {historical.total}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-soft)]">
            <span
              className="block h-full rounded-full bg-[var(--accent-2)] transition-[width]"
              style={{ width: `${Math.min(100, (historical.succeeded / historical.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {failures.map((item) => (
        <div key={item.galleryId + ":" + (item.variant || "original")} className="flex items-start gap-2 text-[10.5px] text-[var(--muted)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--warn)]" />
          <span className="min-w-0 flex-1 break-words" title={item.lastError || ""}>
            {item.workspaceTitle || "历史图片"} · {item.variant === "thumbnail" ? "缩略图" : "原图"} · {item.status === "blocked" ? "需要处理" : "等待重试"}
          </span>
          <button
            className="shrink-0 text-[var(--accent-2)] hover:underline disabled:opacity-50"
            disabled={retrying}
            onClick={() => void retry(item.galleryId, item.variant)}
          >
            重试
          </button>
        </div>
      ))}
    </section>
  );
}
