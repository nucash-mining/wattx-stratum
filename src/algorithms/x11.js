'use strict';
const { hashMeetsTarget } = require('../utils/mining');

let multiHashing;
try { multiHashing = require('node-multi-hashing'); } catch (_) {}

function hash(header) {
  if (!multiHashing) throw new Error('node-multi-hashing not installed');
  return multiHashing.x11(header);
}

function verify(header, target) {
  return hashMeetsTarget(hash(header), target, true);
}

module.exports = { name: 'x11', hash, verify, nativeRequired: true };
