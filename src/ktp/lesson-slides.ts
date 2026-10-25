/**
 * v0.10.0: the presentation of a КТП lesson (.pptx, pptxgenjs): a title slide, one slide per stage of the
 * lesson model (the teacher's text or the model's hints), the ticked slide materials, the ticked test
 * questions on a «Суроолор» slide, and the homework. 16:9, Noto Sans, plain and readable.
 */
import PptxGenJS from 'pptxgenjs';
import { stageContentKey, type Lang, type LessonModel, type LessonModelId } from '@bilig/content-model';
import type { LessonContentBody } from '@bilig/content-model/api';
import { FONT_FAMILY } from '../export/fonts.js';

const W = 13.333;
const H = 7.5;

const T: Record<Lang, { questions: string; homework: string; noHomework: string; grade: string }> = {
  ky: { questions: 'Суроолор', homework: 'Үй тапшырмасы', noHomework: 'Окуу китебиндеги теманы кайталоо', grade: 'класс' },
  ru: { questions: 'Вопросы', homework: 'Домашнее задание', noHomework: 'Повторить тему по учебнику', grade: 'класс' },
  en: { questions: 'Questions', homework: 'Homework', noHomework: 'Revise the topic in the textbook', grade: 'class' },
};

export interface LessonSlidesInput {
  title: string;
  subjectName: string;
  classLabel: string;
  /** DD.MM.YYYY or ''. */
  date: string;
  homework: string;
  lang: Lang;
  model: LessonModel;
  body: LessonContentBody;
}

export async function renderLessonSlides(i: LessonSlidesInput): Promise<Buffer> {
  const L = T[i.lang];
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = i.title;
  pptx.company = 'Bilig';
  pptx.theme = { headFontFace: FONT_FAMILY, bodyFontFace: FONT_FAMILY };
  const accent = i.model.color.replace('#', '');
  const heading = (s: PptxGenJS.Slide, text: string) => {
    s.addShape('rect', { x: 0, y: 0, w: 0.18, h: H, fill: { color: accent } });
    s.addText(text, { x: 0.6, y: 0.35, w: W - 1.2, h: 0.9, fontFace: FONT_FAMILY, fontSize: 28, bold: true, color: '1F2937' });
  };
  const body = (s: PptxGenJS.Slide, lines: string[]) =>
    s.addText(
      lines.map((text) => ({ text, options: { bullet: lines.length > 1, breakLine: true } })),
      { x: 0.6, y: 1.45, w: W - 1.2, h: H - 2, fontFace: FONT_FAMILY, fontSize: 20, valign: 'top', color: '1F2937' },
    );

  const title = pptx.addSlide();
  title.addShape('rect', { x: 0, y: H - 0.35, w: W, h: 0.35, fill: { color: accent } });
  title.addText(i.title, { x: 0.8, y: 2.2, w: W - 1.6, h: 1.6, fontFace: FONT_FAMILY, fontSize: 40, bold: true, align: 'center', color: '111827' });
  title.addText([i.subjectName, `${i.classLabel} ${L.grade}`, i.date].filter(Boolean).join(' · '), { x: 1, y: 4, w: W - 2, h: 0.8, fontFace: FONT_FAMILY, fontSize: 20, align: 'center', color: '4B5563' });

  for (const st of i.model.stages) {
    const c = i.body.stages[stageContentKey(i.model.id as LessonModelId, st.key)];
    const s = pptx.addSlide();
    heading(s, `${st.code} — ${st.title}`);
    body(s, c?.teacher.trim() ? c.teacher.trim().split('\n').filter(Boolean) : st.teacher);
    s.addNotes([st.text, c?.pupil.trim() || st.pupil].join('\n'));
  }

  for (const m of i.body.materials.filter((x) => x.on && x.kind === 'slides')) {
    const [first, ...rest] = m.text.split('\n').map((x) => x.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
    const s = pptx.addSlide();
    heading(s, first ?? '');
    if (rest.length) body(s, rest);
  }

  const tests = i.body.materials.filter((x) => x.on && x.kind === 'tests');
  if (tests.length) {
    const s = pptx.addSlide();
    heading(s, L.questions);
    s.addText(
      tests.map((q) => ({ text: q.text.replace(/\n/g, '   '), options: { bullet: { type: 'number' as const }, breakLine: true } })),
      { x: 0.6, y: 1.45, w: W - 1.2, h: H - 2, fontFace: FONT_FAMILY, fontSize: tests.length > 4 ? 16 : 20, valign: 'top', color: '1F2937' },
    );
  }

  const hw = pptx.addSlide();
  heading(hw, L.homework);
  body(hw, [i.homework.trim() || L.noHomework]);

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as Uint8Array);
}
