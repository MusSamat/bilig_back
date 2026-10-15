/** PDF export (W-52) with pdfkit: landscape A4, one page per slide, embedded Noto Sans (Ү Ө Ң). */
import type { Slide } from '@bilig/content-model/api';
import { createPdf, type Pdf } from './pdf-util.js';
import { imageMime, type DeckInput } from './deck-types.js';

export async function renderDeckPdf(input: DeckInput): Promise<Buffer> {
  const { doc, done } = createPdf({ layout: 'landscape', title: input.title });
  const m = 48;
  const W = doc.page.width - m * 2;
  const H = doc.page.height - m * 2;

  const image = (d: Pdf, snapshotId: string | undefined, x: number, y: number, w: number, h: number): boolean => {
    if (!snapshotId) return false;
    const img = input.images.get(snapshotId);
    const kind = img ? imageMime(img.contentType) : null;
    if (!img || !kind) return false;
    if (kind === 'webp') {
      // pdfkit cannot decode WebP; show a placeholder frame instead.
      d.save().rect(x, y, w, h).stroke('#BBBBBB').restore();
      d.font('body').fontSize(12).fillColor('#888888').text('[3D]', x, y + h / 2 - 8, { width: w, align: 'center' });
      return true;
    }
    try {
      d.image(img.body, x, y, { fit: [w, h], align: 'center', valign: 'center' });
      return true;
    } catch {
      return false;
    }
  };

  const heading = (text: string) => {
    doc.font('bold').fontSize(26).fillColor('#111827').text(text, m, m, { width: W });
    return doc.y + 12;
  };

  input.slides.forEach((slide: Slide, i) => {
    if (i > 0) doc.addPage();
    switch (slide.kind) {
      case 'title':
        doc.font('bold').fontSize(36).fillColor('#111827').text(slide.title, m, m + H / 3, { width: W, align: 'center' });
        if (slide.subtitle) doc.moveDown(0.6).font('body').fontSize(18).fillColor('#4B5563').text(slide.subtitle, { width: W, align: 'center' });
        break;
      case 'concept': {
        const y = heading(slide.title);
        const hasImg = image(doc, slide.snapshotId, m + W / 2 + 10, y, W / 2 - 10, H - (y - m));
        doc.font('body').fontSize(15).fillColor('#1F2937').text(slide.text, m, y, { width: hasImg ? W / 2 - 10 : W, height: H - (y - m) });
        break;
      }
      case 'process': {
        let y = heading(slide.title);
        if (slide.equation) {
          doc.font('body').fontSize(16).fillColor('#374151').text(slide.equation, m, y, { width: W });
          y = doc.y + 10;
        }
        doc.font('body').fontSize(15).fillColor('#1F2937');
        slide.steps.forEach((s, n) => doc.text(`${n + 1}. ${s}`, m, n === 0 ? y : undefined, { width: W }));
        break;
      }
      case 'text': {
        const y = heading(slide.title);
        doc.font('body').fontSize(15).fillColor('#1F2937').text(slide.text, m, y, { width: W, height: H - (y - m) });
        break;
      }
      case 'snapshot': {
        const ok = image(doc, slide.snapshotId, m, m, W, H - 40);
        if (!ok) doc.font('body').fontSize(14).fillColor('#9CA3AF').text('[snapshot]', m, m + H / 2, { width: W, align: 'center' });
        if (slide.caption) doc.font('body').fontSize(14).fillColor('#374151').text(slide.caption, m, m + H - 30, { width: W, align: 'center' });
        break;
      }
    }
  });
  if (!input.slides.length) doc.font('bold').fontSize(28).text(input.title, m, m);
  doc.end();
  return done;
}
