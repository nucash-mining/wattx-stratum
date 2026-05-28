// Variable difficulty — adjusts each miner's share target to keep submission
// rate near targetTime seconds/share.  Works for any stratum variant.

const ALGORITHM_DEFAULTS = {
  sha256d:        { initial: 512,   min: 1,       max: 2_000_000 },
  scrypt:         { initial: 0.01,  min: 0.001,   max: 10_000   },
  x11:            { initial: 0.01,  min: 0.001,   max: 10_000   },
  equihash_200_9: { initial: 8,     min: 1,       max: 100_000  },
  kheavyhash:     { initial: 1000,  min: 1,       max: 1_000_000_000 },
  randomx:        { initial: 5000,  min: 100,     max: 10_000_000 },
  ethash:         { initial: 4,     min: 1,       max: 32_000   },
};

class VarDiff {
  /**
   * @param {object} opts
   * @param {number} opts.targetTime       - desired seconds per share (default 30)
   * @param {number} opts.retargetTime     - seconds between retarget checks (default 90)
   * @param {number} opts.variance         - tolerance before retargeting, 0–1 (default 0.25)
   * @param {number} opts.maxStep          - max multiplier per retarget (default 4)
   * @param {number} opts.minDiff
   * @param {number} opts.maxDiff
   */
  constructor(opts = {}) {
    this.targetTime  = opts.targetTime  ?? 30;
    this.retargetTime = opts.retargetTime ?? 90;
    this.variance    = opts.variance    ?? 0.25;
    this.maxStep     = opts.maxStep     ?? 4;
    this.minDiff     = opts.minDiff     ?? 1;
    this.maxDiff     = opts.maxDiff     ?? 2_000_000;
  }

  static defaultsFor(algorithm) {
    return ALGORITHM_DEFAULTS[algorithm] || ALGORITHM_DEFAULTS.sha256d;
  }

  /**
   * Call on each accepted share.
   * Returns the new difficulty if a retarget is warranted, null otherwise.
   * Mutates client._vd (state bag, not visible to miners).
   */
  onShare(client) {
    const now = Date.now() / 1000;
    if (!client._vd) client._vd = { shares: [], lastRetarget: now };
    const vd = client._vd;
    vd.shares.push(now);

    // Trim share history older than 1.5× the retarget window
    const cutoff = now - this.retargetTime * 1.5;
    while (vd.shares.length > 0 && vd.shares[0] < cutoff) vd.shares.shift();

    if (now - vd.lastRetarget < this.retargetTime) return null;
    vd.lastRetarget = now;

    if (vd.shares.length < 2) return null;

    const elapsed    = vd.shares[vd.shares.length - 1] - vd.shares[0];
    const actualTime = elapsed / (vd.shares.length - 1);
    const ratio      = actualTime / this.targetTime;

    if (Math.abs(1 - ratio) <= this.variance) return null;

    // ratio < 1 → shares too fast → raise difficulty (factor > 1)
    // ratio > 1 → shares too slow → lower difficulty (factor < 1)
    const factor  = Math.min(Math.max(1 / ratio, 1 / this.maxStep), this.maxStep);
    const newDiff = Math.min(Math.max(client.difficulty * factor, this.minDiff), this.maxDiff);

    // Round to 4 significant figures to avoid noisy micro-adjustments
    const rounded = parseFloat(newDiff.toPrecision(4));
    if (rounded === client.difficulty) return null;
    return rounded;
  }
}

module.exports = VarDiff;
module.exports.ALGORITHM_DEFAULTS = ALGORITHM_DEFAULTS;
