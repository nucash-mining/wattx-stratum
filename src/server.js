const config = require('./config');
const logger = require('./logger');
const WattxRPC = require('./auxpow/WattxRPC');
const BitcoinStratumServer = require('./stratum/BitcoinStratum');
const MoneroStratumServer = require('./stratum/MoneroStratum');
const EthashStratumServer = require('./stratum/EthashStratum');
const StatsAPI = require('./api/StatsAPI');
const fs = require('fs');

// Ensure log directory exists
if (!fs.existsSync('logs')) fs.mkdirSync('logs');

// ---- Pool state (shared across all stratum servers) ----
const recentBlocks = [];
const auxBlocks = [];

function pool(servers) {
  return {
    getStats() {
      let totalMiners = 0;
      const coins = {};
      for (const srv of servers) {
        const ticker = srv.coin ? srv.coin.ticker : (srv.coins && srv.coins[0] && srv.coins[0].ticker);
        const count = [...srv.clients.values()].filter((c) => c.authorized).length;
        totalMiners += count;
        if (ticker) coins[ticker] = count;
      }
      return { totalMiners, coins, blocks: recentBlocks.length, auxBlocks: auxBlocks.length };
    },
    getCoinStats(ticker) {
      const coinConfig = config.coins[ticker];
      if (!coinConfig) return null;
      const srv = servers.find((s) => s.coin && s.coin.ticker === ticker);
      const miners = srv ? [...srv.clients.values()].filter((c) => c.authorized).length : 0;
      return { ticker, algorithm: coinConfig.algorithm, port: coinConfig.stratumPort, miners };
    },
    getMiners() {
      const result = [];
      for (const srv of servers) {
        const ticker = srv.coin && srv.coin.ticker;
        for (const c of srv.clients.values()) {
          if (c.authorized) result.push({ worker: c.worker, coin: ticker });
        }
      }
      return result;
    },
    getRecentBlocks: () => recentBlocks.slice(-50),
    getAuxBlocks: () => auxBlocks.slice(-50),
  };
}

// ---- WATTx RPC ----
const wattxRPC = new WattxRPC(config.wattx);

// ---- Group enabled coins by port (coins sharing a port are mined simultaneously) ----
const byPort = {};
for (const [ticker, coinConfig] of Object.entries(config.coins)) {
  if (!coinConfig.enabled) continue;
  const coin = { ticker, ...coinConfig };
  if (!byPort[coin.stratumPort]) byPort[coin.stratumPort] = [];
  byPort[coin.stratumPort].push(coin);
}

// ---- One stratum server per port ----
const servers = [];

for (const [port, coins] of Object.entries(byPort)) {
  const { algorithm } = coins[0];
  let server;

  if (algorithm === 'randomx') {
    server = new MoneroStratumServer(coins[0], wattxRPC);
  } else if (algorithm === 'ethash') {
    server = new EthashStratumServer(coins, wattxRPC);
  } else {
    server = new BitcoinStratumServer(coins, wattxRPC);
  }

  const tickers = coins.map((c) => c.ticker).join('+');
  server.on('share', ({ client }) => {
    logger.info(`Share accepted: ${client.worker}`, { coin: tickers });
  });

  server.start();
  servers.push(server);
  logger.info(`Started port ${port} [${tickers}] (${algorithm})`);
}

// ---- Stats API ----
const api = new StatsAPI(pool(servers));
api.start(config.statsPort);

const active = Object.entries(byPort)
  .map(([port, coins]) => `${coins.map((c) => c.ticker).join('+')}:${port}`)
  .join('  ');
logger.info(`WATTx stratum running — ${active}`);

process.on('uncaughtException', (e) => logger.error(`Uncaught exception: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', (e) => logger.error(`Unhandled rejection: ${e}`));
