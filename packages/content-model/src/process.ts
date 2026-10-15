/**
 * Processes (TZ W-40..W-43, A-08): standalone entities, reusable across topics.
 * The engine (`timeline`, `stoich`, `ode`) is provided by a plugin; metric
 * values come from the plugin's readouts(), never hand-drawn numbers.
 */
import { z } from 'zod';
import { KeySchema } from './common.js';
import { LocalizedSchema } from './i18n.js';

export const PROCESS_ENGINES = ['timeline', 'stoich', 'ode'] as const;
export const ProcessEngineSchema = z.enum(PROCESS_ENGINES);
export type ProcessEngine = z.infer<typeof ProcessEngineSchema>;

export const ProcessStepSchema = z.object({
  key: KeySchema,
  title: LocalizedSchema,
  /** Result of the step (W-42 «результат шага»), e.g. «2 АТФ». */
  result: LocalizedSchema.optional(),
  description: LocalizedSchema,
  /** Structure highlighted in 3D while this step is current (W-42). */
  conceptKey: KeySchema.optional(),
  /** Required alt text for accessibility (publish checklist). */
  altText: LocalizedSchema,
  /** Relative duration in seconds at 1× speed; defaults to 1 in the player. */
  duration: z.number().positive().optional(),
});
export type ProcessStep = z.infer<typeof ProcessStepSchema>;

export const ProcessMetricSchema = z.object({
  key: KeySchema,
  label: LocalizedSchema,
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Display precision (fraction digits). */
  precision: z.number().int().min(0).max(6).optional(),
});
export type ProcessMetric = z.infer<typeof ProcessMetricSchema>;

export const ProcessSchema = z.object({
  key: KeySchema,
  engine: ProcessEngineSchema,
  title: LocalizedSchema,
  icon: z.string().min(1),
  description: LocalizedSchema,
  /** Bare TeX, e.g. `C_6H_{12}O_6 + 6O_2 \\to 6CO_2 + 6H_2O`. */
  equation: z.string().optional(),
  /** «На входе» (W-43). */
  inputs: LocalizedSchema,
  /** «На выходе». */
  outputs: LocalizedSchema,
  energy: LocalizedSchema.optional(),
  steps: z.array(ProcessStepSchema).min(1),
  /** Metric definitions; values are produced by the engine plugin (W-43). */
  metrics: z.array(ProcessMetricSchema),
  /** Engine parameters (ode coefficients, stoichiometry, …). */
  params: z.record(z.string(), z.number()).optional(),
});
export type Process = z.infer<typeof ProcessSchema>;

// ---------------------------------------------------------------------------
// v0.3.0: engine parameter conventions (A-08). `Process.params` stays an open
// number map; these are the keys the engines read. Unknown keys are kept as
// domain parameters (e.g. `emf`, `resistance`, `radius` for the sim plugin).
// ---------------------------------------------------------------------------

export interface EngineParamConvention {
  /** Literal key, or a pattern with `<metric>`, `<step>`, `<species>` placeholders. */
  key: string;
  description: string;
}

export const ENGINE_PARAMS: Readonly<Record<ProcessEngine, readonly EngineParamConvention[]>> = {
  timeline: [
    {
      key: '<metric>@<step>',
      description:
        'Cumulative target of metric <metric> at the END of step <step> (e.g. `atp@glycolysis`: 2). The player interpolates between targets; without targets a metric runs from min to max over the summed step durations.',
    },
  ],
  stoich: [
    { key: 'n0.<species>', description: 'Initial amount (mol) of a species.' },
    { key: 'nu.<species>', description: 'Stoichiometric coefficient: negative for reactants, positive for products.' },
    {
      key: '<species>',
      description:
        'Content form (alternative to n0./nu.): the coefficient of a species from the equation; reactants and products are taken from the equation sides.',
    },
    { key: 'M_<species>', description: 'Molar mass of a species, g/mol (content form).' },
    { key: 'dH_kJ', description: 'Reaction enthalpy, kJ per mole of reaction (negative = exothermic).' },
  ],
  ode: [
    { key: 'omega', description: 'Natural angular frequency, rad/s.' },
    { key: 'zeta', description: 'Damping ratio (0 = undamped).' },
    { key: 'x0', description: 'Initial displacement.' },
    { key: 'v0', description: 'Initial velocity.' },
    { key: 'mass', description: 'Mass, kg (energy readouts).' },
  ],
};

/** Key of a per-step cumulative target for the `timeline` engine. */
export const stepTargetKey = (metricKey: string, stepKey: string): string => `${metricKey}@${stepKey}`;

/** Per-step targets of one metric (`<metric>@<step>` keys), in step order; steps without a target are omitted. */
export function stepTargets(process: Pick<Process, 'params' | 'steps'>, metricKey: string): { stepKey: string; value: number }[] {
  const params = process.params ?? {};
  return process.steps.flatMap((s) => {
    const v = params[stepTargetKey(metricKey, s.key)];
    return typeof v === 'number' ? [{ stepKey: s.key, value: v }] : [];
  });
}
