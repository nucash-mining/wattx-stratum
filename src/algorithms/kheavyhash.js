'use strict';
// kHeavyHash — Kaspa proof of work
// Spec: https://github.com/kaspanet/kaspad/blob/master/domain/consensus/utils/pow/pow.go
// Requires @noble/hashes for blake3 (pure JS, no native build needed).
//
// Algorithm:
//   1. matrix  = generateMatrix(prePowHash)  — 64×64 ternary matrix from XoShiRo256++ PRNG
//   2. heavy   = heavyHash(matrix, prePowHash) — matrix-vector product (nibbles, mod 3) XOR hash
//   3. powHash = blake3(heavy XOR nonce_LE8_padded_to_32)
//   4. powHash (BE) ≤ target

const { hashMeetsTarget } = require('../utils/mining');

let blake3fn;
try {
  ({ blake3: blake3fn } = require('@noble/hashes/blake3'));
} catch (_) {}

// ---- XoShiRo256++ PRNG -------------------------------------------------------

function rotl64(x, k) {
  return BigInt.asUintN(64, (x << BigInt(k)) | (x >> BigInt(64 - k)));
}

class XoShiRo256PlusPlus {
  constructor(seedBytes) {
    this.s = new Array(4);
    for (let i = 0; i < 4; i++) {
      const lo = BigInt(seedBytes.readUInt32LE(i * 8));
      const hi = BigInt(seedBytes.readUInt32LE(i * 8 + 4));
      this.s[i] = lo | (hi << 32n);
    }
  }

  next() {
    const [s0, s1, s2, s3] = this.s;
    const result = BigInt.asUintN(64, rotl64(s0 + s3, 23) + s0);
    const t = BigInt.asUintN(64, s1 << 17n);
    this.s[2] = BigInt.asUintN(64, s2 ^ s0);
    this.s[3] = BigInt.asUintN(64, s3 ^ s1);
    this.s[1] = BigInt.asUintN(64, s1 ^ this.s[2]);
    this.s[0] = BigInt.asUintN(64, s0 ^ this.s[3]);
    this.s[2] = BigInt.asUintN(64, this.s[2] ^ t);
    this.s[3] = rotl64(this.s[3], 45);
    return result;
  }
}

// ---- GF(3) rank check --------------------------------------------------------

function matrixRankGF3(mat) {
  const m = mat.map((row) => Uint8Array.from(row));
  const n = 64;
  let rank = 0;
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let row = rank; row < n; row++) {
      if (m[row][col] !== 0) { pivot = row; break; }
    }
    if (pivot === -1) continue;
    if (pivot !== rank) { const tmp = m[rank]; m[rank] = m[pivot]; m[pivot] = tmp; }
    // Scale pivot row (inv(1)=1, inv(2)=2 in GF(3))
    const inv = m[rank][col] === 1 ? 1 : 2;
    for (let j = 0; j < n; j++) m[rank][j] = (m[rank][j] * inv) % 3;
    // Eliminate column in all other rows
    for (let row = 0; row < n; row++) {
      if (row !== rank && m[row][col] !== 0) {
        const f = m[row][col];
        for (let j = 0; j < n; j++) m[row][j] = ((m[row][j] - f * m[rank][j]) % 3 + 3) % 3;
      }
    }
    rank++;
  }
  return rank;
}

// ---- Matrix generation -------------------------------------------------------

/**
 * Generate a full-rank 64×64 ternary matrix seeded from prePowHash.
 * Returns Array[64] of Uint16Array[64] with values in {0, 1, 2}.
 * Caches the result keyed by prePowHash hex — one matrix per job template.
 */
const _matCache = new Map(); // prePowHex → matrix

function generateMatrix(prePowHashBytes) {
  const key = prePowHashBytes.toString('hex');
  if (_matCache.has(key)) return _matCache.get(key);

  const rng = new XoShiRo256PlusPlus(prePowHashBytes);
  let mat;

  do {
    mat = Array.from({ length: 64 }, () => new Uint16Array(64));
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        let val;
        do { val = rng.next() >> 61n; } while (val >= 3n); // rejection-sample top-3-bits
        mat[i][j] = Number(val);
      }
    }
  } while (matrixRankGF3(mat) !== 64);

  // Keep only the 3 most recent matrices to avoid unbounded growth
  if (_matCache.size >= 3) _matCache.delete(_matCache.keys().next().value);
  _matCache.set(key, mat);
  return mat;
}

// ---- HeavyHash ---------------------------------------------------------------

function heavyHash(mat, prePowHashBytes) {
  // Extract nibbles (64 × 4-bit values) from the 32-byte hash
  const nibbles = new Uint8Array(64);
  for (let i = 0; i < 32; i++) {
    nibbles[2 * i]     = prePowHashBytes[i] >> 4;
    nibbles[2 * i + 1] = prePowHashBytes[i] & 0x0f;
  }

  // 64×64 matrix-vector product, each element mod 3
  const product = new Uint16Array(64);
  for (let i = 0; i < 64; i++) {
    let sum = 0;
    for (let j = 0; j < 64; j++) sum += mat[i][j] * nibbles[j];
    product[i] = sum % 3;
  }

  // Pack nibbles back into 32 bytes and XOR with original hash
  const result = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    result[i] = prePowHashBytes[i] ^ ((product[2 * i] << 4) | product[2 * i + 1]);
  }
  return result;
}

// ---- Full kHeavyHash ---------------------------------------------------------

/**
 * Compute the Kaspa proof-of-work hash.
 * prePowHashBytes: 32-byte Buffer (blake3 of block header without nonce)
 * nonce          : BigInt or Buffer (8 bytes, LE) — the miner's nonce
 * Returns a 32-byte Buffer (big-endian for difficulty comparison).
 */
function hash(prePowHashBytes, nonce) {
  if (!blake3fn) throw new Error('@noble/hashes not installed — run: npm install @noble/hashes');

  const mat = generateMatrix(prePowHashBytes);
  const hh  = heavyHash(mat, prePowHashBytes);

  // XOR the 8-byte LE nonce into the first 8 bytes of the heavyHash result
  const nonceBuf = Buffer.alloc(8);
  if (typeof nonce === 'bigint') nonceBuf.writeBigUInt64LE(nonce);
  else                           nonce.copy(nonceBuf, 0, 0, 8);

  const xorResult = Buffer.from(hh);
  for (let i = 0; i < 8; i++) xorResult[i] ^= nonceBuf[i];

  return Buffer.from(blake3fn(xorResult));
}

/**
 * Verify a Kaspa share.
 * The pow hash is big-endian (no reversal needed for target comparison).
 */
function verify(prePowHashBytes, nonce, target) {
  const h = hash(prePowHashBytes, nonce);
  return hashMeetsTarget(h, target, false); // Kaspa: hash is already BE
}

module.exports = { name: 'kheavyhash', hash, verify, generateMatrix, nativeRequired: false };
