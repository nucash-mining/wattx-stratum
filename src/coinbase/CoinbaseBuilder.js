const crypto = require('crypto');

const MERGED_MINING_HEADER = Buffer.from('fabe6d6d', 'hex');
const EXTRANONCE1_SIZE = 4; // bytes
const EXTRANONCE2_SIZE = 4; // bytes

function dsha256(buf) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(buf).digest())
    .digest();
}

function varInt(n) {
  if (n < 0xfd) {
    const b = Buffer.alloc(1); b.writeUInt8(n); return b;
  }
  if (n <= 0xffff) {
    const b = Buffer.alloc(3); b.writeUInt8(0xfd); b.writeUInt16LE(n, 1); return b;
  }
  const b = Buffer.alloc(5); b.writeUInt8(0xfe); b.writeUInt32LE(n, 1); return b;
}

class CoinbaseBuilder {
  /**
   * Build the stratum coinb1/coinb2 split and merkle branch for a job.
   *
   * Layout of the full coinbase (what the miner reconstructs):
   *   [coinb1] [extranonce1 4B] [extranonce2 4B] [coinb2]
   *
   * coinb1: version + 1 input (prevout zeros + sequence) + script_len + height_push + pool_tag
   * coinb2: merged_mining_tag + sequence + 1 output (reward → address) + locktime
   *
   * @param {object} template  - getblocktemplate response
   * @param {string} address   - pool reward address for this coin
   * @param {Buffer|null} auxHash - 32-byte WATTx block hash to embed, or null
   * @returns {{ coinb1: string, coinb2: string, merkleBranch: string[] }}
   */
  static build({ template, address, auxHash }) {
    const outputScript = CoinbaseBuilder._addressToScript(address);
    const heightPush   = CoinbaseBuilder._encodeHeight(template.height);
    const poolTag      = Buffer.from('/WATTx/', 'utf8');

    // Merged mining tag: magic(4) + aux_hash_reversed(32) + tree_size_LE(4) + nonce_LE(4) = 44 bytes
    let mmTag = Buffer.alloc(0);
    if (auxHash) {
      const treeSize = Buffer.alloc(4); treeSize.writeUInt32LE(1);
      const mmNonce  = Buffer.alloc(4);
      mmTag = Buffer.concat([MERGED_MINING_HEADER, Buffer.from(auxHash).reverse(), treeSize, mmNonce]);
    }

    const scriptLen = heightPush.length + poolTag.length + EXTRANONCE1_SIZE + EXTRANONCE2_SIZE + mmTag.length;

    // ---- coinb1 ----
    const version = Buffer.alloc(4);
    version.writeInt32LE(template.version || 1);

    const coinb1 = Buffer.concat([
      version,
      varInt(1),           // 1 input
      Buffer.alloc(32),    // prev txid = all zeros (coinbase)
      Buffer.from([0xff, 0xff, 0xff, 0xff]),  // prev vout = 0xFFFFFFFF
      varInt(scriptLen),
      heightPush,
      poolTag,
      // [extranonce1 4B] and [extranonce2 4B] follow here (miner fills them in)
    ]);

    // ---- coinb2 ----
    const valueBuf = Buffer.alloc(8);
    valueBuf.writeBigInt64LE(BigInt(template.coinbasevalue || 0));

    const coinb2 = Buffer.concat([
      mmTag,
      Buffer.from([0xff, 0xff, 0xff, 0xff]),  // sequence
      varInt(1),           // 1 output
      valueBuf,
      varInt(outputScript.length),
      outputScript,
      Buffer.alloc(4),     // locktime = 0
    ]);

    // ---- Merkle branch (siblings to compute merkle root with coinbase at index 0) ----
    const txHashes = (template.transactions || []).map((tx) =>
      Buffer.from(tx.txid || tx.hash, 'hex').reverse()  // display→internal byte order
    );

    return {
      coinb1:        coinb1.toString('hex'),
      coinb2:        coinb2.toString('hex'),
      merkleBranch:  CoinbaseBuilder._merkleBranch(txHashes).map((h) => h.toString('hex')),
    };
  }

  /** Reassemble the full coinbase tx bytes from stratum components. */
  static assembleCoinbase(coinb1Hex, extranonce1Hex, extranonce2Hex, coinb2Hex) {
    return Buffer.concat([
      Buffer.from(coinb1Hex, 'hex'),
      Buffer.from(extranonce1Hex, 'hex'),
      Buffer.from(extranonce2Hex, 'hex'),
      Buffer.from(coinb2Hex, 'hex'),
    ]);
  }

  /** Double-SHA256 → internal-byte-order txid. */
  static txId(coinbaseBuf) {
    return dsha256(coinbaseBuf);
  }

