/** Printable student login cards (TZ scenario «Учитель» 2): class code + name + PIN, 8 per A4. */
import type { Lang } from '@bilig/content-model';
import { createPdf } from './pdf-util.js';

const L: Record<Lang, { title: string; code: string; pin: string; pinBlank: string; site: string }> = {
  ky: { title: 'Bilig — кирүү картасы', code: 'Класстын коду', pin: 'PIN', pinBlank: 'PIN: ________', site: 'Сайт' },
  ru: { title: 'Bilig — карточка входа', code: 'Код класса', pin: 'PIN', pinBlank: 'PIN: ________', site: 'Сайт' },
  en: { title: 'Bilig — login card', code: 'Class code', pin: 'PIN', pinBlank: 'PIN: ________', site: 'Site' },
};

export interface LoginCardsInput {
  className: string;
  joinCode: string;
  loginUrl: string;
  lang: Lang;
  cards: { name: string; pin?: string }[];
}

export async function renderLoginCards(input: LoginCardsInput): Promise<Buffer> {
  const t = L[input.lang];
  const { doc, done } = createPdf({ title: `${t.title} ${input.className}` });
  const cols = 2;
  const rows = 4;
  const m = 36;
  const w = (doc.page.width - m * 2) / cols;
  const h = (doc.page.height - m * 2) / rows;
  input.cards.forEach((card, i) => {
    const slot = i % (cols * rows);
    if (i > 0 && slot === 0) doc.addPage();
    const x = m + (slot % cols) * w;
    const y = m + Math.floor(slot / cols) * h;
    doc.save().dash(4, { space: 4 }).rect(x + 4, y + 4, w - 8, h - 8).stroke('#999999').restore();
    const px = x + 18;
    let py = y + 18;
    doc.font('bold').fontSize(11).fillColor('#555555').text(t.title, px, py, { width: w - 36 });
    py += 22;
    doc.font('bold').fontSize(16).fillColor('#000000').text(card.name, px, py, { width: w - 36, height: 44, ellipsis: true });
    py += 46;
    doc.font('body').fontSize(11).fillColor('#333333').text(`${input.className} · ${t.code}:`, px, py, { width: w - 36 });
    py += 16;
    doc.font('bold').fontSize(22).fillColor('#000000').text(input.joinCode.split('').join(' '), px, py, { width: w - 36 });
    py += 32;
    doc.font('bold').fontSize(18).text(card.pin ? `${t.pin}: ${card.pin}` : t.pinBlank, px, py, { width: w - 36 });
    py += 28;
    doc.font('body').fontSize(9).fillColor('#555555').text(`${t.site}: ${input.loginUrl}`, px, py, { width: w - 36 });
  });
  if (!input.cards.length) doc.font('body').fontSize(14).text(`${input.className} · ${t.code}: ${input.joinCode}`);
  doc.end();
  return done;
}
