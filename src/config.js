module.exports = {
  // WATTx daemon — the aux chain that receives AuxPoW proofs
  wattx: {
    host: '127.0.0.1',
    port: 3889,
    user: 'wattxrpc',
    password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV',
    address: 'WATTX_REWARD_ADDRESS',
    auxpowChainId: 1,
  },

  // Stats HTTP API port
  statsPort: 8080,

  // Port map — matches stratum.wattxchange.app exactly.
  // Coins sharing a port are mined SIMULTANEOUSLY: one connection earns all coins on that port + WTX.
  //
  //   3333  ALT + OCTA  (Ethash — one miner earns both EVM chains)
  //   3334  XMR         (RandomX)
  //   3336  BTC         (SHA-256d)
  //   3337  LTC         (Scrypt)
  //   3340  DASH        (X11)
  //   3341  ZEN + ZEC + BTCZ  (Equihash 200,9 — one miner earns all three)
  //   3342  KAS         (kHeavyHash)
  coins: {
    XMR: {
      name: 'Monero',
      algorithm: 'randomx',
      stratumPort: 3334,
      daemon: { host: '127.0.0.1', port: 18081, user: '', password: '' },
      address: 'XMR_REWARD_ADDRESS',
      enabled: true,
    },
    ALT: {
      name: 'Altcoinchain',
      algorithm: 'ethash',
      stratumPort: 3333,
      chainId: 2330,
      daemon: { host: '127.0.0.1', port: 8332, user: '', password: '' },
      address: 'ALT_REWARD_ADDRESS',
      enabled: true,
    },
    OCTA: {
      name: 'Octaspace',
      algorithm: 'ethash',
      stratumPort: 3333,
      chainId: 800001,
      daemon: { host: '127.0.0.1', port: 8546, user: '', password: '' },
      address: 'OCTA_REWARD_ADDRESS',
      enabled: false,
    },
    LTC: {
      name: 'Litecoin',
      algorithm: 'scrypt',
      stratumPort: 3337,
      daemon: { host: '127.0.0.1', port: 9332, user: 'rpcuser', password: 'rpcpassword' },
      address: 'LTC_REWARD_ADDRESS',
      enabled: false,
    },
    BTC: {
      name: 'Bitcoin',
      algorithm: 'sha256d',
      stratumPort: 3336,
      daemon: { host: '127.0.0.1', port: 8332, user: 'rpcuser', password: 'rpcpassword' },
      address: 'BTC_REWARD_ADDRESS',
      enabled: false,
    },
    DASH: {
      name: 'Dash',
      algorithm: 'x11',
      stratumPort: 3340,
      daemon: { host: '127.0.0.1', port: 9998, user: 'rpcuser', password: 'rpcpassword' },
      address: 'DASH_REWARD_ADDRESS',
      enabled: false,
    },
    ZEN: {
      name: 'Horizen',
      algorithm: 'equihash_200_9',
      stratumPort: 3341,
      daemon: { host: '127.0.0.1', port: 8231, user: 'rpcuser', password: 'rpcpassword' },
      address: 'ZEN_REWARD_ADDRESS',
      enabled: false,
    },
    ZEC: {
      name: 'Zcash',
      algorithm: 'equihash_200_9',
      stratumPort: 3341,
      daemon: { host: '127.0.0.1', port: 8232, user: 'rpcuser', password: 'rpcpassword' },
      address: 'ZEC_REWARD_ADDRESS',
      enabled: false,
    },
    BTCZ: {
      name: 'BitcoinZ',
      algorithm: 'equihash_200_9',
      stratumPort: 3341,
      daemon: { host: '127.0.0.1', port: 1979, user: 'rpcuser', password: 'rpcpassword' },
      address: 'BTCZ_REWARD_ADDRESS',
      enabled: false,
    },
    KAS: {
      name: 'Kaspa',
      algorithm: 'kheavyhash',
      stratumPort: 3342,
      daemon: { host: '127.0.0.1', port: 16110, user: '', password: '' },
      address: 'KAS_REWARD_ADDRESS',
      enabled: false,
    },
  },
};
