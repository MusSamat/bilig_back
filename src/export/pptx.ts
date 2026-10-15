/** PPTX export (W-52) with pptxgenjs: 16:9, Noto Sans, speaker notes, embedded snapshots. */
import PptxGenJS from 'pptxgenjs';
import type { Slide } from '@bilig/content-model/api';
import { FONT_FAMILY } from './fonts.js';
import { imageMime, type DeckInput } from './deck-types.js';

const W = 13.333;
const H = 7.5;

export async function renderPptx(input: DeckInput): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = input.title;
  pptx.company = 'Bilig';
  pptx.theme = { headFontFace: FONT_FAMILY, bodyFontFace: FONT_FAMILY };

  const addImage = (s: PptxGenJS.Slide, snapshotId: string | undefined, x: number, y: number, w: number, h: number) => {
    if (!snapshotId) return false;
    const img = input.images.get(snapshotId);
    const kind = img ? imageMime(img.contentType) : null;
    if (!img || !kind) return false;
    s.addImage({ data: `data:${img.contentType};base64,${img.body.toString('base64')}`, x, y, w, h, sizing: { type: 'contain', w, h } });
    return true;
  };

  const heading = (s: PptxGenJS.Slide, text: string) =>
    s.addText(text, { x: 0.5, y: 0.35, w: W - 1, h: 0.9, fontFace: FONT_FAMILY, fontSize: 30, bold: true, color: '1F2937' });

  for (const slide of input.slides as Slide[]) {
    const s = pptx.addSlide();
    switch (slide.kind) {
      case 'title':
        s.addText(slide.title, { x: 0.8, y: 2.3, w: W - 1.6, h: 1.4, fontFace: FONT_FAMILY, fontSize: 40, bold: true, align: 'center', color: '111827' });
        if (slide.subtitle) s.addText(slide.subtitle, { x: 1, y: 3.9, w: W - 2, h: 1.6, fontFace: FONT_FAMILY, fontSize: 20, align: 'center', color: '4B5563' });
        break;
      case 'concept': {
        heading(s, slide.title);
        const hasImg = addImage(s, slide.snapshotId, W / 2 + 0.2, 1.4, W / 2 - 0.7, H - 2);
        s.addText(slide.text, { x: 0.5, y: 1.4, w: hasImg ? W / 2 - 0.7 : W - 1, h: H - 2, fontFace: FONT_FAMILY, fontSize: 18, valign: 'top', color: '1F2937' });
        break;
      }
      case 'process': {
        heading(s, slide.title);
        let y = 1.35;
        if (slide.equation) {
          s.addText(slide.equation, { x: 0.5, y, w: W - 1, h: 0.7, fontFace: FONT_FAMILY, fontSize: 20, italic: true, color: '374151' });
          y += 0.8;
        }
        s.addText(
          slide.steps.map((text) => ({ text, options: { bullet: { type: 'number' as const }, breakLine: true } })),
          { x: 0.5, y, w: W - 1, h: H - y - 0.5, fontFace: FONT_FAMILY, fontSize: 18, valign: 'top', color: '1F2937' },
        );
        break;
      }
      case 'text':
        heading(s, slide.title);
        s.addText(slide.text, { x: 0.5, y: 1.4, w: W - 1, h: H - 2, fontFace: FONT_FAMILY, fontSize: 18, valign: 'top', color: '1F2937' });
        break;
      case 'snapshot': {
        const ok = addImage(s, slide.snapshotId, 0.5, 0.4, W - 1, H - 1.4);
        if (!ok) s.addText('[snapshot]', { x: 0.5, y: 3, w: W - 1, h: 1, fontFace: FONT_FAMILY, fontSize: 18, align: 'center', color: '9CA3AF' });
        if (slide.caption) s.addText(slide.caption, { x: 0.5, y: H - 0.95, w: W - 1, h: 0.6, fontFace: FONT_FAMILY, fontSize: 16, align: 'center', color: '374151' });
        break;
      }
    }
    if (slide.notes) s.addNotes(slide.notes);
  }
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as Uint8Array);
}
