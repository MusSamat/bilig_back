/**
 * Safe .docx reader for uploaded КТП files (untrusted zip).
 *
 * - Own minimal zip reader over node:zlib: PK magic, the central directory is
 *   the only source of truth, entry-count and declared-size caps, encrypted /
 *   zip64 / unknown-method entries rejected, and every inflate is bounded with
 *   `maxOutputLength` (a lying header cannot blow up memory).
 * - Only `word/document.xml` is read. Nothing is executed.
 * - XML is tokenised without DTD processing: a DOCTYPE/ENTITY is rejected,
 *   only the five predefined entities and numeric references are decoded.
 *
 * The result is a flat list of blocks: paragraphs (text) and tables with
 * `gridSpan` / `vMerge` / `gridBefore` resolved onto the table grid. Cell
 * text = the cell's paragraphs joined with '\n'; every run of a paragraph
 * counts, whatever wraps it (w:ins, w:smartTag, w:hyperlink, w:sdt, w:fldSimple …).
 */
import { inflateRawSync } from 'node:zlib';

export interface DocxLimits {
  /** Max compressed file size. */
  maxBytes: number;
  /** Max sum of declared uncompressed sizes over all entries. */
  maxTotalUncompressed: number;
  /** Max uncompressed size of word/document.xml. */
  maxDocumentXml: number;
  maxEntries: number;
}

export const DEFAULT_DOCX_LIMITS: DocxLimits = {
  maxBytes: 4 * 1024 * 1024,
  maxTotalUncompressed: 30 * 1024 * 1024,
  maxDocumentXml: 20 * 1024 * 1024,
  maxEntries: 2000,
};

export type DocxErrorCode = 'not_docx' | 'too_large' | 'corrupt' | 'unsupported';

export class DocxError extends Error {
  constructor(
    readonly code: DocxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocxError';
  }
}

export interface GridCell {
  text: string;
  /** Continuation of a horizontally merged cell (gridSpan); `text` repeats the origin's. */
  colSpanned: boolean;
  /** Continuation of a vertically merged cell (vMerge); `text` repeats the origin's. */
  rowSpanned: boolean;
}

export interface DocxTable {
  cols: number;
  rows: GridCell[][];
}

export type DocxBlock = { kind: 'p'; text: string } | { kind: 'table'; table: DocxTable };

export interface DocxDocument {
  blocks: DocxBlock[];
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function listEntries(buf: Buffer, limits: DocxLimits): ZipEntry[] {
  // End of central directory: the last 22..(22+65535) bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxError('corrupt', 'zip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new DocxError('unsupported', 'zip64 is not supported');
  if (count > limits.maxEntries) throw new DocxError('too_large', `zip: more than ${limits.maxEntries} entries`);
  if (cdOffset + cdSize > buf.length) throw new DocxError('corrupt', 'zip: central directory out of bounds');
  const out: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new DocxError('corrupt', 'zip: bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new DocxError('corrupt', 'zip: entry name out of bounds');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new DocxError('unsupported', 'zip64 is not supported');
    total += size;
    if (total > limits.maxTotalUncompressed) throw new DocxError('too_large', 'zip: uncompressed size over the limit');
    out.push({ name, method, flags, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry, cap: number): Buffer {
  if (e.flags & 0x1) throw new DocxError('unsupported', 'zip: encrypted entry');
  if (e.size > cap) throw new DocxError('too_large', `zip: ${e.name} is larger than ${cap} bytes`);
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) throw new DocxError('corrupt', 'zip: bad local header');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new DocxError('corrupt', 'zip: entry data out of bounds');
  const data = buf.subarray(start, end);
  let out: Buffer;
  if (e.method === 0) out = Buffer.from(data);
  else if (e.method === 8) {
    try {
      // Bounded: never more than the declared size (+1 to detect a lying header), never more than the cap.
      out = inflateRawSync(data, { maxOutputLength: Math.min(cap, e.size) + 1 });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String((err as Error).message)))
        throw new DocxError('too_large', `zip: ${e.name} inflates beyond its declared size`);
      throw new DocxError('corrupt', `zip: cannot inflate ${e.name}`);
    }
  } else throw new DocxError('unsupported', `zip: compression method ${e.method}`);
  if (out.length !== e.size) throw new DocxError('too_large', `zip: ${e.name} size does not match its header`);
  return out;
}

/** Read one entry from an untrusted zip with all the checks; null when the entry is absent. */
export function unzipEntry(buf: Buffer, name: string, limits: DocxLimits = DEFAULT_DOCX_LIMITS): Buffer | null {
  if (buf.length > limits.maxBytes) throw new DocxError('too_large', `file is larger than ${limits.maxBytes} bytes`);
  if (buf.length < 30 || buf.readUInt32LE(0) !== SIG_LOCAL) throw new DocxError('not_docx', 'not a .docx (zip) file');
  const entries = listEntries(buf, limits);
  const e = entries.find((x) => x.name === name);
  return e ? readEntry(buf, e, limits.maxDocumentXml) : null;
}

export function readDocx(buf: Buffer, limits: DocxLimits = DEFAULT_DOCX_LIMITS): DocxDocument {
  const xml = unzipEntry(buf, 'word/document.xml', limits);
  if (!xml) throw new DocxError('not_docx', 'word/document.xml is missing');
  return parseDocumentXml(xml.toString('utf8'));
}

// ---------------------------------------------------------------------------
// XML → blocks
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,4});/g, (m, g: string) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[g] ?? m;
  });
}

