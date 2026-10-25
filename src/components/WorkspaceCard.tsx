import { AnimatePresence, motion } from "motion/react";
import {
  Archive,
  BookMarked,
  ChevronDown,
  CopyPlus,
  Eraser,
  ImagePlus,
  Settings2,
  Square,
  Star,
  X,
  Zap,
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { popIn, springSnappy, staggerContainer } from "../lib/motion";
import {
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_MODEL,
  MODEL_IDS,
} from "../lib/models";
import { downloadResultsZip, SIZE_OPTIONS, useApp } from "../lib/store";
import type { GeminiAspectRatio, GeminiImageSize, Workspace } from "../lib/types";
import { ElapsedTimer, MagneticButton, OrbitSpinner, ProgressRing } from "./ui";
import { ResultCard } from "./ResultCard";

const MESSAGE_COLOR: Record<string, string> = {
  idle: "var(--muted)",
  run: "var(--accent-2)",
  ok: "var(--ok)",
  err: "var(--err)",
};

export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const run = useApp((s) => s.runs[workspace.id]);
  const results = useApp((s) => s.results[workspace.id]) || [];
  const inputBlobs = useApp((s) => s.inputBlobs);
  const focused = useApp((s) => s.focusedId === workspace.id);

  const updateWorkspace = useApp((s) => s.updateWorkspace);
  const duplicateWorkspace = useApp((s) => s.duplicateWorkspace);
  const removeWorkspace = useApp((s) => s.removeWorkspace);
  const clearResults = useApp((s) => s.clearResults);
  const focusWorkspace = useApp((s) => s.focusWorkspace);
  const addInputFiles = useApp((s) => s.addInputFiles);
  const removeInput = useApp((s) => s.removeInput);
  const runWorkspace = useApp((s) => s.runWorkspace);
  const cancelRun = useApp((s) => s.cancelRun);
  const openViewer = useApp((s) => s.openViewer);
  const savePromptFav = useApp((s) => s.savePromptFav);
  const setLibraryOpen = useApp((s) => s.setLibraryOpen);
  const toast = useApp((s) => s.toast);

  const fileRef = useRef<HTMLInputElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const busy = Boolean(run?.busy);
  const isGemini = workspace.model === GEMINI_MODEL;

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDropActive(false);
    if (isGemini) {
      toast("Gemini 仅支持文生图，请先切换到 GPT Image 2", "err");
      return;
    }
    const files = Array.from(event.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length) {
      void addInputFiles(workspace.id, files);
      toast("已添加 " + files.length + " 张输入图", "ok");
    }
  }

  async function onZip() {
    if (!results.length) return;
    try {
      const count = await downloadResultsZip(results, workspace.title);
      toast("已打包 " + count + " 张图片", "ok");
    } catch (error) {
      toast(error instanceof Error ? error.message : "打包失败", "err");
    }
  }

  return (
    <motion.article
      layout
      variants={popIn}
      exit="exit"
      transition={springSnappy}
      data-ws={workspace.id}
      onPointerDownCapture={() => focusWorkspace(workspace.id)}
      onDragOver={(e) => {
        if (isGemini) return;
        e.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
      className={
        "glass neon-border relative flex min-w-0 flex-col rounded-3xl transition-shadow duration-500 " +
        (focused ? "shadow-[0_0_44px_-12px_var(--glow)]" : "shadow-[0_14px_44px_-20px_rgba(0,0,0,.6)]") +
        (dropActive ? " drop-active" : "")
      }
    >
      {/* 头部 */}
      <header className="flex items-center gap-2 px-5 pb-0 pt-4">
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
          onClick={() => updateWorkspace(workspace.id, { collapsed: !workspace.collapsed })}
          data-tip={workspace.collapsed ? "展开" : "折叠"}
        >
          <motion.span
            animate={{ rotate: workspace.collapsed ? -90 : 0 }}
            transition={springSnappy}
            className="grid place-items-center"
          >
            <ChevronDown size={15} />
          </motion.span>
        </button>
        <input
          className="font-display min-w-0 flex-1 border-none bg-transparent text-[15.5px] font-bold tracking-tight text-[var(--ink)] outline-none"
          value={workspace.title}
          onChange={(e) => updateWorkspace(workspace.id, { title: e.target.value })}
          aria-label="窗口名称"
        />
        <div className="flex shrink-0 items-center gap-1">
          <HeadIcon tip="复制窗口" onClick={() => duplicateWorkspace(workspace.id)}>
            <CopyPlus size={14} />
          </HeadIcon>
          <HeadIcon tip="打包下载本窗结果" onClick={() => void onZip()} disabled={!results.length}>
            <Archive size={14} />
          </HeadIcon>
          <HeadIcon tip="清空卡片结果" onClick={() => clearResults(workspace.id)}>
            <Eraser size={14} />
          </HeadIcon>
          <HeadIcon tip="关闭窗口" danger onClick={() => void removeWorkspace(workspace.id)}>
            <X size={15} />
          </HeadIcon>
        </div>
      </header>

      {busy && <div className="energy-bar mx-5 mt-2.5" />}

      {/* 主体（可折叠） */}
      <AnimatePresence initial={false}>
        {!workspace.collapsed && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="overflow-hidden"
          >
            <div className="grid gap-4 p-5">
              {/* 模式切换 */}
              <div className="grid grid-cols-2 gap-1 rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel-solid)_45%,transparent)] p-1">
                {(["text", "edit"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updateWorkspace(workspace.id, { mode })}
                    disabled={isGemini && mode === "edit"}
                    data-tip={isGemini && mode === "edit" ? "Gemini 仅支持文生图" : undefined}
                    className="relative min-h-[36px] rounded-xl text-[13px] font-semibold transition-colors duration-300"
                    style={{
                      color:
                        isGemini && mode === "edit"
                          ? "color-mix(in oklab, var(--muted) 45%, transparent)"
                          : workspace.mode === mode
                            ? "#fff"
                            : "var(--muted)",
                    }}
                  >
                    {workspace.mode === mode && (
                      <motion.span
                        layoutId={"mode-pill-" + workspace.id}
                        transition={{ type: "spring", stiffness: 480, damping: 34 }}
                        className="absolute inset-0 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] shadow-[0_2px_14px_-2px_var(--glow)]"
                      />
                    )}
                    <span className="relative z-10">
                      {mode === "text" ? "文生图" : "图生图"}
                    </span>
                  </button>
                ))}
              </div>

              {/* Prompt */}
              <label className="field-label relative">
                <span className="flex items-center justify-between">
                  PROMPT
                  <span className="relative z-10 flex gap-1">
                    <button
                      type="button"
                      className="grid size-6 place-items-center rounded-md text-[var(--muted)] transition-colors hover:text-[var(--warn)]"
                      data-tip="收藏此 Prompt"
                      onClick={() => void savePromptFav(workspace.prompt)}
                    >
                      <Star size={13} />
                    </button>
                    <button
                      type="button"
                      className="grid size-6 place-items-center rounded-md text-[var(--muted)] transition-colors hover:text-[var(--accent-2)]"
                      data-tip="从 Prompt 库选择"
                      onClick={() => setLibraryOpen(true, workspace.id)}
                    >
                      <BookMarked size={13} />
                    </button>
                  </span>
                </span>
                <textarea
                  className="input"
                  spellCheck={false}
                  placeholder="描述要生成或调整的画面…  (Ctrl+Enter 生成)"
                  value={workspace.prompt}
                  onChange={(e) => updateWorkspace(workspace.id, { prompt: e.target.value })}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      e.preventDefault();
                      void runWorkspace(workspace.id);
                    }
                  }}
                />
              </label>

              {/* 图生图输入区 */}
              <AnimatePresence initial={false}>
                {workspace.mode === "edit" && (
                  <motion.div
                    key="inputs"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 320, damping: 30 }}
                    className="overflow-hidden"
                  >
                    <div className="rounded-2xl border-2 border-dashed border-[var(--line-strong)] bg-[color-mix(in_oklab,var(--panel-solid)_35%,transparent)] p-3">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <AnimatePresence>
                          {workspace.inputs.map((meta) => {
                            const entry = inputBlobs[meta.id];
                            return (
                              <motion.div
                                key={meta.id}
                                layout
                                initial={{ scale: 0.6, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.6, opacity: 0 }}
                                transition={{ type: "spring", stiffness: 380, damping: 22 }}
                                className="group/thumb relative"
                              >
                                <img
                                  src={entry?.dataUrl}
                                  alt={meta.name}
                                  className="size-[68px] cursor-zoom-in rounded-xl border border-[var(--line-strong)] object-cover"
                                  onClick={() =>
                                    entry &&
                                    openViewer(
                                      [
                                        {
                                          id: meta.id,
                                          workspaceId: workspace.id,
                                          workspaceTitle: workspace.title,
                                          prompt: meta.name,
                                          revisedPrompt: "",
                                          model: "",
                                          size: "",
                                          mode: "edit",
                                          objectUrl: entry.dataUrl,
                                          hasBlob: false,
                                          expiresAt: null,
                                          favorite: false,
                                          createdAt: Date.now(),
                                        },
                                      ],
                                      0,
                                    )
                                  }
                                />
                                <button
                                  type="button"
                                  onClick={() => removeInput(workspace.id, meta.id)}
                                  className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-[var(--err)] text-white opacity-0 shadow transition-opacity group-hover/thumb:opacity-100"
                                  data-tip="移除"
                                >
                                  <X size={11} />
                                </button>
                              </motion.div>
                            );
                          })}
                        </AnimatePresence>
                        <button
                          type="button"
                          onClick={() => fileRef.current?.click()}
                          className="grid size-[68px] place-items-center rounded-xl border-2 border-dashed border-[var(--line-strong)] text-[var(--muted)] transition-all duration-300 hover:scale-105 hover:border-[var(--accent)] hover:text-[var(--accent)]"
                          data-tip="选择图片"
                        >
                          <ImagePlus size={20} />
                        </button>
                        <div className="min-w-[120px] flex-1 text-[11px] leading-relaxed text-[var(--muted)]">
                          拖拽 / 粘贴 <span className="kbd">Ctrl V</span> / 点击添加
                          <br />
                          支持多图（最多 6 张）
                        </div>
                      </div>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        onChange={(e) => {
                          const files = Array.from(e.target.files || []);
                          if (files.length) void addInputFiles(workspace.id, files);
                          e.target.value = "";
                        }}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <label className="field-label">
                模型
                <select
                  className="input"
                  value={workspace.model}
                  onChange={(e) => updateWorkspace(workspace.id, { model: e.target.value })}
                >
                  {MODEL_IDS.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>

              {/* 模型参数 */}
              {isGemini ? (
                <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                  <label className="field-label">
                    宽高比
                    <select
                      className="input"
                      value={workspace.aspectRatio}
                      onChange={(e) =>
                        updateWorkspace(workspace.id, {
                          aspectRatio: e.target.value as GeminiAspectRatio,
                        })
                      }
                    >
                      {GEMINI_ASPECT_RATIOS.map((ratio) => (
                        <option key={ratio} value={ratio}>
                          {ratio}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label">
                    分辨率
                    <select
                      className="input"
                      value={workspace.imageSize}
                      onChange={(e) =>
                        updateWorkspace(workspace.id, {
                          imageSize: e.target.value as GeminiImageSize,
                        })
                      }
                    >
                      {GEMINI_IMAGE_SIZES.map((imageSize) => (
                        <option key={imageSize} value={imageSize}>
                          {imageSize}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : (
              <div className="grid grid-cols-[1.2fr_1fr] gap-3 max-sm:grid-cols-1">
                <label className="field-label">
                  尺寸
                  <select
                    className="input"
                    value={workspace.size}
                    onChange={(e) => updateWorkspace(workspace.id, { size: e.target.value })}
                  >
                    {SIZE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}（{opt.ratio}）
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field-label">
                  张数（并发）
                  <div className="grid grid-cols-4 gap-1 rounded-xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel-solid)_45%,transparent)] p-1">
                    {[1, 2, 3, 4].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => updateWorkspace(workspace.id, { count: n })}
                        className="relative min-h-[30px] rounded-lg text-[12.5px] font-bold transition-colors duration-300"
                        style={{ color: workspace.count === n ? "#fff" : "var(--muted)" }}
                      >
                        {workspace.count === n && (
                          <motion.span
                            layoutId={"count-pill-" + workspace.id}
                            transition={{ type: "spring", stiffness: 480, damping: 32 }}
                            className="absolute inset-0 rounded-lg bg-[var(--accent)]"
                          />
                        )}
                        <span className="relative z-10">{n}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              )}

              {isGemini && (
                <div className="field-label">
                  张数（并发）
                  <div className="grid grid-cols-4 gap-1 rounded-xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel-solid)_45%,transparent)] p-1">
                    {[1, 2, 3, 4].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => updateWorkspace(workspace.id, { count: n })}
                        className="relative min-h-[30px] rounded-lg text-[12.5px] font-bold transition-colors duration-300"
                        style={{ color: workspace.count === n ? "#fff" : "var(--muted)" }}
                      >
                        {workspace.count === n && (
                          <motion.span
                            layoutId={"count-pill-" + workspace.id}
                            transition={{ type: "spring", stiffness: 480, damping: 32 }}
                            className="absolute inset-0 rounded-lg bg-[var(--accent)]"
                          />
                        )}
                        <span className="relative z-10">{n}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 高级配置按钮 */}
              {!isGemini && <button
                type="button"
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex items-center justify-center gap-2 rounded-xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel-solid)_35%,transparent)] py-2.5 text-[13px] font-semibold text-[var(--muted)] transition-all duration-300 hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                <Settings2 size={14} />
                高级配置
                <motion.span
                  animate={{ rotate: advancedOpen ? 180 : 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 25 }}
                  className="grid place-items-center"
                >
                  <ChevronDown size={14} />
                </motion.span>
              </button>}

              {/* 高级配置面板 */}
              <AnimatePresence initial={false}>
                {advancedOpen && !isGemini && (
                  <motion.div
                    key="advanced"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 320, damping: 30 }}
                    className="overflow-hidden"
                  >
                    <div className="grid gap-3 rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel-solid)_25%,transparent)] p-4">
                      {/* 负面提示词 */}
                      <label className="field-label">
                        负面提示词（Negative Prompt）
                        <textarea
                          className="input"
                          spellCheck={false}
                          rows={2}
                          placeholder="不想出现的内容，如：blurry, low quality, distorted..."
                          value={workspace.negativePrompt || ""}
                          onChange={(e) =>
                            updateWorkspace(workspace.id, { negativePrompt: e.target.value })
                          }
                        />
                      </label>

                      {/* 质量和风格 */}
                      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                        <label className="field-label">
                          质量（Quality）
                          <select
                            className="input"
                            value={workspace.quality || "standard"}
                            onChange={(e) =>
                              updateWorkspace(workspace.id, { quality: e.target.value })
                            }
                          >
                            <option value="standard">标准 (standard)</option>
                            <option value="hd">高清 (hd)</option>
                          </select>
                        </label>
                        <label className="field-label">
                          风格（Style）
                          <select
                            className="input"
                            value={workspace.style || "vivid"}
                            onChange={(e) =>
                              updateWorkspace(workspace.id, { style: e.target.value })
                            }
                          >
                            <option value="vivid">鲜艳 (vivid)</option>
                            <option value="natural">自然 (natural)</option>
                          </select>
                        </label>
                      </div>

                      {/* 步数和引导系数 */}
                      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                        <label className="field-label">
                          <span className="flex items-center justify-between">
                            采样步数（Steps）
                            <span className="text-[11px] text-[var(--muted)]">
                              {workspace.steps || "默认"}
                            </span>
                          </span>
                          <input
                            type="range"
                            className="w-full"
                            min="10"
                            max="100"
                            step="5"
                            value={workspace.steps || 50}
                            onChange={(e) =>
                              updateWorkspace(workspace.id, { steps: Number(e.target.value) })
                            }
                          />
                        </label>
                        <label className="field-label">
                          <span className="flex items-center justify-between">
                            引导系数（CFG Scale）
                            <span className="text-[11px] text-[var(--muted)]">
                              {workspace.cfgScale || "默认"}
                            </span>
                          </span>
                          <input
                            type="range"
                            className="w-full"
                            min="1"
                            max="20"
                            step="0.5"
                            value={workspace.cfgScale || 7}
                            onChange={(e) =>
                              updateWorkspace(workspace.id, { cfgScale: Number(e.target.value) })
                            }
                          />
                        </label>
                      </div>

                      {/* 随机种子 */}
                      <label className="field-label">
                        随机种子（Seed）
                        <div className="flex gap-2">
                          <input
                            type="number"
                            className="input flex-1"
                            placeholder="留空则随机"
                            value={workspace.seed || ""}
                            onChange={(e) =>
                              updateWorkspace(workspace.id, {
                                seed: e.target.value ? Number(e.target.value) : undefined,
                              })
                            }
                          />
                          <button
                            type="button"
                            className="btn shrink-0"
                            onClick={() =>
                              updateWorkspace(workspace.id, {
                                seed: Math.floor(Math.random() * 1000000000),
                              })
                            }
                          >
                            随机
                          </button>
                        </div>
                      </label>

                      {/* 重置按钮 */}
                      <button
                        type="button"
                        onClick={() =>
                          updateWorkspace(workspace.id, {
                            negativePrompt: "",
                            quality: "standard",
                            style: "vivid",
                            steps: 50,
                            cfgScale: 7,
                            seed: undefined,
                          })
                        }
                        className="text-[12px] text-[var(--muted)] transition-colors hover:text-[var(--warn)]"
                      >
                        重置高级参数为默认值
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* 运行行 */}
              <div className="flex items-center gap-2.5">
                <div
                  className="min-w-0 flex-1 truncate text-[12px]"
                  style={{ color: MESSAGE_COLOR[run?.kind || "idle"] }}
                  title={run?.message}
                >
                  {run?.message || "就绪"}
                  {busy && run?.startedAt ? (
                    <>
                      {" · "}
                      <ElapsedTimer since={run.startedAt} />
                    </>
                  ) : null}
                </div>
                {busy && (
                  <button className="btn btn-danger" onClick={() => cancelRun(workspace.id)}>
                    <Square size={13} /> 取消
                  </button>
                )}
                <MagneticButton
                  className="btn btn-primary min-w-[128px]"
                  disabled={busy}
                  onClick={() => void runWorkspace(workspace.id)}
                >
                  {busy ? (
                    <>
                      {run && run.total > 1 ? (
                        <ProgressRing done={run.done} total={run.total} />
                      ) : (
                        <OrbitSpinner />
                      )}
                      生成中
                    </>
                  ) : (
                    <>
                      <Zap size={15} />
                      {workspace.mode === "edit" ? "开始图生图" : "开始生成"}
                    </>
                  )}
                </MagneticButton>
              </div>

              {/* 结果 */}
              {results.length === 0 ? (
                <div className="rounded-2xl border-2 border-dashed border-[var(--line)] px-4 py-7 text-center text-[12.5px] text-[var(--muted)]">
                  暂无结果 — 生成的图片会自动存入画廊
                </div>
              ) : (
                <motion.div
                  layout
                  variants={staggerContainer}
                  initial="hidden"
                  animate="show"
                  className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr))]"
                >
                  <AnimatePresence mode="popLayout">
                    {results.map((item, index) => (
                      <ResultCard
                        key={item.id}
                        item={item}
                        index={results.length - 1 - index}
                        onView={() => openViewer(results, index)}
                      />
                    ))}
                  </AnimatePresence>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function HeadIcon({
  children,
  tip,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  tip: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      className={
        "grid size-7 place-items-center rounded-lg text-[var(--muted)] transition-all duration-200 enabled:hover:scale-110 disabled:opacity-30 " +
        (danger
          ? "enabled:hover:bg-[color-mix(in_oklab,var(--err)_18%,transparent)] enabled:hover:text-[var(--err)]"
          : "enabled:hover:bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] enabled:hover:text-[var(--ink)]")
      }
    >
      {children}
    </button>
  );
}
