import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useApp } from "../lib/store";

const ICONS = {
  ok: <CheckCircle2 size={15} className="text-[var(--ok)]" />,
  err: <AlertTriangle size={15} className="text-[var(--err)]" />,
  info: <Info size={15} className="text-[var(--accent-2)]" />,
};

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[90] flex w-[min(480px,92vw)] -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            type="button"
            layout
            initial={{ opacity: 0, y: 28, scale: 0.9, filter: "blur(6px)" }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              filter: "blur(0px)",
              transition: { type: "spring", stiffness: 380, damping: 22 },
            }}
            exit={{ opacity: 0, y: 12, scale: 0.94, transition: { duration: 0.18 } }}
            onClick={() => dismiss(toast.id)}
            className="glass-strong pointer-events-auto flex max-w-full cursor-pointer items-start gap-2.5 rounded-2xl px-4 py-2.5 text-left text-[12.5px] leading-relaxed shadow-[0_12px_40px_-12px_rgba(0,0,0,.55)]"
          >
            <span className="mt-0.5 shrink-0">{ICONS[toast.type]}</span>
            <span className="break-all">{toast.text}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
