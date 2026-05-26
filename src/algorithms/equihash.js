const BN = require('bn.js');

// Equihash 200,9 — used by ZEN, ZEC, BTCZ
// Requires equihashverify native addon (npm install equihashverify)
let equihashverify;
try { equihashverify = require('equihashverify'); } catch (_) {}

// header: Buffer — 140-byte Zcash block header (without solution)
// solution: Buffer — Equihash solution (1344 bytes for 200,9)
function verify(header, solution, target) {
  if (!equihashverify) throw new Error('equihashverify not installed — run: npm install equihashverify');
  const valid = equihashverify.verify(header, solution, 200, 9);
  if (!valid) return false;
  // Check difficulty against target
  const headerWithSolution = Buffer.concat([header, solution]);
  const crypto = require('crypto');
  const h1 = crypto.createHash('sha256').update(headerWithSolution).digest();
  const h2 = crypto.createHash('sha256').update(h1).digest();
  return new BN(h2.reverse()).lte(new BN(target.reverse()));
}

module.exports = { name: 'equihash_200_9', verify, nativeRequired: true, n: 200, k: 9 };
