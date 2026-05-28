// Ethash stratum — compatible with lolMiner, TeamRedMiner, T-Rex, NBMiner
// Protocol: EthereumStratum/1.0.0  (eth_submitLogin / eth_getWork / eth_submitWork)
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const DaemonRPC = require('../rpc/DaemonRPC');
const AuxPoW = require('../auxpow/AuxPoW');
const VarDiff = require('./VarDiff');
const logger = require('../logger');

const ALGO_DEFS = VarDiff.defaultsFor('ethash');

// 2^256 - 1  (used for pool target computation)
const MAX256 = (1n << 256n) - 1n;

class EthashStratumServer extends EventEmitter {
  constructor(coins, wattxRPC) {
    super();
    this.coins    = Array.isArray(coins) ? coins : [coins];
    this.coin     = this.coins[0];
    this.wattxRPC = wattxRPC;
    this.port     = this.coin.stratumPort;
    this.clients  = new Map();

    // Per-coin current job: { headerHash, seedHash, networkTarget, blockNumber, coin }
    this.jobs = {};

    this.rpcs = {};
    for (const c of this.coins) {
      this.rpcs[c.ticker] = new DaemonRPC(c.daemon);
    }

    this.varDiff = new VarDiff({ minDiff: ALGO_DEFS.min, maxDiff: ALGO_DEFS.max });
    this.initialDifficulty = ALGO_DEFS.initial;
  }

  start() {
    const tickers = this.coins.map((c) => c.ticker).join('+');
    this.server = net.createServer((socket) => this._handleConnection(socket));
    this.server.listen(this.port, () => {
      logger.info(`Ethash stratum listening on port ${this.port} [${tickers}]`);
    });
    this.server.on('error', (e) => logger.error(`EthashStratum error: ${e.message}`, { coin: tickers }));
    this._startJobRefresh();
  }

  _startJobRefresh() {
    this._refreshJobs();
    setInterval(() => this._refreshJobs(), 15000);
  }

  async _refreshJobs() {
    let primaryUpdated = false;
    for (const c of this.coins) {
      try {
        const work = await this.rpcs[c.ticker].call('eth_getWork', []);
        const prev = this.jobs[c.ticker];
        this.jobs[c.ticker] = {
          headerHash:    work[0],
          seedHash:      work[1],
          networkTarget: work[2],
          blockNumber:   parseInt(work[3] || '0x0', 16),
          coin:          c,
        };
        if (c.ticker === this.coin.ticker && (!prev || prev.headerHash !== work[0])) {
          primaryUpdated = true;
        }
      } catch (e) {
        logger.error(`ETH work fetch failed for ${c.ticker}: ${e.message}`, { coin: c.ticker });
      }
    }

    // Only push a new job to miners when the primary coin's block changes
    if (primaryUpdated) {
      for (const client of this.clients.values()) {
        if (client.authorized) this._pushWork(client);
      }
    }
  }

