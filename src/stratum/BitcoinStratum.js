const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const BN = require('bn.js');
const DaemonRPC = require('../rpc/DaemonRPC');
const AuxPoW = require('../auxpow/AuxPoW');
const logger = require('../logger');

const EXTRANONCE2_SIZE = 4;

class BitcoinStratumServer extends EventEmitter {
  // coins: array — all share this port and are mined simultaneously
  constructor(coins, wattxRPC) {
    super();
    this.coins = Array.isArray(coins) ? coins : [coins];
    this.coin = this.coins[0]; // primary coin drives job/difficulty
    this.wattxRPC = wattxRPC;
    this.algorithm = this.coin.algorithm;
    this.port = this.coin.stratumPort;

    this.clients = new Map();
    this.jobs = new Map();
    this.extranonce1Counter = 0;

    this.rpcs = {};
    for (const c of this.coins) {
      this.rpcs[c.ticker] = new DaemonRPC(c.daemon);
    }
    this._jobRefreshInterval = null;
  }

  start() {
    const tickers = this.coins.map((c) => c.ticker).join('+');
    this.server = net.createServer((socket) => this._handleConnection(socket));
    this.server.listen(this.port, () => {
      logger.info(`${this.algorithm} stratum listening on port ${this.port} [${tickers}]`);
    });
    this.server.on('error', (e) => logger.error(`Stratum server error: ${e.message}`, { coin: tickers }));
    this._startJobRefresh();
  }

  _startJobRefresh() {
    this._refreshJob();
    this._jobRefreshInterval = setInterval(() => this._refreshJob(), 30000);
  }

  async _refreshJob() {
    // Use primary coin for the job template; all coins on this port share the same PoW
    try {
      const template = await this.rpcs[this.coin.ticker].getBlockTemplate(this.coin.address);
      const job = this._buildJob(this.coin, template);
      this.jobs.set(job.id, job);
      this._broadcastJob(job, false);
    } catch (e) {
      logger.error(`Failed to refresh job for ${this.coin.ticker}: ${e.message}`, { coin: this.coin.ticker });
    }
  }

  _buildJob(coin, template) {
    const jobId = crypto.randomBytes(4).toString('hex');
    const auxScript = AuxPoW.buildCoinbaseScript(Buffer.from(template.auxpow_hash || crypto.randomBytes(32)));

    return {
      id: jobId,
      coin: coin.ticker,
      algorithm: coin.algorithm,
      template,
      auxScript,
      prevhash: template.previousblockhash,
      bits: template.bits,
      height: template.height,
      target: this._bitsToTarget(template.bits),
      cleanJobs: true,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  _bitsToTarget(bits) {
    const bitsNum = parseInt(bits, 16);
    const exp = bitsNum >> 24;
    const mant = bitsNum & 0xffffff;
    const target = new BN(mant).shln(8 * (exp - 3));
    return target.toBuffer('be', 32);
  }

  _broadcastJob(job, cleanJobs) {
    const notify = this._buildNotify(job, cleanJobs);
    for (const client of this.clients.values()) {
      if (client.authorized) {
        client.socket.write(JSON.stringify(notify) + '\n');
      }
    }
  }

  _buildNotify(job, cleanJobs) {
    return {
      id: null,
      method: 'mining.notify',
      params: [
        job.id,
        job.prevhash,
        '', // coinb1 — TODO: build actual coinbase transaction parts
        '', // coinb2
        [],  // merkle_branch
        '20000000',
        job.bits,
        job.timestamp.toString(16),
        cleanJobs,
      ],
    };
  }

  _handleConnection(socket) {
    const clientId = crypto.randomBytes(4).toString('hex');
    const extranonce1 = (this.extranonce1Counter++).toString(16).padStart(8, '0');

    const client = {
      id: clientId,
      socket,
      extranonce1,
      authorized: false,
      coin: null,
      worker: null,
      difficulty: 1,
      shares: 0,
      buffer: '',
    };

    this.clients.set(clientId, client);
    logger.info(`Client connected: ${socket.remoteAddress} [${clientId}]`, { coin: this.algorithm });

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
    socket.on('error', (e) => {
      logger.error(`Client ${clientId} error: ${e.message}`, { coin: this.algorithm });
      this._removeClient(clientId);
    });
  }

  _removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      logger.info(`Client disconnected: ${client.id}`, { coin: this.algorithm });
      this.clients.delete(clientId);
    }
  }

  _send(client, id, result, error = null) {
    const msg = JSON.stringify({ id, result, error }) + '\n';
    client.socket.write(msg);
  }

  _handleMessage(client, line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }

    switch (msg.method) {
      case 'mining.subscribe':  return this._onSubscribe(client, msg.id, msg.params);
      case 'mining.authorize':  return this._onAuthorize(client, msg.id, msg.params);
      case 'mining.submit':     return this._onSubmit(client, msg.id, msg.params);
      case 'mining.extranonce.subscribe': return this._send(client, msg.id, true);
      default:
        logger.info(`Unknown method from ${client.id}: ${msg.method}`, { coin: this.algorithm });
    }
  }

  _onSubscribe(client, id, _params) {
    this._send(client, id, [
      [['mining.set_difficulty', '1'], ['mining.notify', client.id]],
      client.extranonce1,
      EXTRANONCE2_SIZE,
    ]);

    // Send current difficulty
    client.socket.write(JSON.stringify({
      id: null, method: 'mining.set_difficulty', params: [client.difficulty],
    }) + '\n');
  }

  _onAuthorize(client, id, params) {
    const [workerName] = params;
    client.authorized = true;
    client.worker = workerName;
    this._send(client, id, true);
    logger.info(`Authorized: ${workerName}`, { coin: this.coin.ticker });

    // Send the latest job immediately
    const job = [...this.jobs.values()].pop();
    if (job) client.socket.write(JSON.stringify(this._buildNotify(job, true)) + '\n');
  }

  async _onSubmit(client, id, params) {
    const [_worker, jobId, extranonce2, ntime, nonce] = params;
    const job = this.jobs.get(jobId);

    if (!job) return this._send(client, id, false, [21, 'Job not found']);

    const tickers = this.coins.map((c) => c.ticker).join('+');
    client.shares++;
    this._send(client, id, true);
    logger.info(`Share from ${client.worker} job=${jobId}`, { coin: tickers });
    this.emit('share', { client, job, extranonce2, ntime, nonce });

    // Submit block to every coin on this port simultaneously
    // TODO: build per-coin coinbase tx with coin-specific reward address once coinbase builder is complete
    for (const c of this.coins) {
      this.rpcs[c.ticker].submitBlock('').catch((e) => {
        logger.error(`submitBlock failed for ${c.ticker}: ${e.message}`, { coin: c.ticker });
      });
    }

    // AuxPoW for WATTx
    AuxPoW.trySubmit({
      wattxRPC: this.wattxRPC,
      parentBlockHeader: Buffer.alloc(80), // placeholder — replace with real header
      coinbaseTx: Buffer.alloc(0),
      coinbaseBranch: [],
      logger,
    }).catch(() => {});
  }
}

module.exports = BitcoinStratumServer;
