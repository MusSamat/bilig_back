/** pdfkit helpers: document with embedded Noto Sans, collected into a Buffer. */
import PDFDocument from 'pdfkit';
import { notoSans } from './fonts.js';

export type Pdf = InstanceType<typeof PDFDocument>;

export function createPdf(opts: { layout?: 'portrait' | 'landscape'; title: string }): { doc: Pdf; done: Promise<Buffer> } {
  const doc = new PDFDocument({ size: 'A4', layout: opts.layout ?? 'portrait', margin: 36, info: { Title: opts.title, Producer: 'Bilig', Creator: 'Bilig' } });
  const fonts = notoSans();
  doc.registerFont('body', fonts.regular);
  doc.registerFont('bold', fonts.bold);
  doc.font('body');
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
}
