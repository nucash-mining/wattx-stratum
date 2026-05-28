'use strict';
// Equihash stratum — ZEN, ZEC, BTCZ (Equihash 200,9)
// Protocol: Zcash Stratum (extended) — mining.notify with 140-byte header split,
//           mining.submit includes 32-byte nNonce + 1344-byte solution.
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const DaemonRPC = require('../rpc/DaemonRPC');
const AuxPoW = require('../auxpow/AuxPoW');
const CoinbaseBuilder = require('../coinbase/CoinbaseBuilder');
const VarDiff = require('./VarDiff');
const equihashAlgo = require('../algorithms/equihash');
const { diffToTarget, bitsToTarget } = require('../utils/mining');
const logger = require('../logger');

const ALGO_DEFS    = VarDiff.defaultsFor('equihash_200_9');
const EXTRANONCE1_SIZE = 4;  // bytes embedded at start of the 32-byte nNonce
const EXTRANONCE2_SIZE = 4;  // bytes following extranonce1 in nNonce
// Remaining 24 bytes of nNonce are miner-controlled (set to zero in pool's nNonce field)

class EquihashStratumServer extends EventEmitter {
  constructor(coins, wattxRPC) {
    super();
    this.coins    = Array.isArray(coins) ? coins : [coins];
    this.coin     = this.coins[0];
    this.wattxRPC = wattxRPC;
    this.port     = this.coin.stratumPort;

    this.clients  = new Map();
    this.jobs     = new Map();
    this.extranonce1Counter = 0;

    this.rpcs = {};
    for (const c of this.coins) this.rpcs[c.ticker] = new DaemonRPC(c.daemon);

    this.varDiff = new VarDiff({ minDiff: ALGO_DEFS.min, maxDiff: ALGO_DEFS.max });
    this.initialDifficulty = ALGO_DEFS.initial;
  }

  start() {
    const tickers = this.coins.map((c) => c.ticker).join('+');
    this.server = net.createServer((socket) => this._handleConnection(socket));
    this.server.listen(this.port, () => {
      logger.info(`Equihash stratum listening on port ${this.port} [${tickers}]`);
    });
    this.server.on('error', (e) => logger.error(`EquihashStratum error: ${e.message}`, { coin: tickers }));
    this._startJobRefresh();
  }

  _startJobRefresh() {
    this._refreshJob();
    setInterval(() => this._refreshJob(), 30000);
  }

  async _refreshJob() {
    try {
      const template = await this.rpcs[this.coin.ticker].getBlockTemplate(this.coin.address);
      const job      = await this._buildJob(template);
      this.jobs.set(job.id, job);
      if (this.jobs.size > 8) this.jobs.delete(this.jobs.keys().next().value);
      this._broadcastJob(job, true);
    } catch (e) {
      logger.error(`Equihash job refresh failed: ${e.message}`, { coin: this.coin.ticker });
    }
  }

  async _buildJob(template) {
    const jobId = crypto.randomBytes(4).toString('hex');

    let auxBlock = null;
    try { auxBlock = await this.wattxRPC.getAuxBlock(); } catch (_) {}
    const auxHash = auxBlock ? Buffer.from(auxBlock.hash, 'hex') : null;

    const { coinb1, coinb2, merkleBranch } = CoinbaseBuilder.build({
      template,
      address: this.coin.address,
      auxHash,
    });

    // Build merkle root from coinbase (with zeroed extranonces) for the notify
    const dummyCoinbase = CoinbaseBuilder.assembleCoinbase(coinb1, '00000000', '00000000', coinb2);
    const merkleRoot    = CoinbaseBuilder.merkleRoot(CoinbaseBuilder.txId(dummyCoinbase), merkleBranch);

    // hashReserved: Sapling/auth root from template, or zeros
    const hashReserved = Buffer.from(template.defaultwitness || template.finalsaplingroothash || '0'.repeat(64), 'hex').reverse();

    return {
      id: jobId,
      template,
      auxBlock,
      coinb1,
      coinb2,
      merkleBranch,
      merkleRoot,  // 32-byte internal-order Buffer
      hashReserved,
      height:   template.height,
      version:  template.version  || 4,
      bits:     template.bits,
      curtime:  template.curtime,
      prevhash: Buffer.from(template.previousblockhash, 'hex').reverse(),
    };
  }

