import { describe, expect, it } from 'vitest';
import { contentDisposition } from './route.js';

describe('contentDisposition', () => {
  it('keeps plain ASCII names as they are', () => {
    expect(contentDisposition('cards.pdf')).toBe('attachment; filename="cards.pdf"');
  });

  it('transliterates Cyrillic (incl. Kyrgyz letters) in the fallback and keeps the exact name in filename*', () => {
    const h = contentDisposition('plan_8б_2026-09-01_1.docx');
    expect(h).toContain('filename="plan_8b_2026-09-01_1.docx"');
    expect(h).toContain("filename*=UTF-8''plan_8%D0%B1_2026-09-01_1.docx");
    expect(contentDisposition('Ңөү Шаар.docx')).toContain('filename="Ngou_Shaar.docx"');
  });
});
