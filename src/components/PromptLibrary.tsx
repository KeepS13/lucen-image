import { AnimatePresence, motion } from "motion/react";
import { CornerDownLeft, Pin, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { prompts } from "../lib/db";
import { dialogPop, overlayFade } from "../lib/motion";
import { useApp } from "../lib/store";
import type { PromptRecord } from "../lib/types";
import { formatDateTime, uid } from "../lib/utils";

type Tab = "fav" | "recent";

export function PromptLibrary() {
  const open = useApp((s) => s.libraryOpen);
  const targetId = useApp((s) => s.libraryTargetId);
  const focusedId = useApp((s) => s.focusedId);
  const version = useApp((s) => s.promptsVersion);
  const setLibraryOpen = useApp((s) => s.setLibraryOpen);
  const updateWorkspace = useApp((s) => s.updateWorkspace);
  const bumpPrompts = useApp((s) => s.bumpPrompts);
  const toast = useApp((s) => s.toast);

  const [tab, setTab] = useState<Tab>("fav");
  const [records, setRecords] = useState<PromptRecord[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const list = await prompts.getByKind(tab);
      list.sort((a, b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt);
      setRecords(list);
    })();
  }, [open, tab, version]);

  function usePrompt(record: PromptRecord) {
    const target = targetId || focusedId;
    if (!target) {
      toast("没有可用的窗口", "err");
      return;
    }
    updateWorkspace(target, { prompt: record.text });
    void prompts.update(record.id, { usedCount: record.usedCount + 1, updatedAt: Date.now() });
    setLibraryOpen(false);
    toast("Prompt 已填入窗口", "ok");
  }

  async function addDraft() {
    const text = draft.trim();
    if (!text) return;
    const now = Date.now();
    await prompts.add({
      id: uid(),
      kind: "fav",
      text,
      pinned: 0,
      usedCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    setDraft("");
    bumpPrompts();
  }

  async function togglePin(record: PromptRecord) {
    await prompts.update(record.id, { pinned: record.pinned ? 0 : 1 });
    bumpPrompts();
  }

  async function favRecent(record: PromptRecord) {
    const favs = await prompts.getByKind("fav");
    if (favs.some((p) => p.text === record.text)) {
      toast("已在收藏中", "info");
      return;
    }
    const now = Date.now();
    await prompts.add({
      id: uid(),
      kind: "fav",
      text: record.text,
      pinned: 0,
      usedCount: record.usedCount,
      createdAt: now,
      updatedAt: now,
    });
    bumpPrompts();
    toast("已收藏", "ok");
  }

  async function remove(record: PromptRecord) {
    await prompts.delete(record.id);
    bumpPrompts();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          variants={overlayFade}
          initial="hidden"
          animate="show"
          exit="exit"
          className="fixed inset-0 z-[65] bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLibraryOpen(false);
          }}
        >
          <motion.div
            variants={dialogPop}
            className="glass-strong mx-auto mt-[10vh] flex max-h-[74vh] w-[min(620px,94vw)] flex-col overflow-hidden rounded-3xl shadow-[0_30px_90px_-20px_rgba(0,0,0,.7)]"
          >
            <div className="flex items-center gap-3 border-b border-[var(--line)] p-4">
              <h2 className="font-display m-0 text-[16px] font-bold tracking-tight">Prompt 库</h2>
              <div className="flex gap-1 rounded-xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel-solid)_45%,transparent)] p-1">
                {(["fav", "recent"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    className="relative min-h-[28px] rounded-lg px-3 text-[12px] font-semibold transition-colors"
                    style={{ color: tab === key ? "#fff" : "var(--muted)" }}
                  >
                    {tab === key && (
                      <motion.span
                        layoutId="prompt-tab-pill"
                        transition={{ type: "spring", stiffness: 480, damping: 34 }}
                        className="absolute inset-0 rounded-lg bg-[var(--accent)]"
                      />
                    )}
                    <span className="relative z-10">{key === "fav" ? "收藏" : "最近使用"}</span>
                  </button>
                ))}
              </div>
              <span className="flex-1" />
              <button className="btn icon-btn" onClick={() => setLibraryOpen(false)}>
                <X size={16} />
              </button>
            </div>

            {tab === "fav" && (
              <div className="flex gap-2 border-b border-[var(--line)] p-3">
                <input
                  className="input !min-h-[38px]"
                  placeholder="输入新的 prompt 加入收藏…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addDraft();
                  }}
                />
                <button className="btn shrink-0" onClick={() => void addDraft()}>
                  <Plus size={14} /> 添加
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3">
              {records.length === 0 ? (
                <div className="px-4 py-10 text-center text-[12.5px] text-[var(--muted)]">
                  {tab === "fav" ? "还没有收藏的 prompt" : "还没有使用记录"}
                </div>
              ) : (
                <div className="grid gap-2">
                  <AnimatePresence initial={false}>
                    {records.map((record, index) => (
                      <motion.div
                        key={record.id}
                        layout
                        initial={{ opacity: 0, y: 14, scale: 0.98 }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          scale: 1,
                          transition: {
                            type: "spring",
                            stiffness: 360,
                            damping: 26,
                            delay: Math.min(index * 0.02, 0.2),
                          },
                        }}
                        exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.14 } }}
                        className="group rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel-solid)_50%,transparent)] p-3 transition-colors hover:border-[color-mix(in_oklab,var(--accent)_50%,var(--line))]"
                      >
                        <button
                          type="button"
                          className="block w-full cursor-pointer text-left text-[12.5px] leading-relaxed text-[var(--ink)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
                          onClick={() => usePrompt(record)}
                          title={record.text}
                        >
                          {record.pinned ? (
                            <Pin size={11} className="mr-1 inline text-[var(--warn)]" />
                          ) : null}
                          {record.text}
                        </button>
                        <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-[var(--muted)]">
                          <span>
                            用过 {record.usedCount} 次 · {formatDateTime(record.updatedAt)}
                          </span>
                          <span className="flex-1" />
                          <RowIcon tip="填入窗口" onClick={() => usePrompt(record)}>
                            <CornerDownLeft size={12} />
                          </RowIcon>
                          {tab === "fav" ? (
                            <RowIcon
                              tip={record.pinned ? "取消置顶" : "置顶"}
                              onClick={() => void togglePin(record)}
                            >
                              <Pin
                                size={12}
                                className={record.pinned ? "text-[var(--warn)]" : ""}
                              />
                            </RowIcon>
                          ) : (
                            <RowIcon tip="收藏" onClick={() => void favRecent(record)}>
                              <Star size={12} />
                            </RowIcon>
                          )}
                          <RowIcon tip="删除" danger onClick={() => void remove(record)}>
                            <Trash2 size={12} />
                          </RowIcon>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function RowIcon({
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
        "grid size-6.5 min-h-[26px] min-w-[26px] place-items-center rounded-lg text-[var(--muted)] opacity-0 transition-all duration-200 hover:scale-110 group-hover:opacity-100 " +
        (danger ? "hover:text-[var(--err)]" : "hover:text-[var(--ink)]")
      }
    >
      {children}
    </button>
  );
}
