const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const DaemonRPC = require('../rpc/DaemonRPC');
const AuxPoW = require('../auxpow/AuxPoW');
const CoinbaseBuilder = require('../coinbase/CoinbaseBuilder');
const VarDiff = require('./VarDiff');
const logger = require('../logger');

const EXTRANONCE2_SIZE = 4;

class BitcoinStratumServer extends EventEmitter {
  // coins: array — all share this port and are mined simultaneously
  constructor(coins, wattxRPC) {
    super();
    this.coins = Array.isArray(coins) ? coins : [coins];
    this.coin  = this.coins[0]; // primary coin drives job/difficulty
    this.wattxRPC  = wattxRPC;
    this.algorithm = this.coin.algorithm;
    this.port      = this.coin.stratumPort;

    this.clients  = new Map();
    this.jobs     = new Map();
    this.extranonce1Counter = 0;

    this.rpcs = {};
    for (const c of this.coins) {
      this.rpcs[c.ticker] = new DaemonRPC(c.daemon);
    }
    this._jobRefreshInterval = null;

    const algoDefs = VarDiff.defaultsFor(this.algorithm);
    this.initialDifficulty = algoDefs.initial;
    this.varDiff = new VarDiff({ minDiff: algoDefs.min, maxDiff: algoDefs.max });
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
    try {
      const template = await this.rpcs[this.coin.ticker].getBlockTemplate(this.coin.address);
      const job      = await this._buildJob(this.coin, template);
      this.jobs.set(job.id, job);
      // Trim job history — keep last 8 so stale shares still resolve
      if (this.jobs.size > 8) {
        const oldest = [...this.jobs.keys()][0];
        this.jobs.delete(oldest);
      }
      this._broadcastJob(job, true);
    } catch (e) {
      logger.error(`Failed to refresh job for ${this.coin.ticker}: ${e.message}`, { coin: this.coin.ticker });
    }
  }

  async _buildJob(coin, template) {
    const jobId = crypto.randomBytes(4).toString('hex');

    // Fetch the current WATTx aux block so we can embed its hash in the coinbase
    let auxBlock = null;
    try {
      auxBlock = await this.wattxRPC.getAuxBlock();
    } catch (e) {
      logger.warn(`WATTx getAuxBlock failed — mining without aux commitment: ${e.message}`, { coin: 'WTX' });
    }

    const auxHash = auxBlock ? Buffer.from(auxBlock.hash, 'hex') : null;

    const { coinb1, coinb2, merkleBranch } = CoinbaseBuilder.build({
      template,
      address: coin.address,
      auxHash,
    });

    return {
      id: jobId,
      coin: coin.ticker,
      algorithm: coin.algorithm,
      template,
      auxBlock,    // saved so _onSubmit uses the exact block we committed to in the coinbase
      coinb1,
      coinb2,
      merkleBranch,
      prevhash: Buffer.from(template.previousblockhash, 'hex').reverse().toString('hex'),
      bits: template.bits,
      height: template.height,
      version: template.version || 1,
      curtime: template.curtime,
      cleanJobs: true,
    };
  }

  _broadcastJob(job, cleanJobs) {
    const notify = this._buildNotify(job, cleanJobs);
    for (const client of this.clients.values()) {
      if (client.authorized) client.socket.write(JSON.stringify(notify) + '\n');
    }
  }

  _buildNotify(job, cleanJobs) {
    return {
      id: null,
      method: 'mining.notify',
      params: [
        job.id,
        job.prevhash,                                           // LE (already reversed from display)
        job.coinb1,
        job.coinb2,
        job.merkleBranch,
        job.version.toString(16).padStart(8, '0'),
        job.bits,
        job.curtime.toString(16).padStart(8, '0'),
        cleanJobs,
      ],
    };
  }

