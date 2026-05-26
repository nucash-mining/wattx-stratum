const BN = require('bn.js');

// kHeavyHash — used by Kaspa (KAS)
// Kaspa uses a custom heavy-hash + blake3 construction.
// TODO: integrate @kaspa/wasm or a native kHeavyHash addon when available.
// Reference: https://github.com/nicehash/NiceHashQuickMiner/tree/master/app/csharp/Algorithm

function hash(_header) {
  throw new Error('kHeavyHash not yet implemented — native addon required');
}

function verify(_header, _target) {
  throw new Error('kHeavyHash not yet implemented');
}

module.exports = { name: 'kheavyhash', verify, hash, nativeRequired: true };
