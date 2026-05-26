const DaemonRPC = require('../rpc/DaemonRPC');

class WattxRPC extends DaemonRPC {
  constructor(config) {
    super(config);
    this.auxAddress = config.address;
    this.auxChainId = config.auxpowChainId || 1;
  }

  // Returns { target, hash, chainid, previousblockhash, ... }
  async getAuxBlock() {
    return this.call('getauxblock', [this.auxAddress]);
  }

  // blockhash: hex string of the parent block hash
  // auxpow: hex-encoded AuxPoW structure
  async submitAuxBlock(blockhash, auxpow) {
    return this.call('getauxblock', [blockhash, auxpow]);
  }

  async getMiningInfo() {
    return this.call('getmininginfo');
  }
}

module.exports = WattxRPC;
