const BN = require('bn.js');

// RandomX — used by XMR
// Requires node-randomx native addon (npm install node-randomx)
// Falls back to accepting all shares if not installed (DEV ONLY).
let randomx;
try { randomx = require('node-randomx'); } catch (_) {}

let rxCache = null;

function initCache(seedHash) {
  if (!randomx) return;
  rxCache = randomx.createCache(seedHash);
}

function hash(header, seedHash) {
  if (!randomx) throw new Error('node-randomx not installed — run: npm install node-randomx');
  if (!rxCache) initCache(seedHash);
  const vm = randomx.createVM(rxCache, randomx.FLAG_DEFAULT);
  const result = vm.calculateHash(header);
  vm.destroy();
  return result;
}

function verify(header, seedHash, target) {
  const h = hash(header, seedHash);
  return new BN(h).lte(new BN(target));
}

module.exports = { name: 'randomx', verify, hash, initCache, nativeRequired: true };
