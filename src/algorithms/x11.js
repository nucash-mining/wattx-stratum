const BN = require('bn.js');

let multiHashing;
try { multiHashing = require('node-multi-hashing'); } catch (_) {}

function hash(header) {
  if (!multiHashing) throw new Error('node-multi-hashing not installed — run: npm install node-multi-hashing');
  return multiHashing.x11(header);
}

function verify(header, target) {
  const h = hash(header);
  return new BN(h.reverse()).lte(new BN(target.reverse()));
}

module.exports = { name: 'x11', verify, hash, nativeRequired: true };
