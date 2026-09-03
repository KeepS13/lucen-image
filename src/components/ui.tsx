import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent,
  type ReactNode,
} from "react";

/** 磁性按钮：指针靠近时被“吸”向光标，离开后弹簧回位 */
export function MagneticButton({
  children,
  strength = 0.3,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { strength?: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 260, damping: 16, mass: 0.7 });
  const sy = useSpring(y, { stiffness: 260, damping: 16, mass: 0.7 });

  function onMove(event: PointerEvent<HTMLButtonElement>) {
    if (reduced) return;
    const rect = event.currentTarget.getBoundingClientRect();
    x.set((event.clientX - rect.left - rect.width / 2) * strength);
    y.set((event.clientY - rect.top - rect.height / 2) * strength);
  }

  function onLeave() {
    x.set(0);
    y.set(0);
  }

  return (
    <motion.button
      {...(rest as any)}
      className={className}
      style={{ x: sx, y: sy }}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      whileTap={reduced ? undefined : { scale: 0.94 }}
    >
      {children}
    </motion.button>
  );
}

/** 运行计时器：每 100ms 刷新，数字用等宽显示避免跳动 */
export function ElapsedTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, (now - since) / 1000);
  return (
    <span className="font-display tabular-nums text-[var(--accent-2)]">
      {seconds.toFixed(1)}s
    </span>
  );
}

/** 进度环：用于生成按钮 */
export function ProgressRing({ done, total }: { done: number; total: number }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? done / total : 0;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="2.5"
      />
      <motion.circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="#fff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        animate={{ strokeDashoffset: circumference * (1 - ratio) }}
        transition={{ type: "spring", stiffness: 120, damping: 20 }}
      />
    </svg>
  );
}

/** 旋转轨道加载器 */
export function OrbitSpinner() {
  return (
    <span className="relative inline-block size-[18px]">
      <motion.span
        className="absolute inset-0 rounded-full border-2 border-transparent"
        style={{ borderTopColor: "#fff", borderRightColor: "rgba(255,255,255,.35)" }}
        animate={{ rotate: 360 }}
        transition={{ duration: 0.9, ease: [0.45, 0.05, 0.55, 0.95], repeat: Infinity }}
      />
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

/** 复制成功的瞬时反馈包装 */
export function useFlash(duration = 1400) {
  const [flash, setFlash] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function trigger() {
    setFlash(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(false), duration);
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [flash, trigger] as const;
}
