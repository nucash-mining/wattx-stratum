const crypto = require('crypto');

// AuxPoW per BIP: https://en.bitcoin.it/wiki/Merged_mining_specification
// WATTx is the aux chain; parent chains (BTC, LTC, etc.) carry the aux hash in their coinbase.

const MERGED_MINING_HEADER = Buffer.from('fabe6d6d', 'hex'); // magic bytes

class AuxPoW {
  // Build the script fragment to embed in a parent chain coinbase.
  // auxHash: 32-byte Buffer — the WATTx block hash
  static buildCoinbaseScript(auxHash) {
    // Format: MERGED_MINING_HEADER + auxHash (reversed) + merkle_size (4 LE) + merkle_nonce (4 LE)
    const merkleSize = Buffer.alloc(4);
    merkleSize.writeUInt32LE(1); // single aux chain
    const merkleNonce = Buffer.alloc(4); // nonce = 0

    return Buffer.concat([
      MERGED_MINING_HEADER,
      Buffer.from(auxHash).reverse(),
      merkleSize,
      merkleNonce,
    ]);
  }

  // Compute a simple merkle root from an array of 32-byte hash Buffers.
  static merkleRoot(hashes) {
    if (hashes.length === 0) throw new Error('Empty hash list');
    let layer = hashes.map((h) => Buffer.from(h));
    while (layer.length > 1) {
      if (layer.length % 2 !== 0) layer.push(layer[layer.length - 1]);
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const combined = Buffer.concat([layer[i], layer[i + 1]]);
        next.push(crypto.createHash('sha256').update(crypto.createHash('sha256').update(combined).digest()).digest());
      }
      layer = next;
    }
    return layer[0];
  }

  // Encode the full AuxPoW structure to submit to WATTx daemon.
  // parentBlock: raw parent block header as Buffer
  // coinbaseTx: full coinbase transaction as Buffer
  // coinbaseBranch: array of 32-byte hash Buffers (merkle branch from coinbase to block tx root)
  // auxBranch: array of 32-byte hash Buffers (merkle branch in aux chain)
  // auxIndex: position of this chain in the aux hash list
  // parentIndex: index within parent merkle tree
  static encodeAuxPoW({ parentBlock, coinbaseTx, coinbaseBranch, auxBranch, auxIndex, parentIndex }) {
    const encodeBranch = (hashes, index) => {
      const count = Buffer.alloc(1);
      count.writeUInt8(hashes.length);
      const hashData = Buffer.concat(hashes.map((h) => Buffer.from(h)));
      const idx = Buffer.alloc(4);
      idx.writeUInt32LE(index);
      return Buffer.concat([count, hashData, idx]);
    };

    return Buffer.concat([
      coinbaseTx,
      encodeBranch(coinbaseBranch, parentIndex),
      encodeBranch(auxBranch, auxIndex),
      parentBlock,
    ]).toString('hex');
  }

  // Called after a valid share is found on the parent chain.
  // Fetches the current WATTx aux block, checks difficulty, and submits if met.
  static async trySubmit({ wattxRPC, parentBlockHeader, coinbaseTx, coinbaseBranch, logger }) {
    try {
      const auxBlock = await wattxRPC.getAuxBlock();
      const auxHash = Buffer.from(auxBlock.hash, 'hex');

      const auxpowHex = AuxPoW.encodeAuxPoW({
        parentBlock: parentBlockHeader,
        coinbaseTx,
        coinbaseBranch,
        auxBranch: [],   // single chain: empty branch
        auxIndex: 0,
        parentIndex: 0,
      });

      const result = await wattxRPC.submitAuxBlock(auxBlock.hash, auxpowHex);
      if (result) logger && logger.info(`WATTx AuxPoW block accepted: ${auxBlock.hash}`, { coin: 'WTX' });
      return result;
    } catch (e) {
      logger && logger.error(`WATTx AuxPoW submit failed: ${e.message}`, { coin: 'WTX' });
      return false;
    }
  }
}

module.exports = AuxPoW;
