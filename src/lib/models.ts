import type { GeminiAspectRatio, GeminiImageSize, ImageProvider } from "./types";

export const GPT_MODEL_IDS = [
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;
export const GPT_MODEL = GPT_MODEL_IDS[0];
export const GEMINI_MODEL = "gemini-3.1-flash-image";
export const MODEL_IDS = [...GPT_MODEL_IDS, GEMINI_MODEL] as const;

export const GEMINI_ASPECT_RATIOS: GeminiAspectRatio[] = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

export const GEMINI_IMAGE_SIZES: GeminiImageSize[] = ["1K", "2K", "4K"];

export function providerForModel(model: string): ImageProvider {
  return model === GEMINI_MODEL ? "gemini" : "gpt";
}

export function isSupportedModel(model: string): boolean {
  return MODEL_IDS.includes(model as (typeof MODEL_IDS)[number]);
}
