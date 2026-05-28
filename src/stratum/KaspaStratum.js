'use strict';
// Kaspa stratum — kHeavyHash / kaspad gRPC
// Protocol compatible with lolMiner, BzMiner, T-Rex, SRBMiner (Kaspa mode)
//
// notify params : [jobId, timestampHex, bitsHex, prePowHashHex, cleanJobs]
// set_target    : [target32ByteHex]   (pool difficulty as full target)
// submit params : [worker, jobId, nonce16hex]   (nonce = uint64 LE, 8 bytes)

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const KaspaRPC = require('../rpc/KaspaRPC');
const VarDiff = require('./VarDiff');
const kheavyhash = require('../algorithms/kheavyhash');
const { diffToTarget, bitsToTarget } = require('../utils/mining');
const logger = require('../logger');

const ALGO_DEFS = VarDiff.defaultsFor('kheavyhash');

class KaspaStratumServer extends EventEmitter {
  constructor(coin, wattxRPC) {
    super();
    this.coin     = coin;
    this.wattxRPC = wattxRPC;
    this.port     = coin.stratumPort;

    this.clients  = new Map();
    this.jobs     = new Map();

    this.rpc = new KaspaRPC(coin.daemon);

    this.varDiff = new VarDiff({ minDiff: ALGO_DEFS.min, maxDiff: ALGO_DEFS.max });
    this.initialDifficulty = ALGO_DEFS.initial;
  }

  start() {
    this.server = net.createServer((socket) => this._handleConnection(socket));
    this.server.listen(this.port, () => {
      logger.info(`kHeavyHash stratum listening on port ${this.port} [KAS]`);
    });
    this.server.on('error', (e) => logger.error(`KaspaStratum error: ${e.message}`, { coin: 'KAS' }));
    this._startJobRefresh();
  }

  _startJobRefresh() {
    this._refreshJob();
    setInterval(() => this._refreshJob(), 10000); // Kaspa blocks ~1s, refresh often
  }

  async _refreshJob() {
    try {
      const res   = await this.rpc.getBlockTemplate(this.coin.address);
      if (!res.isSynced) {
        logger.warn('Kaspa node not synced — skipping job', { coin: 'KAS' });
        return;
      }
      const block      = res.block;
      const prePowHash = this.rpc.computePrePowHash(block);
      const jobId      = crypto.randomBytes(4).toString('hex');

      const job = {
        id:         jobId,
        block,                    // full RpcBlock — used for SubmitBlock on block find
        prePowHash,               // 32-byte Buffer
        bits:       block.header.bits,
        timestamp:  block.header.timestamp,
      };

      this.jobs.set(jobId, job);
      if (this.jobs.size > 8) this.jobs.delete(this.jobs.keys().next().value);

      this._broadcastJob(job, true);
    } catch (e) {
      logger.error(`KAS job refresh failed: ${e.message}`, { coin: 'KAS' });
    }
  }

  _broadcastJob(job, clean) {
    const n = this._buildNotify(job, clean);
    for (const client of this.clients.values()) {
      if (client.authorized) {
        client.socket.write(JSON.stringify(n) + '\n');
      }
    }
  }

  _buildNotify(job, clean) {
    const bitsHex      = Number(job.bits).toString(16).padStart(8, '0');
    const timestampHex = BigInt(job.timestamp || 0).toString(16);
    const prePowHex    = job.prePowHash.toString('hex');
    return {
      id:     null,
      method: 'mining.notify',
      params: [job.id, timestampHex, bitsHex, prePowHex, clean],
    };
  }

  _sendTarget(client) {
    const target = diffToTarget(client.difficulty).toString('hex');
    client.socket.write(JSON.stringify({
      id: null, method: 'mining.set_target', params: [target],
    }) + '\n');
  }

  _handleConnection(socket) {
    const clientId = crypto.randomBytes(4).toString('hex');
    const client = {
      id:         clientId,
      socket,
      authorized: false,
      worker:     null,
      difficulty: this.initialDifficulty,
      shares:     0,
      nonces:     new Set(),
      buffer:     '',
    };
    this.clients.set(clientId, client);
    logger.info(`KAS client connected: ${socket.remoteAddress} [${clientId}]`, { coin: 'KAS' });

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
    if (c) {
      logger.info(`KAS client disconnected: ${c.id}`, { coin: 'KAS' });
      this.clients.delete(id);
    }
  }

