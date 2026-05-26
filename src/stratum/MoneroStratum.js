// Monero stratum protocol — compatible with XMRig, SRBMiner, lolMiner
// Protocol reference: https://github.com/nicehash/NiceHashQuickMiner/tree/master/app/csharp/Protocol
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const AuxPoW = require('../auxpow/AuxPoW');
const logger = require('../logger');

const TICKER = 'XMR';

class MoneroStratumServer extends EventEmitter {
  constructor(coin, wattxRPC) {
    super();
    this.coin = coin;
    this.wattxRPC = wattxRPC;
    this.port = coin.stratumPort;
    this.clients = new Map();
    this.currentJob = null;
  }

  start() {
    this.server = net.createServer((socket) => this._handleConnection(socket));
    this.server.listen(this.port, () => {
      logger.info(`RandomX stratum listening on port ${this.port} [${TICKER}]`);
    });
    this.server.on('error', (e) => logger.error(`MoneroStratum error: ${e.message}`, { coin: TICKER }));
    this._startJobRefresh();
  }

  _startJobRefresh() {
    this._fetchJob();
    setInterval(() => this._fetchJob(), 30000);
  }

  async _fetchJob() {
    try {
      // Monero uses getblocktemplate via daemon RPC (port 18081 JSON)
      const res = await this._daemonCall('get_block_template', {
        wallet_address: this.coin.address,
        reserve_size: 60,
      });
      this.currentJob = {
        id: crypto.randomBytes(4).toString('hex'),
        blob: res.blocktemplate_blob,
        difficulty: res.difficulty,
        height: res.height,
        seedHash: res.seed_hash || '',
        nextSeedHash: res.next_seed_hash || '',
      };
      logger.info(`New XMR job height=${this.currentJob.height} diff=${this.currentJob.difficulty}`, { coin: TICKER });

      // Push new job to all connected authorized clients
      for (const client of this.clients.values()) {
        if (client.authorized) this._pushJob(client);
      }
    } catch (e) {
      logger.error(`XMR job fetch failed: ${e.message}`, { coin: TICKER });
    }
  }

  // Monero daemon uses HTTP (not stratum) for block templates
  _daemonCall(method, params) {
    const http = require('http');
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(params);
      const options = {
        hostname: this.coin.daemon.host,
        port: this.coin.daemon.port,
        path: `/json_rpc`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.result);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _handleConnection(socket) {
    const clientId = crypto.randomBytes(4).toString('hex');
    const client = {
      id: clientId,
      socket,
      authorized: false,
      worker: null,
      nonces: new Set(),
      buffer: '',
    };
    this.clients.set(clientId, client);
    logger.info(`XMR client connected: ${socket.remoteAddress}`, { coin: TICKER });

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

  _pushJob(client) {
    if (!this.currentJob) return;
    const blob = this._scratchpadBlob(this.currentJob.blob, client.id);
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'job',
      params: {
        blob,
        job_id: this.currentJob.id,
        target: this._diffToTarget(this.currentJob.difficulty),
        id: client.id,
        seed_hash: this.currentJob.seedHash,
        next_seed_hash: this.currentJob.nextSeedHash,
        height: this.currentJob.height,
      },
    }) + '\n';
    client.socket.write(msg);
  }

  // Insert client-specific extranonce into blob nonce field (bytes 39-43)
  _scratchpadBlob(blob, clientId) {
    const bytes = Buffer.from(blob, 'hex');
    const nonceSeed = Buffer.from(clientId, 'hex').readUInt32BE(0);
    bytes.writeUInt32LE(nonceSeed, 39);
    return bytes.toString('hex');
  }

  _diffToTarget(difficulty) {
    // XMR target is a 4-byte big-endian value = 2^32 / difficulty
    const target = Math.floor(0xffffffff / difficulty);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(target);
    return buf.toString('hex');
  }

  _handleMessage(client, line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }

    switch (msg.method) {
      case 'login':      return this._onLogin(client, msg.id, msg.params);
      case 'submit':     return this._onSubmit(client, msg.id, msg.params);
      case 'keepalived': return this._send(client, msg.id, { status: 'KEEPALIVED' });
      case 'getjob':     return this._pushJob(client), this._send(client, msg.id, { status: 'OK' });
      default:
        logger.info(`Unknown XMR method: ${msg.method}`, { coin: TICKER });
    }
  }

  _onLogin(client, id, params) {
    const { login, pass } = params;
    client.authorized = true;
    client.worker = login;
    logger.info(`XMR authorized: ${login}`, { coin: TICKER });

    const result = {
      id: client.id,
      status: 'OK',
      job: this.currentJob ? {
        blob: this._scratchpadBlob(this.currentJob.blob, client.id),
        job_id: this.currentJob.id,
        target: this._diffToTarget(this.currentJob.difficulty),
        id: client.id,
        seed_hash: this.currentJob.seedHash,
        height: this.currentJob.height,
      } : null,
    };
    this._send(client, id, result);
  }

  async _onSubmit(client, id, params) {
    const { job_id, nonce, result: hashResult } = params;

    if (!this.currentJob || job_id !== this.currentJob.id) {
      return this._send(client, id, null, { code: -1, message: 'Invalid job id' });
    }
    if (client.nonces.has(nonce)) {
      return this._send(client, id, null, { code: -2, message: 'Duplicate share' });
    }

    client.nonces.add(nonce);
    this._send(client, id, { status: 'OK' });
    logger.info(`XMR share from ${client.worker} nonce=${nonce}`, { coin: TICKER });

    this.emit('share', { client, job: this.currentJob, nonce, hashResult });

    AuxPoW.trySubmit({
      wattxRPC: this.wattxRPC,
      parentBlockHeader: Buffer.from(this.currentJob.blob, 'hex').slice(0, 76),
      coinbaseTx: Buffer.alloc(0),
      coinbaseBranch: [],
      logger,
    }).catch(() => {});
  }
}

module.exports = MoneroStratumServer;
