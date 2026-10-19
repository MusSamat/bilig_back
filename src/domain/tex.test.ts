import { describe, expect, it } from 'vitest';
import { texToText } from './tex.js';

describe('texToText', () => {
  it.each([
    ['T = 2\\pi\\sqrt{l/g}', 'T = 2π√(l/g)'],
    ['\\ddot\\theta = -\\frac{g}{l}\\sin\\theta,\\quad T = 2\\pi\\sqrt{l/g}', 'θ̈ = -(g/l) sin θ,  T = 2π√(l/g)'],
    ['Zn + 2HCl \\to ZnCl_2 + H_2', 'Zn + 2HCl → ZnCl₂ + H₂'],
    ['NH_4NO_3(s) \\to NH_4^+(aq) + NO_3^-(aq)', 'NH₄NO₃(s) → NH₄⁺(aq) + NO₃⁻(aq)'],
    ['C_6H_{12}O_6', 'C₆H₁₂O₆'],
    ['6H_2O \\xrightarrow{light} C_6H_{12}O_6', '6H₂O →(light) C₆H₁₂O₆'],
    ['\\Delta H > 0,\\;\\Delta T < 0', 'ΔH > 0, ΔT < 0'],
    ['v = \\frac{\\Delta s}{\\Delta t}', 'v = Δs/Δt'],
    ['V = \\tfrac{4}{3}\\pi r^3', 'V = (4/3)πr³'],
    ['h = 90^\\circ - \\varphi + \\delta', 'h = 90° - φ + δ'],
    ['ma = mg\\sin\\alpha - \\mu mg\\cos\\alpha', 'ma = mg sin α - μmg cos α'],
    ['I = \\frac{U}{R} = \\frac{4{,}5\\,В}{9\\,Ом}', 'I = U/R = (4,5 В)/(9 Ом)'],
    ['^{23}_{11}Na', '²³₁₁Na'],
    ['R = F - F_{fr}', 'R = F - F_fr'],
  ])('%s', (tex, text) => expect(texToText(tex)).toBe(text));

  it('leaves plain text alone', () => {
    expect(texToText('M = F·d')).toBe('M = F·d');
    expect(texToText('v = s/t')).toBe('v = s/t');
  });
});