  _broadcastJob(job, clean) {
    const n = this._buildNotify(job, clean);
    for (const client of this.clients.values()) {
      if (client.authorized) client.socket.write(JSON.stringify(n) + '\n');
    }
  }

  _buildNotify(job, clean) {
    const versionLE  = leHex32(job.version);
    const prevhashLE = job.prevhash.toString('hex');
    const merkleLE   = job.merkleRoot.toString('hex');
    const reservedLE = job.hashReserved.toString('hex');
    const ntimeLE    = leHex32(job.curtime);
    const bitsLE     = job.bits; // already in LE string from daemon
    return {
      id: null,
      method: 'mining.notify',
      params: [job.id, versionLE, prevhashLE, merkleLE, reservedLE, ntimeLE, bitsLE, clean],
    };
  }

  _handleConnection(socket) {
    const clientId    = crypto.randomBytes(4).toString('hex');
    const extranonce1 = (this.extranonce1Counter++).toString(16).padStart(8, '0');
    const client = {
      id:         clientId,
      socket,
      extranonce1,
      authorized: false,
      worker:     null,
      difficulty: this.initialDifficulty,
      shares:     0,
      buffer:     '',
    };
    this.clients.set(clientId, client);
    logger.info(`Equihash client connected: ${socket.remoteAddress} [${clientId}]`, { coin: this.coin.ticker });

    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      client.buffer += data;
      const lines = client.buffer.split('\n');
      client.buffer = lines.pop();
      for (const line of lines) if (line.trim()) this._handleMessage(client, line.trim());
    });
    socket.on('end',   () => this._removeClient(clientId));
    socket.on('error', () => this._removeClient(clientId));
  }

  _removeClient(id) {
    const c = this.clients.get(id);
    if (c) { logger.info(`Equihash client disconnected: ${c.id}`); this.clients.delete(id); }
  }

  _send(client, id, result, error = null) {
    client.socket.write(JSON.stringify({ id, result, error }) + '\n');
  }

  _handleMessage(client, line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    switch (msg.method) {
      case 'mining.subscribe':           return this._onSubscribe(client, msg.id);
      case 'mining.authorize':           return this._onAuthorize(client, msg.id, msg.params);
      case 'mining.submit':              return this._onSubmit(client, msg.id, msg.params);
      case 'mining.extranonce.subscribe': return this._send(client, msg.id, true);
      default: logger.info(`Unknown Equihash method: ${msg.method}`);
    }
  }

  _onSubscribe(client, id) {
    this._send(client, id, ['equihash', client.id, null, EXTRANONCE2_SIZE]);
    client.socket.write(JSON.stringify({
      id: null, method: 'mining.set_difficulty', params: [client.difficulty],
    }) + '\n');
  }

  _onAuthorize(client, id, params) {
    const [workerName] = params;
    client.authorized = true;
    client.worker     = workerName;
    this._send(client, id, true);
    logger.info(`Equihash authorized: ${workerName}`, { coin: this.coin.ticker });
    const job = [...this.jobs.values()].pop();
    if (job) client.socket.write(JSON.stringify(this._buildNotify(job, true)) + '\n');
  }

  async _onSubmit(client, id, params) {
    // params: [worker, jobId, ntime, nNonce32hex, solution1344hex]
    const [_worker, jobId, ntime, nNonceHex, solutionHex] = params;
    const job = this.jobs.get(jobId);
    if (!job) return this._send(client, id, false, [21, 'Job not found']);

    // Reconstruct coinbase using the extranonce embedded in nNonce
    const extranonce2 = nNonceHex.slice(8, 16); // bytes 4-8 of the 32-byte nNonce
    const coinbaseTx  = CoinbaseBuilder.assembleCoinbase(job.coinb1, client.extranonce1, extranonce2, job.coinb2);
    const merkleRoot  = CoinbaseBuilder.merkleRoot(CoinbaseBuilder.txId(coinbaseTx), job.merkleBranch);

    // Build 140-byte Zcash block header
    const header = buildZcashHeader({
      version:     job.version,
      prevhash:    job.prevhash,
      merkleRoot,
      hashReserved: job.hashReserved,
      ntime:        parseInt(ntime, 16),
      bits:         parseInt(job.bits, 16),
      nNonce:       Buffer.from(nNonceHex.padEnd(64, '0'), 'hex'),
    });

    const solutionBuf = Buffer.from(solutionHex, 'hex');
    const poolTarget  = diffToTarget(client.difficulty);
    const netTarget   = bitsToTarget(job.bits);

    // ---- Equihash solution + difficulty check ----
    let validShare = true;
    let isBlock    = false;
    try {
      if (!equihashAlgo.verify(header, solutionBuf, poolTarget)) {
        return this._send(client, id, false, [23, 'Low difficulty share']);
      }
      isBlock = equihashAlgo.verify(header, solutionBuf, netTarget);
    } catch (e) {
      logger.warn(`Equihash validation skipped (${e.message})`, { coin: this.coin.ticker });
    }

    this._send(client, id, true);
    client.shares++;
    const tickers = this.coins.map((c) => c.ticker).join('+');
    logger.info(`Equihash share from ${client.worker} job=${jobId}${isBlock ? ' BLOCK!' : ''}`, { coin: tickers });
    this.emit('share', { client, job, nNonceHex, solutionHex, isBlock });

    // VarDiff
    const newDiff = this.varDiff.onShare(client);
    if (newDiff !== null) {
      client.difficulty = newDiff;
      client.socket.write(JSON.stringify({
        id: null, method: 'mining.set_difficulty', params: [newDiff],
      }) + '\n');
    }

    if (isBlock) {
      // Build and submit block to each coin
      for (const c of this.coins) {
        const blockHex = buildZcashBlock({ header, solution: solutionBuf, coinbaseTx, template: job.template });
        this.rpcs[c.ticker].submitBlock(blockHex).catch((e) => {
          logger.error(`Equihash submitBlock failed for ${c.ticker}: ${e.message}`);
        });
      }

      if (job.auxBlock) {
        const coinbaseBranch = job.merkleBranch.map((h) => Buffer.from(h, 'hex'));
        AuxPoW.trySubmit({
          wattxRPC: this.wattxRPC, parentBlockHeader: header,
          coinbaseTx, coinbaseBranch, auxBlock: job.auxBlock, logger,
        }).catch(() => {});
      }
    }
  }
}

