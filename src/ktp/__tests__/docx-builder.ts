/**
 * Test helper: build .docx files from raw WordprocessingML (PizZip), so КТП
 * fixtures live in code. Cell text: lines = paragraphs; inline markers wrap
 * runs the way Word does: `{{ins:…}}` (tracked insertion), `{{smart:…}}`
 * (smart tag), `{{link:…}}` (hyperlink), `{{del:…}}` (tracked deletion),
 * `{{tab}}`, `{{br}}`, `{{nbsp}}`; `{{split:…}}` splits text into one run per letter group.
 */
import PizZip from 'pizzip';

export type CellSpec =
  | string
  | {
      text?: string;
      span?: number;
      vMerge?: 'restart' | 'continue';
    };

export type BlockSpec = { p: string } | { table: CellSpec[][]; grid?: number[]; gridBefore?: Record<number, number> };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (t: string) => `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;

function runs(line: string): string {
  let out = '';
  const re = /\{\{(ins|smart|link|del|split):([^}]*)\}\}|\{\{(tab|br|nbsp)\}\}|([^{]+|\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[1] === 'ins') out += `<w:ins w:id="1" w:author="T" w:date="2026-09-01T00:00:00Z">${run(m[2])}</w:ins>`;
    else if (m[1] === 'smart') out += `<w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="place">${run(m[2])}</w:smartTag>`;
    else if (m[1] === 'link') out += `<w:hyperlink r:id="rId99">${run(m[2])}</w:hyperlink>`;
    else if (m[1] === 'del') out += `<w:del w:id="2" w:author="T" w:date="2026-09-01T00:00:00Z"><w:r><w:delText>${esc(m[2])}</w:delText></w:r></w:del>`;
    else if (m[1] === 'split') out += m[2].match(/.{1,3}/gu)!.map(run).join('');
    else if (m[3] === 'tab') out += '<w:r><w:tab/></w:r>';
    else if (m[3] === 'br') out += '<w:r><w:br/></w:r>';
    else if (m[3] === 'nbsp') out += run(' ');
    else out += run(m[4]);
  }
  return out;
}

export const para = (line: string) => `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${runs(line)}</w:p>`;

function cell(c: CellSpec): string {
  const spec = typeof c === 'string' ? { text: c } : c;
  const pr = `${spec.span && spec.span > 1 ? `<w:gridSpan w:val="${spec.span}"/>` : ''}${spec.vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : spec.vMerge === 'continue' ? '<w:vMerge/>' : ''}`;
  const lines = (spec.text ?? '').split('\n');
  return `<w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/>${pr}</w:tcPr>${lines.map(para).join('')}</w:tc>`;
}

function table(rows: CellSpec[][], grid?: number[], gridBefore: Record<number, number> = {}): string {
  const cols = grid ?? Array(Math.max(...rows.map((r) => r.reduce((s: number, c) => s + (typeof c === 'string' ? 1 : (c.span ?? 1)), 0)))).fill(1200);
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    rows
      .map((r, i) => `<w:tr>${gridBefore[i] ? `<w:trPr><w:gridBefore w:val="${gridBefore[i]}"/></w:trPr>` : ''}${r.map(cell).join('')}</w:tr>`)
      .join('') +
    '</w:tbl>'
  );
}

export function documentXml(blocks: BlockSpec[]): string {
  const body = blocks.map((b) => ('p' in b ? para(b.p) : table(b.table, b.grid, b.gridBefore))).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
  );
}

export function zipDocx(files: Record<string, string | Buffer>, compression: 'DEFLATE' | 'STORE' = 'DEFLATE'): Buffer {
  const zip = new PizZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generate({ type: 'nodebuffer', compression }) as Buffer;
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

export function buildDocx(blocks: BlockSpec[]): Buffer {
  return zipDocx({ '[Content_Types].xml': CONTENT_TYPES, '_rels/.rels': RELS, 'word/document.xml': documentXml(blocks) });
}

/** Text of a generated .docx: paragraphs (w:br → '\n'), tables as `| a | b |` rows. */
export function dumpDocx(buf: Buffer): string[] {
  const xml = new PizZip(buf).file('word/document.xml')!.asText();
  const out: string[] = [];
  const text = (s: string) =>
    (s.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:br(?:\s[^>]*)?\/>/g) ?? [])
      .map((x) => (x.startsWith('<w:br') ? (/w:type="page"/.test(x) ? '\f' : '\n') : x.replace(/<[^>]+>/g, '')))
      .join('')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  const body = xml.slice(xml.indexOf('<w:body>'));
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>|<w:p\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const el = m[0];
    if (el.startsWith('<w:tbl')) {
      for (const tr of el.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [])
        out.push('| ' + (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => (tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []).map(text).join('\n')).join(' | ') + ' |');
    } else out.push(text(el));
  }
  return out;
}
