const crypto = require('crypto');
const BN = require('bn.js');

function hash(header) {
  const first = crypto.createHash('sha256').update(header).digest();
  return crypto.createHash('sha256').update(first).digest();
}

function verify(header, target) {
  const h = hash(header);
  // Compare little-endian: reverse both for big-endian comparison
  return new BN(h.reverse()).lte(new BN(target.reverse()));
}

module.exports = { name: 'sha256d', verify, hash, nativeRequired: false };
