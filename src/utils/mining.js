'use strict';
const BN = require('bn.js');

// Bitcoin pdiff-1 target (big-endian 32-byte number)
const DIFF1 = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

/**
 * Convert pool difficulty (float or integer) to a 32-byte big-endian target Buffer.
 * Uses Bitcoin's pdiff formula:  target = DIFF1 / difficulty
 */
function diffToTarget(difficulty) {
  if (difficulty <= 0) throw new RangeError(`difficulty must be > 0, got ${difficulty}`);
  // Scale by 2^24 to safely handle float difficulties (e.g. 0.001)
  const SCALE = 1n << 24n;
  const scaledDiff = BigInt(Math.max(1, Math.round(difficulty * Number(SCALE))));
  let target = (DIFF1 * SCALE) / scaledDiff;
  if (target >= (1n << 256n)) target = (1n << 256n) - 1n;
  return Buffer.from(target.toString(16).padStart(64, '0'), 'hex');
}

/**
 * Returns true if the hash meets the target.
 * hashBuf : Buffer – raw output of the PoW hash function
 * targetBuf: Buffer – 32-byte big-endian target from diffToTarget / bitsToTarget
 * hashIsLE : bool   – true for Bitcoin-style hashes (internal/LE byte order, must reverse);
 *                     false for Kaspa/blake3 (natural/BE byte order, compare directly)
 */
function hashMeetsTarget(hashBuf, targetBuf, hashIsLE = true) {
  const hashBN = hashIsLE
    ? new BN(Buffer.from(hashBuf).reverse())  // copy then reverse LE → BE
    : new BN(hashBuf);                         // already BE (Kaspa)
  return hashBN.lte(new BN(targetBuf));
}

/** Compact nBits → 32-byte big-endian target Buffer (same as Bitcoin block header). */
function bitsToTarget(bits) {
  const n    = parseInt(bits, 16);
  const exp  = n >> 24;
  const mant = n & 0xffffff;
  return new BN(mant).shln(8 * (exp - 3)).toBuffer('be', 32);
}

module.exports = { diffToTarget, hashMeetsTarget, bitsToTarget };