// ---- Zcash-specific serialization helpers ------------------------------------

function leHex32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b.toString('hex');
}

function buildZcashHeader({ version, prevhash, merkleRoot, hashReserved, ntime, bits, nNonce }) {
  const buf = Buffer.alloc(140);
  buf.writeInt32LE(version, 0);
  prevhash.copy(buf, 4);             // 32 bytes (already LE/internal)
  merkleRoot.copy(buf, 36);          // 32 bytes
  hashReserved.copy(buf, 68);        // 32 bytes (Sapling root or zeros)
  buf.writeUInt32LE(ntime, 100);     // 4 bytes
  buf.writeUInt32LE(bits, 104);      // 4 bytes
  nNonce.copy(buf, 108);             // 32 bytes
  return buf;
}

function buildZcashBlock({ header, solution, coinbaseTx, template }) {
  // Solution size: 1344 bytes → Bitcoin varint = 0xfd 0x40 0x05
  const solSizeVarint = Buffer.from([0xfd, 0x40, 0x05]);
  const extraTxs = (template.transactions || []).map((tx) => Buffer.from(tx.data, 'hex'));
  const txCount  = Buffer.alloc(1); txCount.writeUInt8(1 + extraTxs.length);
  return Buffer.concat([
    header,
    solSizeVarint,
    solution,
    txCount,
    coinbaseTx,
    ...extraTxs,
  ]).toString('hex');
}

module.exports = EquihashStratumServer;
