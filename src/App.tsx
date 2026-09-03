import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AuroraBackground } from "./components/AuroraBackground";
import { CommandPalette } from "./components/CommandPalette";
import { GalleryDrawer } from "./components/GalleryDrawer";
import { ImageViewer } from "./components/ImageViewer";
import { LoginScreen } from "./components/LoginScreen";
import { PromptLibrary } from "./components/PromptLibrary";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { WorkspaceCard } from "./components/WorkspaceCard";
import { popIn, staggerContainer } from "./lib/motion";
import { GEMINI_MODEL } from "./lib/models";
import { getSession, UNAUTHORIZED_EVENT } from "./lib/session";
import { useApp } from "./lib/store";

export default function App() {
  const [authState, setAuthState] = useState<"loading" | "authenticated" | "anonymous" | "error">(
    "loading",
  );

  useEffect(() => {
    let active = true;
    const refresh = () => {
      setAuthState("loading");
      void getSession()
        .then((session) => {
          if (active) setAuthState(session.authenticated ? "authenticated" : "anonymous");
        })
        .catch(() => {
          if (active) setAuthState("error");
        });
    };
    const unauthorized = () => setAuthState("anonymous");
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    refresh();
    const timer = window.setInterval(() => {
      void getSession()
        .then((session) => {
          if (active && !session.authenticated) setAuthState("anonymous");
        })
        .catch(() => undefined);
    }, 60000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
    };
  }, []);

  if (authState === "authenticated") return <Workbench />;

  return (
    <>
      <AuroraBackground />
      {authState === "anonymous" ? (
        <LoginScreen onAuthenticated={() => setAuthState("authenticated")} />
      ) : (
        <main className="relative z-10 grid min-h-screen place-items-center p-5">
          <div className="glass-strong grid w-full max-w-[360px] gap-4 rounded-2xl p-6 text-center">
            <h1 className="font-display m-0 text-[20px] font-bold text-[var(--ink)]">LUCEN 光相</h1>
            <p className="m-0 text-[13px] text-[var(--muted)]">
              {authState === "error" ? "无法连接工作台服务" : "正在验证会话…"}
            </p>
            {authState === "error" && (
              <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
                重新连接
              </button>
            )}
          </div>
        </main>
      )}
    </>
  );
}

function Workbench() {
  const booted = useApp((s) => s.booted);
  const workspaces = useApp((s) => s.workspaces);
  const addWorkspace = useApp((s) => s.addWorkspace);
  const [splashGone, setSplashGone] = useState(false);
  const bootStarted = useRef(false);

  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    void useApp.getState().boot();
  }, []);

  useEffect(() => {
    if (!booted) return;
    const timer = setTimeout(() => setSplashGone(true), 560);
    return () => clearTimeout(timer);
  }, [booted]);

  useEffect(() => {
    if (!booted) return;
    const refresh = () => void useApp.getState().syncGallery().catch(() => undefined);
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [booted]);

  // 全局快捷键
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const app = useApp.getState();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        app.setPaletteOpen(!app.paletteOpen);
        return;
      }
      if (event.key === "Escape" && !app.viewer.open) {
        if (app.paletteOpen) app.setPaletteOpen(false);
        else if (app.libraryOpen) app.setLibraryOpen(false);
        else if (app.galleryOpen) app.setGalleryOpen(false);
        return;
      }
      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      )
        return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") app.addWorkspace();
      else if (key === "g") app.setGalleryOpen(!app.galleryOpen);
      else if (key === "p") app.setLibraryOpen(!app.libraryOpen, app.focusedId);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 全局粘贴图片 → 当前聚焦窗口直接进入图生图
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const files = Array.from(event.clipboardData?.files || []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (!files.length) return;
      event.preventDefault();
      const app = useApp.getState();
      const id = app.focusedId || app.workspaces[0]?.id;
      if (!id) return;
      if (app.workspaces.find((workspace) => workspace.id === id)?.model === GEMINI_MODEL) {
        app.toast("Gemini 仅支持文生图，请先切换到 GPT Image 2", "err");
        return;
      }
      void app.addInputFiles(id, files);
      app.toast("已粘贴 " + files.length + " 张图，进入图生图模式", "ok");
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  return (
    <>
      <AuroraBackground />

      <AnimatePresence>
        {!splashGone && (
          <motion.div
            key="splash"
            exit={{ opacity: 0, scale: 1.08, filter: "blur(14px)" }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-0 z-[100] grid place-items-center bg-[var(--bg)]"
          >
            <div className="relative grid place-items-center">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="absolute rounded-full border border-[var(--accent)]/40"
                  initial={{ width: 80, height: 80, opacity: 0 }}
                  animate={{ width: 240, height: 240, opacity: [0, 0.7, 0] }}
                  transition={{
                    duration: 1.6,
                    delay: i * 0.42,
                    repeat: Infinity,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                />
              ))}
              <motion.div
                initial={{ scale: 0.4, rotate: -30, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 13 }}
                className="grid size-20 place-items-center rounded-[26px] border border-[var(--line-strong)] bg-[var(--panel-solid)] shadow-[0_0_60px_-8px_var(--glow)]"
              >
                <svg viewBox="0 0 100 100" className="size-12">
                  <defs>
                    <linearGradient id="splash-g" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#a78bfa" />
                      <stop offset="50%" stopColor="#22d3ee" />
                      <stop offset="100%" stopColor="#f472b6" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M30 16 v56 h44"
                    fill="none"
                    stroke="url(#splash-g)"
                    strokeWidth="13"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25, type: "spring", stiffness: 200, damping: 18 }}
                className="font-display gradient-text absolute top-[calc(50%+64px)] text-[15px] font-bold tracking-[0.3em]"
              >
                LUCEN
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {booted && (
        <div className="min-h-screen lg:pl-[352px]">
          <Sidebar />
          <main className="p-4 lg:p-6">
            <motion.div
              variants={staggerContainer}
              initial="hidden"
              animate="show"
              className="grid items-start gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(430px,100%),1fr))]"
            >
              <AnimatePresence mode="popLayout">
                {workspaces.map((workspace) => (
                  <WorkspaceCard key={workspace.id} workspace={workspace} />
                ))}
              </AnimatePresence>
              <motion.button
                layout
                variants={popIn}
                type="button"
                onClick={() => addWorkspace()}
                whileHover={{ scale: 1.015 }}
                whileTap={{ scale: 0.985 }}
                className="grid min-h-[150px] cursor-pointer place-items-center rounded-3xl border-2 border-dashed border-[var(--line-strong)] text-[var(--muted)] transition-colors duration-300 hover:border-[var(--accent)] hover:text-[var(--accent)] hover:shadow-[0_0_40px_-14px_var(--glow)]"
              >
                <span className="grid place-items-center gap-2">
                  <Plus size={26} />
                  <span className="text-[13px] font-semibold">新窗口</span>
                </span>
              </motion.button>
            </motion.div>
            <footer className="py-8 text-center text-[11px] text-[var(--muted)]/70">
              LUCEN 光相工作台 v2 · 结果自动上传 Remit 图床 · Provider 密钥由服务端管理
            </footer>
          </main>
        </div>
      )}

      <ImageViewer />
      <GalleryDrawer />
      <CommandPalette />
      <PromptLibrary />
      <Toasts />
    </>
  );
}