  _send(client, id, result, error = null) {
    client.socket.write(JSON.stringify({ id, result, error }) + '\n');
  }

  _handleMessage(client, line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    switch (msg.method) {
      case 'mining.subscribe':            return this._onSubscribe(client, msg.id);
      case 'mining.authorize':            return this._onAuthorize(client, msg.id, msg.params);
      case 'mining.submit':               return this._onSubmit(client, msg.id, msg.params);
      case 'mining.extranonce.subscribe': return this._send(client, msg.id, true);
      default: logger.info(`Unknown KAS method: ${msg.method}`, { coin: 'KAS' });
    }
  }

  _onSubscribe(client, id) {
    this._send(client, id, [
      [['mining.set_target', '1'], ['mining.notify', client.id]],
      client.id,
      0,
    ]);
    this._sendTarget(client);
  }

  _onAuthorize(client, id, params) {
    const [workerName] = params;
    client.authorized = true;
    client.worker     = workerName;
    this._send(client, id, true);
    logger.info(`KAS authorized: ${workerName}`, { coin: 'KAS' });

    const job = [...this.jobs.values()].pop();
    if (job) {
      client.socket.write(JSON.stringify(this._buildNotify(job, true)) + '\n');
    }
  }

  async _onSubmit(client, id, params) {
    const [_worker, jobId, nonceHex] = params;
    const job = this.jobs.get(jobId);
    if (!job) return this._send(client, id, false, [21, 'Job not found']);

    // nonce: 16 hex chars = 8 bytes LE uint64
    const normalizedNonce = (nonceHex || '').toLowerCase().padStart(16, '0');
    if (client.nonces.has(normalizedNonce)) {
      return this._send(client, id, false, [22, 'Duplicate share']);
    }

    const nonceBuf  = Buffer.from(normalizedNonce, 'hex'); // 8 bytes LE
    const poolTarget = diffToTarget(client.difficulty);
    const netTarget  = bitsToTarget(Number(job.bits).toString(16).padStart(8, '0'));

    let validShare = true;
    let isBlock    = false;
    try {
      if (!kheavyhash.verify(job.prePowHash, nonceBuf, poolTarget)) {
        return this._send(client, id, false, [23, 'Low difficulty share']);
      }
      isBlock = kheavyhash.verify(job.prePowHash, nonceBuf, netTarget);
    } catch (e) {
      logger.warn(`kHeavyHash validation skipped (${e.message})`, { coin: 'KAS' });
    }

    client.nonces.add(normalizedNonce);
    this._send(client, id, true);
    client.shares++;
    logger.info(`KAS share from ${client.worker} job=${jobId}${isBlock ? ' BLOCK!' : ''}`, { coin: 'KAS' });
    this.emit('share', { client, job, nonceHex: normalizedNonce, isBlock });

    // VarDiff
    const newDiff = this.varDiff.onShare(client);
    if (newDiff !== null) {
      client.difficulty = newDiff;
      this._sendTarget(client);
      logger.debug(`VarDiff KAS ${client.worker}: diff → ${newDiff}`, { coin: 'KAS' });
    }

    if (isBlock) {
      // Clone block, update nonce, submit to kaspad
      const blockToSubmit = JSON.parse(JSON.stringify(job.block));
      blockToSubmit.header.nonce = nonceBuf.readBigUInt64LE(0).toString();

      this.rpc.submitBlock(blockToSubmit).then((res) => {
        if (res.rejectReason && res.rejectReason !== 'NONE') {
          logger.error(`KAS submitBlock rejected: ${res.rejectReason}`, { coin: 'KAS' });
        } else {
          logger.info(`KAS block submitted successfully!`, { coin: 'KAS' });
        }
      }).catch((e) => {
        logger.error(`KAS submitBlock error: ${e.message}`, { coin: 'KAS' });
      });

      // Kaspa doesn't use AuxPoW — skip
    }
  }
}

module.exports = KaspaStratumServer;
