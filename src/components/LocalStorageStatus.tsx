import { HardDrive, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { storage, type StorageStatus } from "../lib/db";
import { useApp } from "../lib/store";
import { formatDateTime } from "../lib/utils";

const MIN_DAYS = 1;
const MAX_DAYS = 3650;

export function LocalStorageStatus() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [days, setDays] = useState("30");
  const [saving, setSaving] = useState(false);
  const toast = useApp((state) => state.toast);

  const load = useCallback(async () => {
    try {
      const next = await storage.getStatus();
      setStatus(next);
      setDays(String(next.retentionDays));
    } catch {
      // The workbench remains usable when the status card cannot refresh.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function save() {
    const value = Number(days);
    if (!Number.isInteger(value) || value < MIN_DAYS || value > MAX_DAYS) {
      toast("保留天数必须是 1–3650 的整数", "err");
      return;
    }
    if (status && value < status.retentionDays) {
      const confirmed = window.confirm(
        "缩短保留期限会立即永久删除已超过新期限的本地图片和输入图，且无法恢复。继续吗？",
      );
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const result = await storage.updateRetentionDays(value);
      setStatus(result);
      setDays(String(result.retentionDays));
      if (result.failures.length) {
        toast("设置已保存，但有 " + result.failures.length + " 项文件清理失败，将稍后重试", "err");
      } else {
        toast("保留期限已更新" + (result.deleted ? "，已清理 " + result.deleted + " 项" : ""), "ok");
      }
      useApp.getState().bumpGallery();
      useApp.getState().syncGallery().catch(() => undefined);
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败", "err");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-2.5 border-t border-[var(--line)] pt-4" role="region" aria-label="本地存储">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px] font-semibold">
          <HardDrive size={14} className="shrink-0 text-[var(--accent-2)]" />
          <span className="truncate">本地存储</span>
        </div>
        <button
          type="button"
          className="icon-btn btn !size-7 !min-h-7"
          onClick={() => void load()}
          data-tip="刷新本地存储状态"
          data-tip-align="end"
          aria-label="刷新本地存储状态"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5 text-center text-[10.5px]">
        <span className="rounded-md bg-[var(--bg-soft)] px-1.5 py-1.5">图片 {status?.galleryCount ?? "—"}</span>
        <span className="rounded-md bg-[var(--bg-soft)] px-1.5 py-1.5">输入图 {status?.inputCount ?? "—"}</span>
      </div>

      <div className="grid gap-1.5">
        <label className="field-label" htmlFor="storage-retention-days">保留天数</label>
        <div className="flex items-center gap-1.5">
          <input
            id="storage-retention-days"
            className="input !min-h-[34px] min-w-0 flex-1 tabular-nums"
            type="number"
            inputMode="numeric"
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
          <button
            type="button"
            className="btn !min-h-[34px] shrink-0 text-[11px]"
            disabled={saving || !status || days === String(status.retentionDays)}
            onClick={() => void save()}
          >
            {saving ? "保存中" : "保存"}
          </button>
        </div>
        <div className="text-[10.5px] leading-relaxed text-[var(--muted)]">
          1–3650 天，收藏图片永久保留；二创输入图也按此期限清理。
        </div>
      </div>

      <div className="grid gap-1 text-[10.5px] leading-relaxed text-[var(--muted)]">
        <div className="flex justify-between gap-2">
          <span>最近清理</span>
          <span>{status?.lastCleanupAt ? formatDateTime(status.lastCleanupAt) : "尚未运行"}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>下次清理</span>
          <span>{status?.nextCleanupAt ? formatDateTime(status.nextCleanupAt) : "—"}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>上次删除</span>
          <span>{status?.lastDeletedCount ?? 0} 项</span>
        </div>
        {status?.lastError && (
          <div className="break-words text-[var(--err)]">上次错误：{status.lastError}</div>
        )}
      </div>
    </section>
  );
}
