/** PDF export (W-52) with pdfkit: landscape A4, one page per slide, embedded Noto Sans (Ү Ө Ң). */
import * as fontkit from 'fontkit';
import sharp from 'sharp';
import type { Slide } from '@bilig/content-model/api';
import { createPdf, type Pdf } from './pdf-util.js';
import { imageMime, type DeckImage, type DeckInput } from './deck-types.js';
import { notoSans } from './fonts.js';

/**
 * Noto Sans has no math operators; pdfkit has no per-glyph font fallback, so a
 * missing glyph would print as an empty box. Swap those for readable text.
 */
const STAND_INS: Record<string, string> = {
  '≈': '~', '√': 'sqrt', '≤': '<=', '≥': '>=', '≠': '!=', '→': '->', '←': '<-', '⇒': '=>', '↔': '<->', '⇌': '<=>',
  '−': '-', '∞': 'inf', '∑': 'Σ', '∫': 'integral', '∝': '~', '∂': 'd', '∠': 'angle', '⊥': '_|_', '∥': '||', '∓': '-/+',
};
let hasGlyph: ((cp: number) => boolean) | null = null;
export function pdfText(text: string): string {
  if (!hasGlyph) {
    const font = fontkit.create(notoSans().regular);
    hasGlyph = (cp) => font.hasGlyphForCodePoint(cp);
  }
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += cp < 0x2000 || hasGlyph(cp) ? ch : (STAND_INS[ch] ?? ch);
  }
  return out;
}

/** pdfkit decodes only PNG and JPEG: convert WebP (3D snapshots, thumbnails) up front. */
async function pdfImages(images: Map<string, DeckImage>): Promise<Map<string, DeckImage>> {
  const out = new Map<string, DeckImage>();
  for (const [id, img] of images) {
    if (imageMime(img.contentType) !== 'webp') out.set(id, img);
    else {
      try {
        out.set(id, { body: await sharp(img.body).png().toBuffer(), contentType: 'image/png' });
      } catch {
        /* unreadable image: the slide shows its placeholder */
      }
    }
  }
  return out;
}

export async function renderDeckPdf(input: DeckInput): Promise<Buffer> {
  const images = await pdfImages(input.images);
  const { doc, done } = createPdf({ layout: 'landscape', title: input.title });
  const m = 48;
  const W = doc.page.width - m * 2;
  const H = doc.page.height - m * 2;

  const image = (d: Pdf, snapshotId: string | undefined, x: number, y: number, w: number, h: number): boolean => {
    if (!snapshotId) return false;
    const img = images.get(snapshotId);
    const kind = img ? imageMime(img.contentType) : null;
    if (!img || !kind || kind === 'webp') return false;
    try {
      d.image(img.body, x, y, { fit: [w, h], align: 'center', valign: 'center' });
      return true;
    } catch {
      return false;
    }
  };

  const heading = (text: string) => {
    doc.font('bold').fontSize(26).fillColor('#111827').text(pdfText(text), m, m, { width: W });
    return doc.y + 12;
  };

  input.slides.forEach((slide: Slide, i) => {
    if (i > 0) doc.addPage();
    switch (slide.kind) {
      case 'title':
        doc.font('bold').fontSize(36).fillColor('#111827').text(pdfText(slide.title), m, m + H / 3, { width: W, align: 'center' });
        if (slide.subtitle) doc.moveDown(0.6).font('body').fontSize(18).fillColor('#4B5563').text(pdfText(slide.subtitle), { width: W, align: 'center' });
        break;
      case 'concept': {
        const y = heading(slide.title);
        const hasImg = image(doc, slide.snapshotId, m + W / 2 + 10, y, W / 2 - 10, H - (y - m));
        doc.font('body').fontSize(15).fillColor('#1F2937').text(pdfText(slide.text), m, y, { width: hasImg ? W / 2 - 10 : W, height: H - (y - m) });
        break;
      }
      case 'process': {
        let y = heading(slide.title);
        if (slide.equation) {
          doc.font('body').fontSize(16).fillColor('#374151').text(pdfText(slide.equation), m, y, { width: W });
          y = doc.y + 10;
        }
        doc.font('body').fontSize(15).fillColor('#1F2937');
        slide.steps.forEach((s, n) => doc.text(pdfText(`${n + 1}. ${s}`), m, n === 0 ? y : undefined, { width: W }));
        break;
      }
      case 'text': {
        const y = heading(slide.title);
        doc.font('body').fontSize(15).fillColor('#1F2937').text(pdfText(slide.text), m, y, { width: W, height: H - (y - m) });
        break;
      }
      case 'snapshot': {
        const ok = image(doc, slide.snapshotId, m, m, W, H - 40);
        if (!ok) doc.font('body').fontSize(14).fillColor('#9CA3AF').text('[snapshot]', m, m + H / 2, { width: W, align: 'center' });
        if (slide.caption) doc.font('body').fontSize(14).fillColor('#374151').text(pdfText(slide.caption), m, m + H - 30, { width: W, align: 'center' });
        break;
      }
    }
  });
  if (!input.slides.length) doc.font('bold').fontSize(28).text(pdfText(input.title), m, m);
  doc.end();
  return done;
}
