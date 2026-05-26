// Phase 4.5 timing bandit. Pure, deterministic-given-RNG functions. No I/O.
//
// Three coarse arms aligned to Phase 4's check-in buckets. Beta-Bernoulli
// posteriors with strong opinionated priors; Thompson sampling at plan time.
// The 30-day sliding window that drives non-stationarity lives in the caller
// (experiment-store.ts) — this module just consumes success/failure counts.

export type TimingArm = 'morning' | 'afternoon' | 'evening';

export const TIMING_ARMS: TimingArm[] = ['morning', 'afternoon', 'evening'];

export interface BetaPosterior {
  alpha: number;
  beta: number;
}

// Opinionated priors — gently favour morning/evening. Uniform priors waste
// scarce trials on pointless exploration at ~3 pulls/day.
export const TIMING_ARM_PRIORS: Record<TimingArm, BetaPosterior> = {
  morning: { alpha: 3, beta: 2 },
  afternoon: { alpha: 2, beta: 3 },
  evening: { alpha: 3, beta: 2 },
};

// Bucket boundaries match Phase 4 / quiet hours. 22:00–06:59 is quiet hours
// and has no arm.
export function armForHour(hour: number): TimingArm | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return null;
}

export function posteriorFor(
  arm: TimingArm,
  successes: number,
  failures: number,
): BetaPosterior {
  const prior = TIMING_ARM_PRIORS[arm];
  return {
    alpha: prior.alpha + successes,
    beta: prior.beta + failures,
  };
}

// Box-Muller standard normal. Discards one of the two normals each call —
// caching would save uniforms but complicates RNG injection for tests.
function standardNormal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Marsaglia–Tsang. For shape < 1, boost to shape+1 and rescale by U^(1/shape).
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    const g = sampleGamma(shape + 1, rng);
    const u = Math.max(rng(), Number.MIN_VALUE);
    return g * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Rejection loop. Squeeze step (u < 1 - 0.0331*x^4) accepts most draws
  // before the more expensive log check.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const x = standardNormal(rng);
    const cx1 = 1 + c * x;
    if (cx1 <= 0) continue;
    const v = cx1 * cx1 * cx1;
    const u = rng();
    const xsq = x * x;
    if (u < 1 - 0.0331 * xsq * xsq) return d * v;
    if (
      Math.log(Math.max(u, Number.MIN_VALUE)) <
      0.5 * xsq + d * (1 - v + Math.log(v))
    ) {
      return d * v;
    }
  }
}

// Beta(α, β) = X / (X + Y) with X ~ Gamma(α), Y ~ Gamma(β).
export function sampleBeta(
  p: BetaPosterior,
  rng: () => number = Math.random,
): number {
  const x = sampleGamma(p.alpha, rng);
  const y = sampleGamma(p.beta, rng);
  const total = x + y;
  if (total === 0) return 0.5; // degenerate; both draws underflowed
  return x / total;
}

// One Thompson draw per arm; arms ranked by draw descending. The fresh draw
// each call IS the exploration mechanism — no explicit explore/exploit knob.
export function thompsonRanking(
  posteriors: Record<TimingArm, BetaPosterior>,
  rng: () => number = Math.random,
): TimingArm[] {
  const draws = TIMING_ARMS.map<[TimingArm, number]>((arm) => [
    arm,
    sampleBeta(posteriors[arm], rng),
  ]);
  draws.sort((a, b) => b[1] - a[1]);
  return draws.map(([arm]) => arm);
}
