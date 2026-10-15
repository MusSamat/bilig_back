/** Injectable clock so lockouts, expiries and budgets are testable. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Test clock: starts at a fixed instant and only moves when told. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string = '2026-10-15T08:00:00Z') {
    this.t = new Date(start).getTime();
  }
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}