  /** Combine coinbase txid with merkle branch to get the merkle root (internal byte order). */
  static merkleRoot(coinbaseTxId, merkleBranch) {
    let root = coinbaseTxId;
    for (const sibling of merkleBranch) {
      const sib = Buffer.isBuffer(sibling) ? sibling : Buffer.from(sibling, 'hex');
      root = dsha256(Buffer.concat([root, sib]));
    }
    return root;
  }

  /**
   * Build the 80-byte block header.
   * prevHashHex: display-order hex from getblocktemplate (will be reversed internally).
   * merkleRoot: internal-byte-order Buffer from CoinbaseBuilder.merkleRoot().
   * ntimeHex, bitsHex, nonceHex: 8-char hex strings from mining.notify / mining.submit.
   */
  static buildHeader({ version, prevHashHex, merkleRoot, ntimeHex, bitsHex, nonceHex }) {
    const buf = Buffer.alloc(80);
    buf.writeInt32LE(version, 0);
    Buffer.from(prevHashHex, 'hex').reverse().copy(buf, 4);   // display→LE
    merkleRoot.copy(buf, 36);                                   // already internal order
    buf.writeUInt32LE(parseInt(ntimeHex, 16), 68);
    buf.writeUInt32LE(parseInt(bitsHex, 16), 72);
    buf.writeUInt32LE(parseInt(nonceHex, 16), 76);
    return buf;
  }

  /** Assemble the full serialised block hex for submitblock. */
  static buildBlock({ header, coinbaseTx, template }) {
    const extraTxs = (template.transactions || []).map((tx) => Buffer.from(tx.data, 'hex'));
    return Buffer.concat([
      header,
      varInt(1 + extraTxs.length),
      coinbaseTx,
      ...extraTxs,
    ]).toString('hex');
  }

  // ---- Private helpers ----

  // BIP34 minimal-push encoding for the block height in the coinbase script.
  static _encodeHeight(height) {
    const bytes = [];
    let h = height;
    while (h > 0) { bytes.push(h & 0xff); h >>>= 8; }
    // Avoid sign-bit ambiguity: add 0x00 if high bit is set
    if (bytes.length > 0 && bytes[bytes.length - 1] & 0x80) bytes.push(0);
    const data = Buffer.from(bytes);
    return Buffer.concat([Buffer.from([data.length]), data]);
  }

  // Decode a base58check address and return the P2PKH or P2SH output script.
  // Falls back to OP_TRUE (anyone-can-spend) for placeholder / unrecognised addresses.
  static _addressToScript(address) {
    try {
      const payload = CoinbaseBuilder._base58CheckDecode(address);
      const version = payload[0];
      const hash    = payload.slice(1);
      if (hash.length !== 20) throw new Error('unexpected hash length');

      if (version === 5 || version === 196) {
        // P2SH: OP_HASH160 <hash20> OP_EQUAL
        return Buffer.concat([Buffer.from([0xa9, 0x14]), hash, Buffer.from([0x87])]);
      }
      // P2PKH (all other version bytes): OP_DUP OP_HASH160 <hash20> OP_EQUALVERIFY OP_CHECKSIG
      return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, 0xac])]);
    } catch (_) {
      return Buffer.from([0x51]); // OP_TRUE — placeholder address
    }
  }

  static _base58CheckDecode(str) {
    const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const c of str) {
      const d = ALPHA.indexOf(c);
      if (d < 0) throw new Error(`bad char: ${c}`);
      n = n * 58n + BigInt(d);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const bytes    = Buffer.from(hex, 'hex');
    const leading  = (str.match(/^1*/)[0] || '').length;
    const full     = Buffer.concat([Buffer.alloc(leading), bytes]);
    const payload  = full.slice(0, -4);
    const checksum = full.slice(-4);
    if (!dsha256(payload).slice(0, 4).equals(checksum)) throw new Error('bad checksum');
    return payload;
  }

  /**
   * Compute the merkle branch (sibling list) for the coinbase at position 0.
   * Uses a null placeholder for the coinbase so we only need the non-coinbase txids.
   */
  static _merkleBranch(txHashes) {
    if (txHashes.length === 0) return [];

    const branch = [];
    let layer = [null, ...txHashes]; // null = coinbase placeholder at index 0

    while (layer.length > 1) {
      if (layer.length % 2 !== 0) layer.push(layer[layer.length - 1]);

      // Sibling of the coinbase (always at index 0) is always at index 1
      branch.push(layer[1]);

      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        if (layer[i] === null) {
          next.push(null); // propagate the coinbase placeholder leftward
        } else {
          next.push(dsha256(Buffer.concat([layer[i], layer[i + 1]])));
        }
      }
      layer = next;
    }

    return branch.filter(Boolean);
  }
}

module.exports = CoinbaseBuilder;
module.exports.dsha256 = dsha256;
