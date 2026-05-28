'use strict';
const { hashMeetsTarget } = require('../utils/mining');

const path = require('path');
let multiHashing;
try { multiHashing = require(path.join(__dirname, '../../native/multihashing.node')); } catch (_) {
  try { multiHashing = require('multi-hashing'); } catch (_) {}
}

function hash(header) {
  if (!multiHashing) throw new Error('multi-hashing native addon not installed');
  return multiHashing.x11(header);
}

function verify(header, target) {
  return hashMeetsTarget(hash(header), target, true);
}

module.exports = { name: 'x11', hash, verify, nativeRequired: true };
