const BN = require('bn.js');

// Ethash — used by ALT (Altcoinchain), OCTA
// Requires @ethereumjs/ethash (npm install @ethereumjs/ethash @ethereumjs/block)
let Ethash;
try { ({ Ethash } = require('@ethereumjs/ethash')); } catch (_) {}

// header: the 32-byte block hash (mixHash input)
// nonce: 8-byte Buffer
// blockNumber: BigInt or number — used to select epoch/DAG
// target: 32-byte Buffer
async function verify(header, nonce, blockNumber, target) {
  if (!Ethash) throw new Error('@ethereumjs/ethash not installed — run: npm install @ethereumjs/ethash');
  const e = new Ethash();
  await e.loadEpoc(BigInt(blockNumber));
  const result = await e.verifyPOW({ header: { hash: () => header, number: BigInt(blockNumber), difficulty: target }, nonce });
  return result;
}

module.exports = { name: 'ethash', verify, nativeRequired: false };
