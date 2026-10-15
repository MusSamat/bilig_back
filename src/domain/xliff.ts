/** XLIFF 1.2 export and 1.2 / 2.0 import for the translation workspace (A-11). */
export interface XliffUnit {
  id: string;
  source: string;
  target: string;
}

export const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function xmlUnescape(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function toXliff(units: readonly XliffUnit[], sourceLang: string, targetLang: string, original = 'bilig'): string {
  const body = units
    .map(
      (u) =>
        `      <trans-unit id="${xmlEscape(u.id)}" xml:space="preserve">\n        <source>${xmlEscape(u.source)}</source>\n        <target>${xmlEscape(u.target)}</target>\n      </trans-unit>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n  <file original="${xmlEscape(original)}" source-language="${xmlEscape(sourceLang)}" target-language="${xmlEscape(targetLang)}" datatype="plaintext">\n    <body>\n${body}\n    </body>\n  </file>\n</xliff>\n`;
}

const inner = (block: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  if (m) return xmlUnescape(m[1]);
  return new RegExp(`<${tag}(?:\\s[^>]*)?/>`).test(block) ? '' : undefined;
};

/** Parse XLIFF 1.2 (`<trans-unit>`) or 2.0 (`<unit>`/`<segment>`). DTD/entities are not expanded. */
export function parseXliff(xml: string): XliffUnit[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD not allowed');
  const out: XliffUnit[] = [];
  const re = /<(trans-unit|unit)\s[^>]*?\bid="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const target = inner(m[3], 'target');
    out.push({ id: xmlUnescape(m[2]), source: inner(m[3], 'source') ?? '', target: target ?? '' });
  }
  return out;
}
