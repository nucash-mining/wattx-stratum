'use strict';
const { hashMeetsTarget } = require('../utils/mining');

const path = require('path');
let multiHashing;
try { multiHashing = require(path.join(__dirname, '../../native/multihashing.node')); } catch (_) {
  try { multiHashing = require('multi-hashing'); } catch (_) {}
}

// LTC/DOGE scrypt: N=1024, R=1
function hash(header) {
  if (!multiHashing) throw new Error('multi-hashing native addon not installed');
  return multiHashing.scrypt(header, 1024, 1);
}

function verify(header, target) {
  return hashMeetsTarget(hash(header), target, true);
}

module.exports = { name: 'scrypt', hash, verify, nativeRequired: true };
