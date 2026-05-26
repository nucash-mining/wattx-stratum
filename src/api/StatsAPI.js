const express = require('express');
const logger = require('../logger');

class StatsAPI {
  constructor(pool) {
    this.pool = pool;
    this.app = express();
    this._registerRoutes();
  }

  start(port) {
    this.app.listen(port, () => {
      logger.info(`Stats API listening on port ${port}`);
    });
  }

  _registerRoutes() {
    const app = this.app;

    app.use((_, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    });

    // Overall pool stats
    app.get('/api/stats', (_req, res) => {
      res.json(this.pool.getStats());
    });

    // Per-coin stats — used by mm.wattxchange.app network stats pages
    app.get('/api/stats/:coin', (req, res) => {
      const coin = req.params.coin.toUpperCase();
      const stats = this.pool.getCoinStats(coin);
      if (!stats) return res.status(404).json({ error: 'Unknown coin' });
      res.json(stats);
    });

    // Active miners
    app.get('/api/miners', (_req, res) => {
      res.json(this.pool.getMiners());
    });

    // Recent blocks found by the pool
    app.get('/api/blocks', (_req, res) => {
      res.json(this.pool.getRecentBlocks());
    });

    // WATTx AuxPoW block stats
    app.get('/api/auxblocks', (_req, res) => {
      res.json(this.pool.getAuxBlocks());
    });
  }
}

module.exports = StatsAPI;