  _handleConnection(socket) {
    const clientId = crypto.randomBytes(4).toString('hex');
    const client = {
      id:         clientId,
      socket,
      authorized: false,
      worker:     null,
      difficulty: this.initialDifficulty,
      hashrate:   0,
      buffer:     '',
    };
    this.clients.set(clientId, client);
    logger.info(`Ethash client connected: ${socket.remoteAddress}`);

    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      client.buffer += data;
      const lines = client.buffer.split('\n');
      client.buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this._handleMessage(client, line.trim());
      }
    });
    socket.on('end',   () => this._removeClient(clientId));
    socket.on('error', () => this._removeClient(clientId));
  }

  _removeClient(id) { this.clients.delete(id); }

  _send(client, id, result, error = null) {
    client.socket.write(JSON.stringify({ id, jsonrpc: '2.0', result, error }) + '\n');
  }

  // Pool-side target from client difficulty: target = floor((2^256 - 1) / difficulty)
  _diffToTarget(difficulty) {
    const t = MAX256 / BigInt(Math.max(1, Math.round(difficulty)));
    let hex = t.toString(16);
    while (hex.length < 64) hex = '0' + hex;
    return '0x' + hex;
  }

  // Push primary coin's work with the client's pool-side target
  _pushWork(client) {
    const job = this.jobs[this.coin.ticker];
    if (!job) return;
    client.socket.write(JSON.stringify({
      id:     null,
      method: 'mining.notify',
      params: [job.headerHash, job.seedHash, this._diffToTarget(client.difficulty)],
    }) + '\n');
  }

  _handleMessage(client, line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }

    switch (msg.method) {
      case 'eth_submitLogin':    return this._onLogin(client, msg.id, msg.params);
      case 'eth_getWork':        return this._onGetWork(client, msg.id);
      case 'eth_submitWork':     return this._onSubmitWork(client, msg.id, msg.params);
      case 'eth_submitHashrate': return this._onSubmitHashrate(client, msg.id, msg.params);
      case 'mining.subscribe':   return this._send(client, msg.id, true); // EthereumStratum/1.0.0 handshake
      default:
        logger.info(`Unknown Ethash method: ${msg.method}`);
    }
  }

  _onLogin(client, id, params) {
    const [workerName] = params;
    client.authorized = true;
    client.worker     = workerName;
    this._send(client, id, true);
    logger.info(`Ethash authorized: ${workerName}`, { coin: this.coin.ticker });
    // Inform miner of pool difficulty then push work
    client.socket.write(JSON.stringify({
      id: null, method: 'mining.set_difficulty', params: [client.difficulty],
    }) + '\n');
    this._pushWork(client);
  }

  _onGetWork(client, id) {
    const job = this.jobs[this.coin.ticker];
    if (!job) return this._send(client, id, null, { code: 0, message: 'No work available' });
    this._send(client, id, [
      job.headerHash,
      job.seedHash,
      this._diffToTarget(client.difficulty),
      '0x' + job.blockNumber.toString(16),
    ]);
  }

  async _onSubmitWork(client, id, params) {
    const [nonce, headerHash, mixDigest] = params;

    // Find which coin(s) currently have this exact headerHash
    const matchingCoins = this.coins.filter((c) => {
      const j = this.jobs[c.ticker];
      return j && j.headerHash.toLowerCase() === headerHash.toLowerCase();
    });

    if (matchingCoins.length === 0) {
      logger.info(`Ethash stale share from ${client.worker} hash=${headerHash}`);
      return this._send(client, id, false);
    }

    const tickers = matchingCoins.map((c) => c.ticker).join('+');
    this._send(client, id, true);
    logger.info(`Ethash share from ${client.worker} nonce=${nonce}`, { coin: tickers });
    this.emit('share', { client, nonce, headerHash, mixDigest, coins: matchingCoins });

    // VarDiff retarget
    const newDiff = this.varDiff.onShare(client);
    if (newDiff !== null) {
      client.difficulty = newDiff;
      client.socket.write(JSON.stringify({
        id: null, method: 'mining.set_difficulty', params: [newDiff],
      }) + '\n');
      logger.debug(`VarDiff ${client.worker}: diff → ${newDiff}`, { coin: tickers });
    }

    // Submit to each matching coin's daemon simultaneously
    for (const c of matchingCoins) {
      this.rpcs[c.ticker].call('eth_submitWork', [nonce, headerHash, mixDigest]).catch((e) => {
        logger.error(`eth_submitWork failed for ${c.ticker}: ${e.message}`, { coin: c.ticker });
      });
    }

    // AuxPoW (best-effort — Ethash parent header is 32-byte hash, not 80-byte Bitcoin header)
    AuxPoW.trySubmit({
      wattxRPC:          this.wattxRPC,
      parentBlockHeader: Buffer.from(headerHash.slice(2), 'hex'),
      coinbaseTx:        Buffer.alloc(0),
      coinbaseBranch:    [],
      logger,
    }).catch(() => {});
  }

  _onSubmitHashrate(client, id, params) {
    client.hashrate = parseInt(params[0] || '0x0', 16);
    this._send(client, id, true);
  }
}

module.exports = EthashStratumServer;
