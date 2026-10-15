/** Minimal RFC 4180 CSV parse/serialise (student import, string import/export). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((f) => f.trim())).filter((r) => r.some((f) => f !== ''));
}

const needsQuote = /[",;\n\r\t]/;
export const csvField = (v: string): string => (needsQuote.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: readonly (readonly string[])[]): string => rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';

const HEADER = /^(name|names|full ?name|display ?name|имя|ф\.?и\.?о\.?|фио|аты|аты-жөнү|ученик|student|фамилия)$/i;

/**
 * Student names from a CSV / pasted list. One student per line; when a row has
 * several columns (e.g. «Фамилия;Имя») they are joined with a space. A header
 * row is skipped. Names are trimmed, collapsed and capped at 80 chars.
 */
export function parseStudentNames(text: string): string[] {
  const rows = parseCsv(text);
  if (rows.length && rows[0].every((f) => HEADER.test(f) || f === '')) rows.shift();
  return rows
    .map((r) => r.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter((n) => n.length > 0);
}