  _handleConnection(socket) {
    const clientId    = crypto.randomBytes(4).toString('hex');
    const extranonce1 = (this.extranonce1Counter++).toString(16).padStart(8, '0');

    const client = {
      id: clientId,
      socket,
      extranonce1,
      authorized: false,
      worker: null,
      difficulty: this.initialDifficulty,
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

    socket.on('end',   () => this._removeClient(clientId));
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
    client.socket.write(JSON.stringify({ id, result, error }) + '\n');
  }

  _handleMessage(client, line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }

    switch (msg.method) {
      case 'mining.subscribe':           return this._onSubscribe(client, msg.id, msg.params);
      case 'mining.authorize':           return this._onAuthorize(client, msg.id, msg.params);
      case 'mining.submit':              return this._onSubmit(client, msg.id, msg.params);
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
    client.socket.write(JSON.stringify({
      id: null, method: 'mining.set_difficulty', params: [client.difficulty],
    }) + '\n');
  }

  _onAuthorize(client, id, params) {
    const [workerName] = params;
    client.authorized = true;
    client.worker     = workerName;
    this._send(client, id, true);
    logger.info(`Authorized: ${workerName}`, { coin: this.coin.ticker });

    const job = [...this.jobs.values()].pop();
    if (job) client.socket.write(JSON.stringify(this._buildNotify(job, true)) + '\n');
  }

  async _onSubmit(client, id, params) {
    const [_worker, jobId, extranonce2, ntime, nonce] = params;
    const job = this.jobs.get(jobId);
    if (!job) return this._send(client, id, false, [21, 'Job not found']);

    // ---- Reconstruct the full coinbase tx ----
    const coinbaseTx   = CoinbaseBuilder.assembleCoinbase(job.coinb1, client.extranonce1, extranonce2, job.coinb2);
    const coinbaseTxId = CoinbaseBuilder.txId(coinbaseTx);
    const merkleRoot   = CoinbaseBuilder.merkleRoot(coinbaseTxId, job.merkleBranch);

    // ---- Build 80-byte block header ----
    const header = CoinbaseBuilder.buildHeader({
      version:    job.version,
      prevHashHex: job.template.previousblockhash,  // display order — reversed inside buildHeader
      merkleRoot,
      ntimeHex:   ntime,
      bitsHex:    job.bits,
      nonceHex:   nonce,
    });

    // ---- Build full serialised block ----
    const blockHex = CoinbaseBuilder.buildBlock({ header, coinbaseTx, template: job.template });

    const tickers = this.coins.map((c) => c.ticker).join('+');
    this._send(client, id, true);
    client.shares++;
    logger.info(`Share from ${client.worker} job=${jobId} height=${job.height}`, { coin: tickers });
    this.emit('share', { client, job, extranonce2, ntime, nonce, header, coinbaseTx });

    // VarDiff retarget
    const newDiff = this.varDiff.onShare(client);
    if (newDiff !== null) {
      client.difficulty = newDiff;
      client.socket.write(JSON.stringify({
        id: null, method: 'mining.set_difficulty', params: [newDiff],
      }) + '\n');
      logger.debug(`VarDiff ${client.worker}: diff → ${newDiff}`, { coin: tickers });
    }

    // ---- Submit block to the primary coin daemon ----
    this.rpcs[this.coin.ticker].submitBlock(blockHex).catch((e) => {
      logger.error(`submitBlock failed for ${this.coin.ticker}: ${e.message}`, { coin: this.coin.ticker });
    });

    // ---- Submit AuxPoW to WATTx using the aux block committed in this job's coinbase ----
    if (job.auxBlock) {
      const coinbaseBranch = job.merkleBranch.map((h) => Buffer.from(h, 'hex'));
      AuxPoW.trySubmit({
        wattxRPC:          this.wattxRPC,
        parentBlockHeader: header,
        coinbaseTx,
        coinbaseBranch,
        auxBlock:          job.auxBlock,
        logger,
      }).catch(() => {});
    }
  }
}

module.exports = BitcoinStratumServer;
