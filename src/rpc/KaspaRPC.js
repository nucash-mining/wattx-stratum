'use strict';
// Kaspa gRPC client — wraps GetBlockTemplate and SubmitBlock.
// Also owns computePrePowHash: serializes the block header (nonce=0) and
// blake3-hashes it, producing the 32-byte seed for the kHeavyHash algorithm.

const path  = require('path');
const grpc  = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

let blake3fn;
try { ({ blake3: blake3fn } = require('@noble/hashes/blake3')); } catch (_) {}

const PROTO_PATH = path.join(__dirname, 'kaspa.proto');

class KaspaRPC {
  constructor(config) {
    this.host = config.host || '127.0.0.1';
    this.port = config.port || 16110;
    this._client = null;
  }

  _getClient() {
    if (this._client) return this._client;
    const def = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs:    String,   // uint64 fields returned as strings
      enums:    String,
      defaults: true,
      oneofs:   true,
    });
    const proto = grpc.loadPackageDefinition(def).protowire;
    this._client = new proto.RPC(
      `${this.host}:${this.port}`,
      grpc.credentials.createInsecure(),
    );
    return this._client;
  }

  _call(method, request) {
    return new Promise((resolve, reject) => {
      this._getClient()[method](request, (err, res) => {
        if (err) return reject(err);
        if (res.error && res.error.message) return reject(new Error(res.error.message));
        resolve(res);
      });
    });
  }

  async getBlockTemplate(address) {
    return this._call('GetBlockTemplate', { payAddress: address, extraData: 'wattx-stratum' });
  }

  async submitBlock(block) {
    return this._call('SubmitBlock', { block, allowNonDAABlocks: false });
  }

  // ---- prePowHash serialization -----------------------------------------------
  // Serialize block header (nonce forced to 0) then blake3-hash it.
  // The resulting 32-byte Buffer is the seed for kHeavyHash / matrix generation.
  computePrePowHash(block) {
    if (!blake3fn) throw new Error('@noble/hashes not installed — run: npm install @noble/hashes');
    const h = block.header;
    const chunks = [];

    // version: uint16 LE
    const vBuf = Buffer.alloc(2);
    vBuf.writeUInt16LE(Number(h.version) & 0xffff);
    chunks.push(vBuf);

    // parents: numLevels (uint64 LE) + for each level: numParents (uint64 LE) + 32B each
    const parents = h.parents || [];
    chunks.push(_u64LE(parents.length));
    for (const level of parents) {
      const hashes = level.parentHashes || [];
      chunks.push(_u64LE(hashes.length));
      for (const hx of hashes) chunks.push(_hashBytes(hx));
    }

    // merkle roots and commitments: each 32B, display-order → internal-order
    chunks.push(_hashBytes(h.hashMerkleRoot       || '0'.repeat(64)));
    chunks.push(_hashBytes(h.acceptedIdMerkleRoot || '0'.repeat(64)));
    chunks.push(_hashBytes(h.utxoCommitment       || '0'.repeat(64)));

    // timestamp: int64 LE (milliseconds)
    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigInt64LE(BigInt(h.timestamp || 0));
    chunks.push(tsBuf);

    // bits: uint32 LE
    const bBuf = Buffer.alloc(4);
    bBuf.writeUInt32LE(Number(h.bits || 0));
    chunks.push(bBuf);

    // nonce: uint64 LE — forced to 0 for prePowHash
    chunks.push(_u64LE(0));

    // daaScore: uint64 LE
    chunks.push(_u64LE(h.daaScore || 0));

    // blueWork: gRPC sends as hex big-endian big-integer string.
    // Serialize as: uint64 LE byte-count, then the bytes (big-endian, no leading zeros).
    const bwHex = (h.blueWork || '').replace(/^0+/, '') || '00';
    const bwBuf = Buffer.from(bwHex.length % 2 ? '0' + bwHex : bwHex, 'hex');
    chunks.push(_u64LE(bwBuf.length));
    chunks.push(bwBuf);

    // pruningPoint: 32B
    chunks.push(_hashBytes(h.pruningPoint || '0'.repeat(64)));

    // blueScore: uint64 LE
    chunks.push(_u64LE(h.blueScore || 0));

    return Buffer.from(blake3fn(Buffer.concat(chunks)));
  }
}

// ---- helpers -----------------------------------------------------------------

// Display-order hex → internal-order 32-byte Buffer (reverses bytes)
function _hashBytes(hexStr) {
  const padded = hexStr.padStart(64, '0').slice(0, 64);
  return Buffer.from(padded, 'hex').reverse();
}

// Number, BigInt, or numeric string → 8-byte LE Buffer
function _u64LE(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

module.exports = KaspaRPC;
