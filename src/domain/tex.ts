/**
 * TeX → readable plain text for exports (slides, PDFs, lesson plans), where
 * formulas cannot be typeset: `T = 2\pi\sqrt{l/g}` → `T = 2π√(l/g)`,
 * `\ddot\theta = -\frac{g}{l}\sin\theta` → `θ̈ = -g/l·sin θ`.
 * Covers what school content uses; an unknown command keeps its name.
 * Plain text (no backslash) is returned unchanged.
 */
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', approx: '≈', sim: '~', neq: '≠', ne: '≠', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', leftrightarrow: '↔', rightleftharpoons: '⇌', infty: '∞', circ: '°',
  degree: '°', partial: '∂', sum: 'Σ', int: '∫', propto: '∝', ldots: '…', cdots: '…', dots: '…', angle: '∠', perp: '⊥', parallel: '∥',
  quad: '  ', qquad: '    ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '%': '%', '{': '{', '}': '}', '\\': ' ',
};
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'arcsin', 'arccos', 'arctan', 'ln', 'log', 'lg', 'exp', 'lim', 'max', 'min', 'sqrt']);
const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '⁺', n: 'ⁿ' };
const SUB: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '-': '₋', '+': '₊' };

/** One argument after position i: `{…}` (balanced) or a single char / command. Returns [text, nextIndex]. */
function arg(s: string, i: number): [string, number] {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
    if (m) return [m[0], i + m[0].length];
  }
  return [s[i] ?? '', i + 1];
}

/** `a` or `(a+b)`: parentheses only when the part is more than one token. */
const group = (x: string) => (/^[\p{L}\p{N}.,]+$/u.test(x) || /^\(.*\)$/.test(x) ? x : `(${x})`);
const script = (x: string, map: Record<string, string>, mark: string) =>
  [...x].every((c) => map[c]) ? [...x].map((c) => map[c]).join('') : `${mark}${group(x)}`;

export function texToText(tex: string): string {
  if (!tex.includes('\\') && !/[\^_{}]/.test(tex)) return tex;
  const conv = (s: string): string => {
    let out = '';
    for (let i = 0; i < s.length; ) {
      const c = s[i]!;
      if (c === '\\') {
        const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
        const name = m ? m[1]! : '';
        i += m ? m[0].length : 1;
        // A Greek letter binds to the variable after it (`\Delta H` → ΔH, `\Delta s` → Δs);
        // spaces around operators and arrows (`\to ZnCl_2`) stay as written.
        if (/^\p{L}$/u.test(SYMBOLS[name] ?? '') && /^ +[A-Za-z]/.test(s.slice(i))) while (s[i] === ' ') i++;
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
          const [a, j] = arg(s, i);
          const [b, k] = arg(s, j);
          i = k;
          const frac = `${group(conv(a))}/${group(conv(b))}`;
          // `1\tfrac12` → «1 1/2»; `\tfrac13 Sh`, `-\frac{g}{l}\sin` → «(1/3)Sh», «-(g/l) sin»
          const glued = /[\p{L}\p{N}\\(]/u.test(s[i] ?? '');
          out += (/\d$/.test(out) ? ' ' : '') + (glued && !/^\(.*\)$/.test(frac) ? `(${frac})` : frac);
        } else if (name === 'xrightarrow' || name === 'xleftarrow') {
          const [a, j] = arg(s, i);
          i = j;
          const label = conv(a).trim();
          out += `${name === 'xrightarrow' ? '→' : '←'}${label ? `(${label})` : ''}`;
        } else if (name === 'sqrt') {
          let n = '';
          if (s[i] === '[') {
            const end = s.indexOf(']', i);
            n = s.slice(i + 1, end);
            i = end + 1;
          }
          const [a, j] = arg(s, i);
          i = j;
          out += `${n ? script(n, SUP, '^') : ''}√${group(conv(a))}`;
        } else if (name === 'ddot' || name === 'dot' || name === 'vec' || name === 'bar' || name === 'hat') {
          const [a, j] = arg(s, i);
          i = j;
          const mark = { ddot: '̈', dot: '̇', vec: '⃗', bar: '̄', hat: '̂' }[name];
          out += conv(a) + mark;
        } else if (['text', 'mathrm', 'mathbf', 'mathit', 'operatorname', 'textrm', 'mbox'].includes(name)) {
          const [a, j] = arg(s, i);
          i = j;
          out += conv(a);
        } else if (name === 'left' || name === 'right' || name === 'displaystyle' || name === 'limits') {
          /* layout only */
        } else if (FUNCS.has(name)) out += (/[\p{L}\p{N})]$/u.test(out) ? ' ' : '') + name + ' ';
        else out += SYMBOLS[name] ?? name;
      } else if (c === '^' || c === '_') {
        const [a, j] = arg(s, i + 1);
        i = j;
        const v = conv(a);
        // degrees, primes and the like are already superscript glyphs
        out += c === '^' && /^[°′″*]$/.test(v) ? v : c === '^' ? script(v, SUP, '^') : script(v, SUB, '_');
      } else if (c === '{' || c === '}') i++;
      else {
        out += c;
        i++;
      }
    }
    return out;
  };
  return conv(tex).replace(/ +([,.;)])/g, '$1').replace(/[ \t]{3,}/g, '  ').trim();
}
