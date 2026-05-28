const config = require('./config');
const logger = require('./logger');
const WattxRPC = require('./auxpow/WattxRPC');
const BitcoinStratumServer = require('./stratum/BitcoinStratum');
const MoneroStratumServer = require('./stratum/MoneroStratum');
const EthashStratumServer = require('./stratum/EthashStratum');
const EquihashStratumServer = require('./stratum/EquihashStratum');
const KaspaStratumServer = require('./stratum/KaspaStratum');
const StatsAPI = require('./api/StatsAPI');
const algorithms = require('./algorithms');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');

// Fire-and-forget POST to the pool backend — never blocks stratum processing
function postToBackend(path, body) {
  const raw = JSON.stringify(body);
  const target = new URL(config.poolBackend + path);
  const req = http.request({
    hostname: target.hostname,
    port:     parseInt(target.port) || 80,
    path:     target.pathname,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
  });
  req.on('error', (e) => logger.warn(`Pool backend POST ${path} failed: ${e.message}`));
  req.write(raw);
  req.end();
}

// ---- Native addon capability check ----
// Map each algorithm name to the loaded module so we can inspect nativeRequired.
// Algorithms whose native dep failed to load will have their verify() throw — catch that
// here at startup rather than silently accepting miners and crashing on first share.
const unavailableAlgorithms = new Set();
for (const [name, algo] of Object.entries(algorithms)) {
  if (!algo.nativeRequired) continue;
  try {
    // Probe: call hash/verify with a dummy buffer — if the dep loaded, it throws a
    // data-validation error; if it didn't load, it throws the "not installed" error.
    const probe = Buffer.alloc(80);
    if (algo.hash) algo.hash(probe);
    else algo.verify(probe, probe, probe);
  } catch (e) {
    if (e.message.includes('not installed')) {
      unavailableAlgorithms.add(name);
      logger.warn(`Algorithm '${name}' disabled — native addon not installed. Coins using this algorithm will be skipped.`);
    }
    // Any other error means the addon loaded but rejected bad input — that's fine.
  }
}

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
  if (unavailableAlgorithms.has(coinConfig.algorithm)) {
    logger.warn(`Skipping ${ticker} — algorithm '${coinConfig.algorithm}' native addon unavailable`);
    continue;
  }
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
  } else if (algorithm === 'equihash_200_9') {
    server = new EquihashStratumServer(coins, wattxRPC);
  } else if (algorithm === 'kheavyhash') {
    server = new KaspaStratumServer(coins[0], wattxRPC);
  } else {
    server = new BitcoinStratumServer(coins, wattxRPC);
  }

  const tickers = coins.map((c) => c.ticker).join('+');

  const handleShare = ({ client, job, isBlock, height: shareHeight }) => {
    const workerStr  = client.worker || 'unknown';
    const dot        = workerStr.indexOf('.');
    const address    = dot > 0 ? workerStr.slice(0, dot) : workerStr;
    const workerName = dot > 0 ? workerStr.slice(dot + 1) : 'default';
    const height     = job?.height || shareHeight || 0;

    logger.info(`Share accepted: ${workerStr}${isBlock ? ' BLOCK!' : ''}`, { coin: tickers });

    postToBackend('/api/share', {
      address,
      worker_name:  workerName,
      difficulty:   client.difficulty,
      valid:        true,
      block_height: height,
      algorithm,
    });

    if (isBlock) {
      postToBackend('/api/block', {
        height,
        hash:           '',
        reward:         0,
        finder_address: address,
        finder_worker:  workerName,
        algorithm,
      });
    }
  };

  const handleBlock = ({ client, coin, height, hash }) => {
    const workerStr  = client?.worker || 'unknown';
    const dot        = workerStr.indexOf('.');
    const address    = dot > 0 ? workerStr.slice(0, dot) : workerStr;
    const workerName = dot > 0 ? workerStr.slice(dot + 1) : 'default';
    logger.info(`Block found for ${coin.ticker} at height=${height} by ${workerStr}`, { coin: coin.ticker });
    postToBackend('/api/block', {
      height,
      hash,
      reward:         0,
      finder_address: address,
      finder_worker:  workerName,
      algorithm:      coin.algorithm || algorithm,
    });
  };

  server.on('share', handleShare);
  server.on('block', handleBlock);

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
