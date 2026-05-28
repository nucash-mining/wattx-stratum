'use strict';
const crypto = require('crypto');
const { hashMeetsTarget } = require('../utils/mining');

// Equihash 200,9 — ZEN, ZEC, BTCZ
let equihashverify;
try { equihashverify = require('equihashverify'); } catch (_) {}

/**
 * Verify an Equihash share.
 * header  : Buffer — 140-byte Zcash block header (version+prevhash+merkle+reserved+time+bits+nNonce)
 * solution: Buffer — 1344-byte Equihash 200,9 solution
 * target  : Buffer — 32-byte big-endian pool/network target
 */
function verify(header, solution, target) {
  if (!equihashverify) throw new Error('equihashverify not installed');
  if (!equihashverify.verify(header, solution, 200, 9)) return false;
  // Difficulty check: SHA256d of the full header (includes nNonce, not solution)
  const h = dsha256(header);
  return hashMeetsTarget(h, target, true);
}

function dsha256(buf) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(buf).digest())
    .digest();
}

module.exports = { name: 'equihash_200_9', verify, nativeRequired: true, n: 200, k: 9 };
