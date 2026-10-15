/** Exporters: PPTX/PDF bytes, Noto Sans with Kyrgyz glyphs, login cards, slide builders. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';
import type { Slide } from '@bilig/content-model/api';
import { renderPptx } from './pptx.js';
import { renderDeckPdf } from './deck-pdf.js';
import { renderLoginCards } from './login-cards.js';
import { llmSlides, llmSystemPrompt, parseLlmSlides, templateSlides } from '../services/slides.js';
import { MockProvider } from '../services/tutor-provider.js';

const require = createRequire(import.meta.url);
const fontkit = require('fontkit') as { create(buf: Buffer): { hasGlyphForCodePoint(cp: number): boolean; familyName: string } };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const KY = 'Үй Өсүмдүк Ң ү ө ң';
const slides: Slide[] = [
  { id: 't', kind: 'title', title: 'Жаныбар клеткасы', subtitle: KY, notes: 'Мугалим үчүн' },
  { id: 'c', kind: 'concept', conceptKey: 'bio.nucleus', title: 'Ядро', text: KY, snapshotId: 's1' },
  { id: 'p', kind: 'process', processKey: 'bio.respiration', title: 'Дем алуу', equation: 'C6H12O6 + 6O2 → 6CO2 + 6H2O', steps: ['Гликолиз', 'Кребс цикли'] },
  { id: 'x', kind: 'text', title: 'Текст', text: 'Hello' },
  { id: 's', kind: 'snapshot', snapshotId: 's1', caption: 'Сүрөт' },
  { id: 'w', kind: 'snapshot', snapshotId: 'webp', caption: 'WebP' },
  { id: 'm', kind: 'snapshot', snapshotId: 'missing' },
];
const images = new Map([
  ['s1', { body: PNG, contentType: 'image/png' }],
  ['webp', { body: Buffer.from('RIFF0000WEBPVP8 '), contentType: 'image/webp' }],
]);

/** Decompress all Flate streams so we can search the PDF text layer. */
function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1');
  let out = s;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    try {
      out += inflateSync(buf.subarray(start, end)).toString('latin1');
    } catch {
      /* not flate */
    }
  }
  return out;
}

describe('fonts', () => {
  it('bundled Noto Sans has the Kyrgyz letters Ү Ө Ң ү ө ң', () => {
    for (const f of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf']) {
      const font = fontkit.create(readFileSync(fileURLToPath(new URL(`../../assets/fonts/${f}`, import.meta.url))));
      expect(font.familyName).toBe('Noto Sans');
      for (const ch of 'ҮӨҢүөң') expect(font.hasGlyphForCodePoint(ch.codePointAt(0)!), `${f} ${ch}`).toBe(true);
    }
  });
});

describe('deck exporters', () => {
  it('renders a PPTX (zip) with all slide kinds', async () => {
    const buf = await renderPptx({ title: 'Клетка', slides, images });
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    expect(buf.toString('latin1')).toContain('ppt/slides/slide7.xml');
  });

  it('renders a PDF with embedded Noto Sans', async () => {
    const buf = await renderDeckPdf({ title: 'Клетка', slides, images });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const text = pdfText(buf);
    expect(text).toMatch(/NotoSans/);
    expect(text).toContain('/FontFile2');
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(slides.length);
  });

  it('renders an empty deck', async () => {
    expect((await renderDeckPdf({ title: 'Бош', slides: [], images: new Map() })).subarray(0, 4).toString()).toBe('%PDF');
    expect((await renderPptx({ title: 'Бош', slides: [], images: new Map() })).subarray(0, 2).toString()).toBe('PK');
  });

  it('renders login cards (8 per page) with Noto Sans', async () => {
    const cards = Array.from({ length: 9 }, (_, i) => ({ name: `Нургүл ${i}`, pin: i % 2 ? '123456' : undefined }));
    const buf = await renderLoginCards({ className: '7А', joinCode: 'ABC234', loginUrl: 'https://bilig.kg', lang: 'ky', cards });
    const text = pdfText(buf);
    expect(text).toMatch(/NotoSans/);
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(2);
  });
});

describe('slide builders', () => {
  it('template slides are deterministic and localized', () => {
    const ru = templateSlides(animalCellPackage, 'ru');
    expect(templateSlides(animalCellPackage, 'ru')).toEqual(ru);
    expect(ru[0].kind).toBe('title');
    expect(ru.filter((s) => s.kind === 'concept')).toHaveLength(animalCellPackage.topic.conceptKeys.length);
    expect(ru.filter((s) => s.kind === 'process')).toHaveLength(animalCellPackage.topic.activities.processKeys.length);
    expect(templateSlides(animalCellPackage, 'en')[0].kind === 'title' && templateSlides(animalCellPackage, 'en')[0]).toMatchObject({ title: expect.stringContaining(animalCellPackage.topic.title.en) });
  });

  it('LLM output is validated against the package', () => {
    expect(parseLlmSlides('[]', animalCellPackage)).toBeNull();
    expect(parseLlmSlides('[{"id":"a","kind":"title","title":"x"},{"id":"a","kind":"title","title":"y"}]', animalCellPackage)).toBeNull();
    expect(parseLlmSlides('```json\n[{"id":"a","kind":"title","title":"x"}]\n```', animalCellPackage)).toHaveLength(1);
    expect(parseLlmSlides('[{"id":"p","kind":"process","processKey":"nope","title":"x","steps":[]}]', animalCellPackage)).toBeNull();
    expect(llmSystemPrompt(animalCellPackage, 'ky')).toContain('Kyrgyz');
  });

  it('refusal falls back to template', async () => {
    const r = await llmSlides(new MockProvider(() => [{ type: 'refusal' }]), 'm', animalCellPackage, 'ru');
    expect(r.source).toBe('template');
    const ok = await llmSlides(new MockProvider(() => [{ type: 'text', text: '[{"id":"a","kind":"text","title":"x","text":"y"}]' }]), 'm', animalCellPackage, 'ru');
    expect(ok.source).toBe('llm');
  });
});
