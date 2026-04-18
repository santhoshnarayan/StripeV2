/**
 * Seedable PRNG using xoshiro128** — fast, high-quality, deterministic.
 * Ported from the explore repo's playoff simulator.
 */
export class RNG {
  private s: Uint32Array;

  constructor(seed: number) {
    this.s = new Uint32Array(4);
    this.s[0] = seed >>> 0;
    this.s[1] = (seed * 1664525 + 1013904223) >>> 0;
    this.s[2] = (this.s[1] * 1664525 + 1013904223) >>> 0;
    this.s[3] = (this.s[2] * 1664525 + 1013904223) >>> 0;
  }

  private next(): number {
    const s = this.s;
    const result = (Math.imul(s[1] * 5, 7) >>> 0) | 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return (result >>> 0) / 4294967296;
  }

  random(): number {
    return this.next();
  }

  normal(mean: number, std: number): number {
    const u1 = this.next();
    const u2 = this.next();
    const z =
      Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
    return mean + z * std;
  }

  /** Gamma(alpha, 1) sample via Marsaglia and Tsang's method. */
  gamma(alpha: number): number {
    if (alpha < 1) {
      return this.gamma(alpha + 1) * Math.pow(this.random() + 1e-10, 1 / alpha);
    }
    const d = alpha - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal(0, 1);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.random();
      if (
        u < 1 - 0.0331 * (x * x) * (x * x) ||
        Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))
      ) {
        return d * v;
      }
    }
  }

  /** Dirichlet sample: returns an array of proportions summing to 1. */
  dirichlet(alphas: number[]): number[] {
    const samples = alphas.map((a) => this.gamma(Math.max(a, 1e-6)));
    const total = samples.reduce((s, v) => s + v, 0);
    if (total <= 0) return alphas.map(() => 1 / alphas.length);
    return samples.map((s) => s / total);
  }

  /** In-place Dirichlet: writes `len` proportions (summing to 1) into `out`.
   *  `alphas` is read for the first `len` entries. Avoids allocation in the
   *  sim hot loop. */
  dirichletInto(alphas: Float64Array, out: Float64Array, len: number): void {
    let total = 0;
    for (let i = 0; i < len; i++) {
      const g = this.gamma(alphas[i] < 1e-6 ? 1e-6 : alphas[i]);
      out[i] = g;
      total += g;
    }
    if (total <= 0) {
      const inv = 1 / len;
      for (let i = 0; i < len; i++) out[i] = inv;
      return;
    }
    const inv = 1 / total;
    for (let i = 0; i < len; i++) out[i] *= inv;
  }
}
