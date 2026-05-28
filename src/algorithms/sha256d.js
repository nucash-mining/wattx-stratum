'use strict';
const crypto = require('crypto');
const { hashMeetsTarget } = require('../utils/mining');

function hash(header) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(header).digest())
    .digest();
}

function verify(header, target) {
  return hashMeetsTarget(hash(header), target, true);
}

module.exports = { name: 'sha256d', hash, verify, nativeRequired: false };
