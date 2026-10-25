import { motion } from "motion/react";
import {
  BookMarked,
  Command,
  GalleryVerticalEnd,
  LogOut,
  Moon,
  Plug,
  Plus,
  Sun,
} from "lucide-react";
import type { MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useApp } from "../lib/store";
import { springSoft } from "../lib/motion";
import { logout } from "../lib/session";
import { Kbd, MagneticButton } from "./ui";
import { LocalStorageStatus } from "./LocalStorageStatus";

const STATUS_COLOR: Record<string, string> = {
  idle: "var(--muted)",
  testing: "var(--warn)",
  ok: "var(--ok)",
  err: "var(--err)",
};

export function Sidebar() {
  const providers = useApp((s) => s.providers);
  const theme = useApp((s) => s.theme);
  const connections = useApp((s) => s.connections);
  const setTheme = useApp((s) => s.setTheme);
  const testConnection = useApp((s) => s.testConnection);
  const addWorkspace = useApp((s) => s.addWorkspace);
  const setGalleryOpen = useApp((s) => s.setGalleryOpen);
  const setLibraryOpen = useApp((s) => s.setLibraryOpen);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);

  /** 主题切换：View Transitions 圆形揭示（非线性 ease），不支持时直接切换 */
  function toggleTheme(event: MouseEvent<HTMLButtonElement>) {
    const next = theme === "dark" ? "light" : "dark";
    const doc = document as Document & { startViewTransition?: (cb: () => void) => any };
    if (!doc.startViewTransition) {
      setTheme(next);
      return;
    }
    const x = event.clientX;
    const y = event.clientY;
    const transition = doc.startViewTransition(() => {
      flushSync(() => setTheme(next));
    });
    transition.ready
      .then(() => {
        const radius = Math.hypot(
          Math.max(x, window.innerWidth - x),
          Math.max(y, window.innerHeight - y),
        );
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${radius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 720,
            easing: "cubic-bezier(0.83, 0, 0.17, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => undefined);
  }

  return (
    <motion.aside
      initial={{ x: -44, opacity: 0, filter: "blur(8px)" }}
      animate={{ x: 0, opacity: 1, filter: "blur(0px)" }}
      transition={springSoft}
      className="glass z-30 flex flex-col gap-5 rounded-3xl p-5 max-lg:mx-4 max-lg:mt-4 lg:fixed lg:bottom-4 lg:left-4 lg:top-4 lg:w-[320px] lg:overflow-y-auto"
    >
      {/* 品牌 */}
      <div className="flex items-center gap-3">
        <motion.div
          initial={{ scale: 0.3, rotate: -28, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 240, damping: 13, delay: 0.12 }}
          className="grid size-11 shrink-0 place-items-center rounded-2xl border border-[var(--line-strong)] bg-[var(--panel-solid)] shadow-[0_0_30px_-6px_var(--glow)]"
        >
          <svg viewBox="0 0 100 100" className="size-7">
            <defs>
              <linearGradient id="brand-g" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#a78bfa" />
                <stop offset="50%" stopColor="#22d3ee" />
                <stop offset="100%" stopColor="#f472b6" />
              </linearGradient>
            </defs>
            <path
              d="M30 16 v56 h44"
              fill="none"
              stroke="url(#brand-g)"
              strokeWidth="13"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.div>
        <div className="min-w-0">
          <h1 className="font-display gradient-text m-0 text-[19px] font-bold leading-tight tracking-tight">
            LUCEN 光相
          </h1>
          <div className="truncate text-[11px] text-[var(--muted)]">
            GPT Image 2 + Gemini 3.1 · 多窗口并发
          </div>
        </div>
      </div>

      {/* 主操作 */}
      <div className="grid grid-cols-2 gap-2.5">
        <MagneticButton
          className="btn btn-primary col-span-2"
          onClick={() => addWorkspace()}
          data-tip="新建一个生图窗口 (N)"
        >
          <Plus size={16} /> 新窗口
        </MagneticButton>
        <button className="btn" onClick={() => setGalleryOpen(true)} data-tip="所有历史生成 (G)">
          <GalleryVerticalEnd size={15} /> 画廊
        </button>
        <button
          className="btn"
          onClick={() => setLibraryOpen(true)}
          data-tip="收藏与最近的 prompt (P)"
        >
          <BookMarked size={15} /> Prompt
        </button>
      </div>

      {/* 服务端 Provider 状态 */}
      <div className="grid gap-3.5 border-t border-[var(--line)] pt-4">
        {([
          ["gpt", "GPT Image 2", "测试 GPT"],
          ["gemini", "Gemini 3.1", "测试 Gemini"],
        ] as const).map(([provider, label, testLabel]) => (
          <div key={provider} className="grid gap-2 border-b border-[var(--line)] pb-3.5 last:border-b-0 last:pb-0">
            <div className="flex items-center justify-between gap-3">
              <span className="field-label">{label}</span>
              <span className="text-[11px] font-semibold" style={{ color: providers[provider] ? "var(--ok)" : "var(--err)" }}>
                {providers[provider] ? "服务端已配置" : "服务端未配置"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn min-w-[108px] shrink-0"
                onClick={() => void testConnection(provider)}
                disabled={!providers[provider]}
              >
                <Plug size={14} /> {testLabel}
              </button>
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <span
                  className="status-dot mt-1 shrink-0"
                  style={{ color: STATUS_COLOR[connections[provider].status] }}
                />
                <span className="min-w-0 break-words text-[11px] leading-relaxed text-[var(--muted)]">
                  {connections[provider].message}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <LocalStorageStatus />

      {/* 底部工具 */}
      <div className="mt-auto grid gap-3 border-t border-[var(--line)] pt-4">
        <div className="flex items-center justify-between">
          <button
            className="btn icon-btn"
            onClick={toggleTheme}
            data-tip={theme === "dark" ? "切换浅色" : "切换深色"}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button
            className="btn icon-btn"
            onClick={() => void logout().then(() => window.location.reload())}
            data-tip="退出登录"
            aria-label="退出登录"
          >
            <LogOut size={15} />
          </button>
          <button
            className="btn"
            onClick={() => setPaletteOpen(true)}
            data-tip="命令面板"
          >
            <Command size={14} />
            <span className="text-[12px]">
              命令 <Kbd>Ctrl K</Kbd>
            </span>
          </button>
        </div>
        <div className="grid gap-1.5 text-[11px] leading-relaxed text-[var(--muted)]">
          <div>
            <Kbd>Ctrl Enter</Kbd> 生成 · <Kbd>Ctrl V</Kbd> 粘贴图变二创
          </div>
          <div>
            <Kbd>N</Kbd> 新窗口 · <Kbd>G</Kbd> 画廊 · <Kbd>P</Kbd> Prompt 库
          </div>
        </div>
      </div>
    </motion.aside>
  );
}
