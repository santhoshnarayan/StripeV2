//! PRNG used by the NBA simulator.
//!
//! Uses xoshiro256++ (via the `rand_xoshiro` crate) seeded through SplitMix64
//! — same pattern used by the NCAA Rust engine in
//! `explore/misc/sports/espn/mens-college-basketball/sim-engine-rs`.
//!
//! The TS engine uses xoshiro128**, so individual draws will not match
//! sample-by-sample. Aggregate distributions over thousands of sims will.

use rand_core::{RngCore, SeedableRng};
use rand_xoshiro::Xoshiro256PlusPlus;

#[derive(Clone)]
pub struct Rng {
    inner: Xoshiro256PlusPlus,
}

impl Rng {
    /// Construct a new RNG seeded via SplitMix64 expansion of the supplied
    /// `seed` (mirrors the NCAA Rust engine's seeding routine).
    pub fn new(seed: u64) -> Self {
        let mut z = seed;
        let mut s = [0u8; 32];
        for chunk in s.chunks_mut(8) {
            z = z.wrapping_add(0x9e3779b97f4a7c15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
            let v = x ^ (x >> 31);
            chunk.copy_from_slice(&v.to_le_bytes());
        }
        Self {
            inner: Xoshiro256PlusPlus::from_seed(s),
        }
    }

    #[inline]
    fn next_u64(&mut self) -> u64 {
        self.inner.next_u64()
    }

    /// Uniform float in `[0, 1)`.
    #[inline]
    pub fn random(&mut self) -> f64 {
        // 53-bit mantissa division.
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Box–Muller normal sample. Adds a tiny epsilon to `u1` to avoid `log(0)`,
    /// matching the JS engine's `+ 1e-10`.
    #[inline]
    pub fn normal(&mut self, mean: f64, stdev: f64) -> f64 {
        let u1 = self.random();
        let u2 = self.random();
        let z = (-2.0 * (u1 + 1e-10).ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
        mean + z * stdev
    }

    /// Gamma(shape, 1) sample via Marsaglia & Tsang's method, matching the
    /// JS implementation in `packages/sim/src/rng.ts`.
    pub fn gamma(&mut self, alpha: f64) -> f64 {
        if alpha < 1.0 {
            return self.gamma(alpha + 1.0) * (self.random() + 1e-10).powf(1.0 / alpha);
        }
        let d = alpha - 1.0 / 3.0;
        let c = 1.0 / (9.0 * d).sqrt();
        loop {
            let (x, v);
            loop {
                let xn = self.normal(0.0, 1.0);
                let vn = 1.0 + c * xn;
                if vn > 0.0 {
                    x = xn;
                    v = vn * vn * vn;
                    break;
                }
            }
            let u = self.random();
            if u < 1.0 - 0.0331 * (x * x) * (x * x) {
                return d * v;
            }
            if u.ln() < 0.5 * x * x + d * (1.0 - v + v.ln()) {
                return d * v;
            }
        }
    }

    /// In-place Dirichlet: writes `alphas.len()` proportions summing to 1
    /// into `out`. Avoids allocation in the sim hot loop.
    pub fn dirichlet_into(&mut self, alphas: &[f64], out: &mut [f64]) {
        let n = alphas.len();
        debug_assert!(out.len() >= n);
        let mut total = 0.0f64;
        for i in 0..n {
            let a = if alphas[i] < 1e-6 { 1e-6 } else { alphas[i] };
            let g = self.gamma(a);
            out[i] = g;
            total += g;
        }
        if total <= 0.0 {
            let inv = 1.0 / n as f64;
            for i in 0..n {
                out[i] = inv;
            }
            return;
        }
        let inv = 1.0 / total;
        for i in 0..n {
            out[i] *= inv;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_with_same_seed() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn dirichlet_sums_to_one() {
        let mut rng = Rng::new(7);
        let alphas = [1.0, 2.0, 3.0, 4.0];
        let mut out = [0.0f64; 4];
        rng.dirichlet_into(&alphas, &mut out);
        let s: f64 = out.iter().sum();
        assert!((s - 1.0).abs() < 1e-9);
    }

    #[test]
    fn normal_mean_close() {
        let mut rng = Rng::new(13);
        let n = 20_000;
        let mut sum = 0.0;
        for _ in 0..n {
            sum += rng.normal(5.0, 2.0);
        }
        let mean = sum / n as f64;
        assert!((mean - 5.0).abs() < 0.1, "mean {} not close to 5", mean);
    }
}
