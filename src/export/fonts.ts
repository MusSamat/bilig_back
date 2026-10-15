/** Bundled Noto Sans (OFL) — full Cyrillic incl. Kyrgyz Ү Ө Ң for PDF/PPTX exports. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = (f: string) => fileURLToPath(new URL(`../../assets/fonts/${f}`, import.meta.url));
let cache: { regular: Buffer; bold: Buffer } | null = null;

export function notoSans(): { regular: Buffer; bold: Buffer } {
  cache ??= { regular: readFileSync(dir('NotoSans-Regular.ttf')), bold: readFileSync(dir('NotoSans-Bold.ttf')) };
  return cache;
}
export const FONT_FAMILY = 'Noto Sans';
