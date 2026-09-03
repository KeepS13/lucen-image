import { useReducedMotion } from "motion/react";

/** 全屏极光层：三个漂移色团 + 网格 + 噪点 + 描边水印 */
export function AuroraBackground() {
  const reduced = useReducedMotion();
  const animation = (name: string, duration: number) =>
    reduced ? undefined : `${name} ${duration}s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite`;

  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden">
      <div
        className="aurora-blob"
        style={{
          width: "55vw",
          height: "55vw",
          left: "-12vw",
          top: "-18vw",
          background: "radial-gradient(circle, #6d28d9 0%, transparent 65%)",
          animation: animation("drift-a", 28),
        }}
      />
      <div
        className="aurora-blob"
        style={{
          width: "48vw",
          height: "48vw",
          right: "-14vw",
          top: "4vh",
          background: "radial-gradient(circle, #0e7490 0%, transparent 65%)",
          animation: animation("drift-b", 34),
        }}
      />
      <div
        className="aurora-blob"
        style={{
          width: "44vw",
          height: "44vw",
          left: "26vw",
          bottom: "-24vh",
          background: "radial-gradient(circle, #be185d 0%, transparent 66%)",
          animation: animation("drift-c", 40),
        }}
      />
      <div className="bg-grid absolute inset-0" />
      <div className="bg-grain absolute inset-0" />
      <div className="watermark pointer-events-none absolute -right-6 bottom-[-3.2rem] text-[11rem] leading-none tracking-tighter max-lg:hidden">
        LUCEN
      </div>
    </div>
  );
}
