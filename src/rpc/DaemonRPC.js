const http = require('http');
const https = require('https');

class DaemonRPC {
  constructor(config) {
    this.host = config.host || '127.0.0.1';
    this.port = config.port;
    this.user = config.user || '';
    this.password = config.password || '';
    this.ssl = config.ssl || false;
    this._id = 1;
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '1.0',
        id: this._id++,
        method,
        params,
      });

      const auth = Buffer.from(`${this.user}:${this.password}`).toString('base64');
      const options = {
        hostname: this.host,
        port: this.port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Basic ${auth}`,
        },
      };

      const transport = this.ssl ? https : http;
      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            resolve(parsed.result);
          } catch (e) {
            reject(new Error(`Invalid JSON from daemon: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy(new Error('RPC request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  async getBlockTemplate(address, capabilities = ['coinbasetxn', 'workid', 'coinbase/append']) {
    return this.call('getblocktemplate', [{ capabilities, rules: ['segwit'] }]);
  }

  async submitBlock(blockHex) {
    return this.call('submitblock', [blockHex]);
  }

  async getBlockCount() {
    return this.call('getblockcount');
  }

  async getMiningInfo() {
    return this.call('getmininginfo');
  }

  async getNetworkHashps() {
    return this.call('getnetworkhashps');
  }

  async validateAddress(address) {
    return this.call('validateaddress', [address]);
  }
}

module.exports = DaemonRPC;
