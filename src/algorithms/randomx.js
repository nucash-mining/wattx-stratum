'use strict';
const { hashMeetsTarget } = require('../utils/mining');

const path = require('path');
let randomx;
try { randomx = require(path.join(__dirname, '../../native/randomx-adapter')); } catch (_) {
  try { randomx = require('node-randomx'); } catch (_) {}
}

// Singleton cache + VM — creating a new VM per share would block the event loop.
// Cache is keyed by seedHash hex; regenerated when the seed changes (~every 2048 XMR blocks).
let _seedHex   = null;
let _cache     = null;
let _vm        = null;

function _ensureVM(seedHashBuf) {
  const seedHex = seedHashBuf.toString('hex');
  if (seedHex !== _seedHex) {
    if (_vm)  { try { _vm.destroy();   } catch (_) {} }
    _cache  = randomx.createCache(seedHashBuf);
    _vm     = randomx.createVM(_cache, randomx.FLAG_DEFAULT);
    _seedHex = seedHex;
  }
  return _vm;
}

/**
 * Compute the RandomX hash of a block blob with a given seed hash.
 * blob     : Buffer — full Monero block blob (header + nonce bytes)
 * seedHash : Buffer — 32-byte RandomX seed hash from the block template
 */
function hash(blob, seedHash) {
  if (!randomx) throw new Error('node-randomx native addon not installed');
  const vm = _ensureVM(seedHash);
  return vm.calculateHash(blob);
}

/**
 * Verify XMR share.  hashBuf is RandomX output (32 bytes, treated as LE for difficulty).
 * XMR uses the LAST 4 bytes of the RandomX output as a uint32-LE for difficulty comparison,
 * but full 32-byte comparison via hashMeetsTarget gives the same result for 32-byte targets.
 */
function verify(blob, seedHash, target) {
  const h = hash(blob, seedHash);
  return hashMeetsTarget(h, target, true);
}

module.exports = { name: 'randomx', hash, verify, nativeRequired: true };
