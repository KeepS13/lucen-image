import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  ExternalLink,
  Maximize,
  Minus,
  Plus,
  Scan,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { overlayFade } from "../lib/motion";
import { useApp } from "../lib/store";
import type { ResultItem } from "../lib/types";
import {
  clamp,
  downloadBlob,
  extOfMime,
  resultFileBase,
} from "../lib/utils";

const PAN_SPRING = { type: "spring", stiffness: 320, damping: 32 } as const;

async function getBlob(item: ResultItem): Promise<Blob | null> {
  if (!item.hasBlob || !item.objectUrl) return null;
  try {
    const response = await fetch(item.objectUrl);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

export function ImageViewer() {
  const viewer = useApp((s) => s.viewer);
  const closeViewer = useApp((s) => s.closeViewer);
  const setViewerIndex = useApp((s) => s.setViewerIndex);
  const toast = useApp((s) => s.toast);
  const [compare, setCompare] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scaleRaw = useMotionValue(1);
  const scaleSpring = useSpring(scaleRaw, { stiffness: 280, damping: 28, mass: 0.85 });
  const scaleTarget = useRef(1);
  const fitScaleRef = useRef(1);

  const current = viewer.items[viewer.index] as ResultItem | undefined;

  const fit = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage || !img.naturalWidth) return;
    const rect = stage.getBoundingClientRect();
    const fitScale = Math.min(
      (rect.width - 56) / img.naturalWidth,
      (rect.height - 56) / img.naturalHeight,
      1,
    );
    fitScaleRef.current = Math.max(0.04, fitScale);
    scaleTarget.current = fitScaleRef.current;
    scaleRaw.set(fitScaleRef.current);
    void animate(x, 0, PAN_SPRING);
    void animate(y, 0, PAN_SPRING);
  }, [scaleRaw, x, y]);

  function zoomAt(factor: number, clientX?: number, clientY?: number) {
    const stage = stageRef.current;
    if (!stage) return;
    const prev = scaleTarget.current;
    const next = clamp(prev * factor, 0.04, 14);
    if (next === prev) return;
    if (typeof clientX === "number" && typeof clientY === "number") {
      const rect = stage.getBoundingClientRect();
      const originX = clientX - rect.left - rect.width / 2;
      const originY = clientY - rect.top - rect.height / 2;
      const k = next / prev;
      void animate(x, originX - (originX - x.get()) * k, PAN_SPRING);
      void animate(y, originY - (originY - y.get()) * k, PAN_SPRING);
    }
    scaleTarget.current = next;
    scaleRaw.set(next);
  }

  function toOriginal() {
    scaleTarget.current = 1;
    scaleRaw.set(1);
    void animate(x, 0, PAN_SPRING);
    void animate(y, 0, PAN_SPRING);
  }

  // 打开/切换时重置
  useEffect(() => {
    setCompare(false);
    x.set(0);
    y.set(0);
    if (imgRef.current?.complete) fit();
  }, [viewer.index, viewer.open, current?.id, fit, x, y]);

  // 键盘
  useEffect(() => {
    if (!viewer.open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeViewer();
      else if (event.key === "ArrowLeft") setViewerIndex(viewer.index - 1);
      else if (event.key === "ArrowRight") setViewerIndex(viewer.index + 1);
      else if (event.key === "+" || event.key === "=") zoomAt(1.3);
      else if (event.key === "-") zoomAt(0.77);
      else if (event.key === "0") fit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer.open, viewer.index, closeViewer, setViewerIndex, fit]);

  // 窗口尺寸变化
  useEffect(() => {
    if (!viewer.open) return;
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [viewer.open, fit]);

  // 锁定页面滚动 + 非被动 wheel 缩放（React onWheel 为被动监听，无法 preventDefault）
  useEffect(() => {
    if (!viewer.open) return;
    document.body.style.overflow = "hidden";
    const stage = stageRef.current;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (compare) return;
      zoomAt(event.deltaY < 0 ? 1.16 : 0.86, event.clientX, event.clientY);
    };
    stage?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      document.body.style.overflow = "";
      stage?.removeEventListener("wheel", onWheel);
    };
  }, [viewer.open, compare]);

  async function handleDownload() {
    if (!current) return;
    const blob = await getBlob(current);
    const filename = resultFileBase(current);
    if (blob) downloadBlob(blob, filename + "." + extOfMime(blob.type || current.mime || "image/png"));
    else toast("本地图片内容不可用，请刷新后重试", "err");
  }

  const hasCompare = Boolean(current?.sourceDataUrl);

  return (
    <AnimatePresence>
      {viewer.open && current && (
        <motion.div
          variants={overlayFade}
          initial="hidden"
          animate="show"
          exit="exit"
          className="fixed inset-0 z-[70] grid grid-rows-[auto_1fr] bg-black/88 backdrop-blur-xl"
          role="dialog"
          aria-modal="true"
        >
          {/* 工具栏 */}
          <div className="flex min-h-[54px] items-center gap-2 border-b border-white/10 bg-black/40 px-4 py-2">
            <span className="font-display shrink-0 text-[12px] tabular-nums text-white/60">
              {viewer.index + 1} / {viewer.items.length}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-white/80">
              {current.revisedPrompt || current.prompt || "图片预览"}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <ToolButton tip="缩小 (-)" onClick={() => zoomAt(0.77)}>
                <Minus size={15} />
              </ToolButton>
              <ToolButton tip="适应窗口 (0)" onClick={fit}>
                <Scan size={15} />
              </ToolButton>
              <ToolButton tip="放大 (+)" onClick={() => zoomAt(1.3)}>
                <Plus size={15} />
              </ToolButton>
              <ToolButton tip="实际大小 1:1" onClick={toOriginal}>
                <Maximize size={14} />
              </ToolButton>
              {hasCompare && (
                <ToolButton
                  tip={compare ? "退出对比" : "与输入图对比"}
                  active={compare}
                  onClick={() => setCompare((v) => !v)}
                >
                  <Columns2 size={15} />
                </ToolButton>
              )}
              <span className="mx-1 h-5 w-px bg-white/15" />
              <ToolButton tip="下载" onClick={() => void handleDownload()}>
                <Download size={15} />
              </ToolButton>
              <ToolButton
                tip="新标签打开"
                onClick={() => {
                  if (current.objectUrl) window.open(current.objectUrl, "_blank", "noopener,noreferrer");
                }}
              >
                <ExternalLink size={15} />
              </ToolButton>
              <ToolButton tip="关闭 (Esc)" onClick={closeViewer}>
                <X size={17} />
              </ToolButton>
            </div>
          </div>

          {/* 舞台 */}
          <div
            ref={stageRef}
            className="relative flex items-center justify-center overflow-hidden"
            onDoubleClick={(e) => {
              if (compare) return;
              if (Math.abs(scaleTarget.current - fitScaleRef.current) < 0.01) {
                zoomAt(1 / scaleTarget.current, e.clientX, e.clientY);
              } else {
                fit();
              }
            }}
            onClick={(e) => {
              if (e.target === stageRef.current) closeViewer();
            }}
          >
            {compare && current.sourceDataUrl ? (
              <CompareStage result={current} />
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={current.id}
                  drag
                  dragMomentum
                  dragTransition={{ power: 0.4, timeConstant: 220 }}
                  style={{ x, y }}
                  initial={{ opacity: 0, scale: 0.94, filter: "blur(8px)" }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    filter: "blur(0px)",
                    transition: { type: "spring", stiffness: 300, damping: 26 },
                  }}
                  exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
                  className="cursor-grab active:cursor-grabbing"
                >
                  <motion.img
                    ref={imgRef}
                    src={current.objectUrl}
                    alt={current.prompt}
                    draggable={false}
                    onLoad={fit}
                    style={{ scale: scaleSpring, maxWidth: "none", maxHeight: "none" }}
                    className="select-none shadow-[0_24px_90px_-18px_rgba(0,0,0,.85)]"
                  />
                </motion.div>
              </AnimatePresence>
            )}

            {/* 左右切换 */}
            {viewer.items.length > 1 && !compare && (
              <>
                <NavButton
                  side="left"
                  disabled={viewer.index === 0}
                  onClick={() => setViewerIndex(viewer.index - 1)}
                />
                <NavButton
                  side="right"
                  disabled={viewer.index === viewer.items.length - 1}
                  onClick={() => setViewerIndex(viewer.index + 1)}
                />
              </>
            )}

            <div className="pointer-events-none absolute bottom-3 left-4 text-[11px] text-white/45">
              {compare
                ? "拖动分割线对比 · 左侧为输入图"
                : "滚轮缩放 · 拖拽平移（带惯性） · 双击切换 1:1 · ←→ 切换"}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 前后对比：弹簧跟随的分割线 + clip-path */
function CompareStage({ result }: { result: ResultItem }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const position = useMotionValue(50);
  const positionSpring = useSpring(position, { stiffness: 300, damping: 28 });
  const clip = useTransform(positionSpring, (v) => `inset(0 ${100 - v}% 0 0)`);
  const left = useTransform(positionSpring, (v) => `${v}%`);
  const dragging = useRef(false);

  function setFromEvent(event: PointerEvent<HTMLDivElement>) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    position.set(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100));
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1, transition: { type: "spring", stiffness: 300, damping: 26 } }}
      className="relative max-h-[86%] max-w-[92%]"
    >
      <div
        ref={containerRef}
        className="relative cursor-col-resize touch-none select-none overflow-hidden rounded-xl"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) setFromEvent(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
      >
        <img
          src={result.objectUrl || result.url}
          alt="结果"
          draggable={false}
          className="block max-h-[82vh] max-w-full object-contain"
        />
        <motion.img
          src={result.sourceDataUrl}
          alt="输入"
          draggable={false}
          style={{ clipPath: clip }}
          className="absolute inset-0 size-full object-contain"
        />
        <motion.div
          style={{ left }}
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white/90 shadow-[0_0_14px_rgba(255,255,255,.7)]"
        >
          <span className="absolute left-1/2 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-[10px] font-bold text-black shadow-lg">
            ⇆
          </span>
        </motion.div>
        <span className="chip absolute left-2 top-2 !border-transparent !bg-black/60 !text-white/90">
          输入图
        </span>
        <span className="chip absolute right-2 top-2 !border-transparent !bg-black/60 !text-white/90">
          生成结果
        </span>
      </div>
    </motion.div>
  );
}

function ToolButton({
  children,
  tip,
  onClick,
  active,
}: {
  children: React.ReactNode;
  tip: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      data-tip={tip}
      onClick={onClick}
      className={
        "grid size-8.5 min-h-[34px] min-w-[34px] place-items-center rounded-xl text-white/85 transition-all duration-200 hover:scale-110 hover:bg-white/15 " +
        (active ? "bg-[var(--accent)]/60 text-white" : "")
      }
    >
      {children}
    </button>
  );
}

function NavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      disabled={disabled}
      onClick={onClick}
      whileHover={disabled ? undefined : { scale: 1.12 }}
      whileTap={disabled ? undefined : { scale: 0.9 }}
      transition={{ type: "spring", stiffness: 400, damping: 16 }}
      className={
        "absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white backdrop-blur transition-opacity hover:bg-white/20 disabled:opacity-20 " +
        (side === "left" ? "left-4" : "right-4")
      }
    >
      {side === "left" ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </motion.button>
  );
}