/** Normalise a line of cell/paragraph text: nbsp, tabs, soft hyphens, zero-width chars, repeated spaces. */
export function normalizeText(s: string): string {
  return s
    .replace(/[   \t]/g, ' ')
    .replace(/[­​-‍﻿]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

interface RawCell {
  paras: string[];
  span: number;
  vMerge: 'restart' | 'continue' | null;
}
interface RawRow {
  before: number;
  cells: RawCell[];
}
interface RawTable {
  gridCols: number;
  rows: RawRow[];
}

/**
 * Streaming pass over WordprocessingML. Top-level tables become table blocks;
 * nested tables flatten into the enclosing cell's text.
 */
export function parseDocumentXml(xml: string): DocxDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new DocxError('corrupt', 'DTDs are not allowed in document.xml');
  const blocks: DocxBlock[] = [];
  const tables: RawTable[] = [];
  let cell: RawCell | null = null;
  const cellStack: (RawCell | null)[] = [];
  let para: string[] | null = null; // current paragraph's lines
  let inText = false;
  let skipDepth = 0; // inside mc:Fallback / w:moveFrom / w:del: ignore text
  let tcPr = false;
  let tabStops = false; // <w:tabs> in paragraph properties: tab stops, not text

  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[6] !== undefined || m[1] !== undefined) {
      if (inText && para && !skipDepth) para[para.length - 1] += decodeEntities(m[6] ?? m[1] ?? '');
      continue;
    }
    const name = m[3];
    if (!name) continue;
    const closing = m[2] === '/';
    const selfClosing = m[5] === '/';
    const raw = m[0];

    if (name === 'mc:Fallback' || name === 'w:moveFrom' || name === 'w:del') {
      if (closing) skipDepth = Math.max(0, skipDepth - 1);
      else if (!selfClosing) skipDepth++;
      continue;
    }

    switch (name) {
      case 'w:tbl':
        if (!closing) {
          tables.push({ gridCols: 0, rows: [] });
          cellStack.push(cell);
          cell = null;
        } else {
          const t = tables.pop();
          cell = cellStack.pop() ?? null;
          if (!t) break;
          if (tables.length === 0 && !cell) blocks.push({ kind: 'table', table: resolveGrid(t) });
          else if (cell) {
            // nested table: append its text to the enclosing cell
            for (const r of t.rows) for (const c of r.cells) cell.paras.push(...c.paras);
          }
        }
        break;
      case 'w:gridCol':
        if (!closing && tables.length) tables[tables.length - 1].gridCols++;
        break;
      case 'w:tr':
        if (!closing && tables.length) tables[tables.length - 1].rows.push({ before: 0, cells: [] });
        break;
      case 'w:gridBefore':
        if (!closing && tables.length) {
          const rows = tables[tables.length - 1].rows;
          if (rows.length) rows[rows.length - 1].before = Math.max(0, Math.min(64, Number(attr(raw, 'w:val')) || 0));
        }
        break;
      case 'w:tc':
        if (!closing) {
          cell = { paras: [], span: 1, vMerge: null };
          const rows = tables[tables.length - 1]?.rows;
          if (rows?.length) rows[rows.length - 1].cells.push(cell);
        } else cell = null;
        break;
      case 'w:tcPr':
        tcPr = !closing && !selfClosing;
        break;
      case 'w:gridSpan':
        if (!closing && cell && tcPr) cell.span = Math.max(1, Math.min(64, Number(attr(raw, 'w:val')) || 1));
        break;
      case 'w:vMerge':
        if (!closing && cell && tcPr) cell.vMerge = attr(raw, 'w:val') === 'restart' ? 'restart' : 'continue';
        break;
      case 'w:p':
        if (!closing) {
          if (selfClosing) {
            if (cell) cell.paras.push('');
            else if (!tables.length) blocks.push({ kind: 'p', text: '' });
          } else para = [''];
        } else if (para) {
          const lines = para.map(normalizeText);
          if (cell) cell.paras.push(...lines);
          else if (!tables.length) blocks.push({ kind: 'p', text: lines.filter(Boolean).join('\n') });
          para = null;
        }
        break;
      case 'w:t':
        inText = !closing && !selfClosing;
        break;
      case 'w:tabs':
        tabStops = !closing && !selfClosing;
        break;
      case 'w:tab':
      case 'w:ptab':
        if (!closing && para && !skipDepth && !tabStops) para[para.length - 1] += ' ';
        break;
      case 'w:br':
      case 'w:cr':
        if (!closing && para && !skipDepth) para.push('');
        break;
      case 'w:noBreakHyphen':
        if (!closing && para && !skipDepth) para[para.length - 1] += '-';
        break;
      default:
        break;
    }
  }
  return { blocks };
}

function cellText(c: RawCell): string {
  return c.paras
    .map(normalizeText)
    .filter((l) => l.length > 0)
    .join('\n');
}

function resolveGrid(t: RawTable): DocxTable {
  const width = Math.max(t.gridCols, ...t.rows.map((r) => r.before + r.cells.reduce((s, c) => s + c.span, 0)), 0);
  const rows: GridCell[][] = [];
  for (const r of t.rows) {
    const out: GridCell[] = Array.from({ length: width }, () => ({ text: '', colSpanned: false, rowSpanned: false }));
    let col = r.before;
    for (const c of r.cells) {
      if (col >= width) break;
      let text = cellText(c);
      const rowSpanned = c.vMerge === 'continue' && rows.length > 0;
      if (rowSpanned) text = rows[rows.length - 1][col]?.text ?? '';
      for (let k = 0; k < c.span && col + k < width; k++) out[col + k] = { text, colSpanned: k > 0, rowSpanned };
      col += c.span;
    }
    rows.push(out);
  }
  return { cols: width, rows };
}
