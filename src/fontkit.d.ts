/** Minimal types for fontkit (a pdfkit dependency): only what the PDF exports use. */
declare module 'fontkit' {
  export interface Font {
    hasGlyphForCodePoint(codePoint: number): boolean;
  }
  export function create(buffer: Buffer, postscriptName?: string): Font;
}
