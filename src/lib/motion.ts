import type { Transition, Variants } from "motion/react";

/** 非线性弹簧预设 —— 全站动画的统一“手感” */
export const springSnappy: Transition = { type: "spring", stiffness: 480, damping: 34, mass: 0.8 };
export const springBouncy: Transition = { type: "spring", stiffness: 320, damping: 17, mass: 0.9 };
export const springSoft: Transition = { type: "spring", stiffness: 150, damping: 22, mass: 1 };
export const springSlow: Transition = { type: "spring", stiffness: 90, damping: 18, mass: 1.2 };

/** 入场编排：父容器 stagger */
export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.055, delayChildren: 0.1 },
  },
};

export const popIn: Variants = {
  hidden: { opacity: 0, y: 26, scale: 0.96, filter: "blur(8px)" },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: springBouncy,
  },
  exit: {
    opacity: 0,
    scale: 0.92,
    filter: "blur(6px)",
    transition: { duration: 0.18, ease: [0.4, 0, 1, 1] },
  },
};

export const resultIn: Variants = {
  hidden: { opacity: 0, scale: 0.7, rotate: -3, filter: "blur(10px)" },
  show: {
    opacity: 1,
    scale: 1,
    rotate: 0,
    filter: "blur(0px)",
    transition: { type: "spring", stiffness: 350, damping: 19, mass: 0.85 },
  },
  exit: {
    opacity: 0,
    scale: 0.8,
    filter: "blur(8px)",
    transition: { duration: 0.16 },
  },
};

export const overlayFade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, transition: { duration: 0.18 } },
};

export const dialogPop: Variants = {
  hidden: { opacity: 0, scale: 0.92, y: 24, filter: "blur(10px)" },
  show: { opacity: 1, scale: 1, y: 0, filter: "blur(0px)", transition: springSnappy },
  exit: { opacity: 0, scale: 0.95, y: 12, filter: "blur(6px)", transition: { duration: 0.16 } },
};
