const BN = require('bn.js');

// Requires node-multi-hashing native addon (npm install node-multi-hashing)
let multiHashing;
try { multiHashing = require('node-multi-hashing'); } catch (_) {}

function hash(header) {
  if (!multiHashing) throw new Error('node-multi-hashing not installed — run: npm install node-multi-hashing');
  return multiHashing.scrypt(header);
}

function verify(header, target) {
  const h = hash(header);
  return new BN(h.reverse()).lte(new BN(target.reverse()));
}

module.exports = { name: 'scrypt', verify, hash, nativeRequired: true };
