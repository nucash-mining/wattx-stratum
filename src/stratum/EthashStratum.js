// Ethash stratum protocol — compatible with lolMiner, TeamRedMiner, T-Rex, NBMiner
// Implements EthereumStratum/1.0.0 (eth_submitLogin / eth_getWork / eth_submitWork)
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const DaemonRPC = require('../rpc/DaemonRPC');
const AuxPoW = require('../auxpow/AuxPoW');
const logger = require('../logger');

class EthashStratumServer extends EventEmitter {
  // coins: array — all share this port and are mined simultaneously
  constructor(coins, wattxRPC) {
    super();
    this.coins = Array.isArray(coins) ? coins : [coins];
    this.coin = this.coins[0]; // primary coin drives work/difficulty
    this.wattxRPC = wattxRPC;
    this.port = this.coin.stratumPort;
    this.clients = new Map();
    this.currentJob = null;

    this.rpcs = {};
    for (const c of this.coins) {
      this.rpcs[c.ticker] = new DaemonRPC(c.daemon);
    }
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
    this._refreshJob();
    setInterval(() => this._refreshJob(), 15000);
  }

  async _refreshJob() {
    try {
      // Use primary coin for work template; all coins share the same Ethash PoW
      const work = await this.rpcs[this.coin.ticker].call('eth_getWork', []);
      this.currentJob = {
        headerHash: work[0],
        seedHash: work[1],
        target: work[2],
        blockNumber: parseInt(work[3], 16),
      };
      for (const client of this.clients.values()) {
        if (client.authorized) this._pushWork(client);
      }
    } catch (e) {
      logger.error(`ETH work fetch failed: ${e.message}`, { coin: this.coin.ticker });
    }
  }

  _handleConnection(socket) {
    const clientId = crypto.randomBytes(4).toString('hex');
    const client = {
      id: clientId,
      socket,
      authorized: false,
      coin: null,
      worker: null,
      buffer: '',
      hashrate: 0,
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
    socket.on('end', () => this._removeClient(clientId));
    socket.on('error', () => this._removeClient(clientId));
  }

  _removeClient(id) {
    this.clients.delete(id);
  }

  _send(client, id, result, error = null) {
    const msg = JSON.stringify({ id, jsonrpc: '2.0', result, error }) + '\n';
    client.socket.write(msg);
  }

  _pushWork(client) {
    const job = this.currentJob;
    if (!job) return;
    const msg = JSON.stringify({
      id: null,
      method: 'mining.notify',
      params: [job.headerHash, job.seedHash, job.target],
    }) + '\n';
    client.socket.write(msg);
  }

  _handleMessage(client, line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }

    switch (msg.method) {
      case 'eth_submitLogin':   return this._onLogin(client, msg.id, msg.params);
      case 'eth_getWork':       return this._onGetWork(client, msg.id);
      case 'eth_submitWork':    return this._onSubmitWork(client, msg.id, msg.params);
      case 'eth_submitHashrate': return this._onSubmitHashrate(client, msg.id, msg.params);
      case 'mining.subscribe':  return this._send(client, msg.id, true); // EthereumStratum/1.0.0 handshake
      default:
        logger.info(`Unknown Ethash method: ${msg.method}`);
    }
  }

  _onLogin(client, id, params) {
    const [workerName] = params;
    client.authorized = true;
    client.worker = workerName;
    this._send(client, id, true);
    logger.info(`Ethash authorized: ${workerName}`, { coin: this.coin.ticker });
    this._pushWork(client);
  }

  _onGetWork(client, id) {
    const job = this.currentJob;
    if (!job) return this._send(client, id, null, { code: 0, message: 'No work available' });
    this._send(client, id, [job.headerHash, job.seedHash, job.target, '0x' + job.blockNumber.toString(16)]);
  }

  async _onSubmitWork(client, id, params) {
    const [nonce, headerHash, mixDigest] = params;
    const job = this.currentJob;
    if (!job || job.headerHash !== headerHash) {
      return this._send(client, id, false);
    }

    const tickers = this.coins.map((c) => c.ticker).join('+');
    this._send(client, id, true);
    logger.info(`Ethash share from ${client.worker} nonce=${nonce}`, { coin: tickers });
    this.emit('share', { client, job, nonce, mixDigest });

    // Submit to every coin on this port simultaneously
    for (const c of this.coins) {
      this.rpcs[c.ticker].call('eth_submitWork', [nonce, headerHash, mixDigest]).catch((e) => {
        logger.error(`eth_submitWork failed for ${c.ticker}: ${e.message}`, { coin: c.ticker });
      });
    }

    AuxPoW.trySubmit({
      wattxRPC: this.wattxRPC,
      parentBlockHeader: Buffer.from(headerHash.slice(2), 'hex'),
      coinbaseTx: Buffer.alloc(0),
      coinbaseBranch: [],
      logger,
    }).catch(() => {});
  }

  _onSubmitHashrate(client, id, params) {
    const [hashrate] = params;
    client.hashrate = parseInt(hashrate, 16);
    this._send(client, id, true);
  }
}

module.exports = EthashStratumServer;
