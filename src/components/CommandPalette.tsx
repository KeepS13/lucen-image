import { AnimatePresence, motion } from "motion/react";
import {
  BookMarked,
  ChevronsDownUp,
  ChevronsUpDown,
  CopyPlus,
  GalleryVerticalEnd,
  History,
  Moon,
  Plug,
  Plus,
  Search,
  SunMoon,
  Target,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { legacyPath } from "../lib/basePath";
import { dialogPop, overlayFade } from "../lib/motion";
import { useApp } from "../lib/store";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const workspaces = useApp((s) => s.workspaces);
  const focusedId = useApp((s) => s.focusedId);
  const theme = useApp((s) => s.theme);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const app = useApp.getState();
    const base: Command[] = [
      {
        id: "new",
        label: "新建窗口",
        hint: "N",
        icon: <Plus size={15} />,
        run: () => app.addWorkspace(),
      },
      {
        id: "dup",
        label: "复制当前窗口",
        icon: <CopyPlus size={15} />,
        run: () => focusedId && app.duplicateWorkspace(focusedId),
      },
      {
        id: "gallery",
        label: "打开画廊",
        hint: "G",
        icon: <GalleryVerticalEnd size={15} />,
        run: () => app.setGalleryOpen(true),
      },
      {
        id: "library",
        label: "打开 Prompt 库",
        hint: "P",
        icon: <BookMarked size={15} />,
        run: () => app.setLibraryOpen(true, focusedId),
      },
      {
        id: "theme",
        label: theme === "dark" ? "切换浅色主题" : "切换深色主题",
        icon: theme === "dark" ? <SunMoon size={15} /> : <Moon size={15} />,
        run: () => app.setTheme(theme === "dark" ? "light" : "dark"),
      },
      {
        id: "test-gpt",
        label: "测试 GPT 连接",
        icon: <Plug size={15} />,
        run: () => void app.testConnection("gpt"),
      },
      {
        id: "test-gemini",
        label: "测试 Gemini 连接",
        icon: <Plug size={15} />,
        run: () => void app.testConnection("gemini"),
      },
      {
        id: "collapse",
        label: "折叠所有窗口",
        icon: <ChevronsDownUp size={15} />,
        run: () =>
          app.workspaces.forEach((w) => app.updateWorkspace(w.id, { collapsed: true })),
      },
      {
        id: "expand",
        label: "展开所有窗口",
        icon: <ChevronsUpDown size={15} />,
        run: () =>
          app.workspaces.forEach((w) => app.updateWorkspace(w.id, { collapsed: false })),
      },
      {
        id: "legacy",
        label: "打开旧版界面 (/legacy)",
        icon: <History size={15} />,
        run: () => window.open(legacyPath(), "_blank", "noopener,noreferrer"),
      },
    ];
    const focus: Command[] = workspaces.map((w) => ({
      id: "focus-" + w.id,
      label: "聚焦：" + w.title,
      icon: <Target size={15} />,
      run: () => {
        app.focusWorkspace(w.id);
        app.updateWorkspace(w.id, { collapsed: false });
        document
          .querySelector(`[data-ws="${w.id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      },
    }));
    return [...base, ...focus];
  }, [workspaces, focusedId, theme, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  function runCommand(command: Command | undefined) {
    if (!command) return;
    setOpen(false);
    command.run();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          variants={overlayFade}
          initial="hidden"
          animate="show"
          exit="exit"
          className="fixed inset-0 z-[75] bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <motion.div
            variants={dialogPop}
            className="glass-strong mx-auto mt-[14vh] w-[min(560px,92vw)] overflow-hidden rounded-3xl shadow-[0_30px_90px_-20px_rgba(0,0,0,.7)]"
          >
            <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-4">
              <Search size={16} className="shrink-0 text-[var(--muted)]" />
              <input
                ref={inputRef}
                className="min-h-[52px] w-full border-none bg-transparent text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
                placeholder="输入命令…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((v) => Math.min(v + 1, filtered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((v) => Math.max(v - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    runCommand(filtered[active]);
                  } else if (e.key === "Escape") {
                    setOpen(false);
                  }
                }}
              />
              <span className="kbd shrink-0">Esc</span>
            </div>
            <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <div className="px-4 py-8 text-center text-[12.5px] text-[var(--muted)]">
                  没有匹配的命令
                </div>
              ) : (
                filtered.map((command, index) => (
                  <motion.button
                    key={command.id}
                    type="button"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{
                      opacity: 1,
                      x: 0,
                      transition: {
                        type: "spring",
                        stiffness: 420,
                        damping: 30,
                        delay: Math.min(index * 0.018, 0.25),
                      },
                    }}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runCommand(command)}
                    className={
                      "flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-[13.5px] transition-colors duration-150 " +
                      (index === active
                        ? "bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-[var(--ink)]"
                        : "text-[var(--muted)]")
                    }
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel-solid)_60%,transparent)]">
                      {command.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint && <span className="kbd">{command.hint}</span>}
                  </motion.button>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
