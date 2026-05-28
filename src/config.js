module.exports = {
  // WATTx daemon — the aux chain that receives AuxPoW proofs
  wattx: {
    host: '127.0.0.1',
    port: 3889,          // RPC port (wattxd default; chain ID is 2337 but that's separate)
    user: 'wattxrpc',
    password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV',
    address: 'WPTAXDteyU2U1u1LRLXzXiVUjxryeZkAEP',
    auxpowChainId: 1,
    chainId: 2337,       // WATTx EVM chain ID
  },

  // Stats HTTP API port
  statsPort: 8080,

  // Pool backend URL — shares and block finds are reported here
  poolBackend: 'http://127.0.0.1:3001',

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
  //   3343  BIT         (SHA-256d, Bitnet — PoW/PoS hybrid, PoW blocks mined normally)
  coins: {
    XMR: {
      name: 'Monero',
      algorithm: 'randomx',
      stratumPort: 3334,
      daemon: { host: '127.0.0.1', port: 18081, user: '', password: '' },
      address: '4AsjKppNcHfJPekAPKVMsecyVT1v35MVn4N6dsXYSVTZHWsmC66u3sDT5NYavm5udMXHf32Ntb4N2bJqhnN4Gfq2GKZYmMK',
      enabled: true,
    },
    ALT: {
      name: 'Altcoinchain',
      algorithm: 'ethash',
      stratumPort: 3333,
      chainId: 2330,
      daemon: { host: '127.0.0.1', port: 8332, user: '', password: '' },
      address: '0xC9537513C9b2EA9551Dee3c611F1b9238820621b',
      enabled: true,
    },
    OCTA: {
      name: 'Octaspace',
      algorithm: 'ethash',
      stratumPort: 3333,
      chainId: 800001,
      daemon: { host: '127.0.0.1', port: 8546, user: '', password: '' },
      address: '0xC9537513C9b2EA9551Dee3c611F1b9238820621b',
      enabled: false,
    },
    LTC: {
      name: 'Litecoin',
      algorithm: 'scrypt',
      stratumPort: 3337,
      daemon: { host: '127.0.0.1', port: 9332, user: 'wattxrpc', password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV' },
      address: 'LTC_REWARD_ADDRESS',
      enabled: false,
    },
    BTC: {
      name: 'Bitcoin',
      algorithm: 'sha256d',
      stratumPort: 3336,
      // Port 8334: standard 8332 conflicts with ALT (geth-alt uses 8332)
      daemon: { host: '127.0.0.1', port: 8334, user: 'wattxrpc', password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV' },
      address: 'BTC_REWARD_ADDRESS',
      enabled: false,
    },
    DASH: {
      name: 'Dash',
      algorithm: 'x11',
      stratumPort: 3340,
      daemon: { host: '127.0.0.1', port: 9998, user: 'wattxrpc', password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV' },
      address: 'DASH_REWARD_ADDRESS',
      enabled: false,
    },
    ZEN: {
      name: 'Horizen',
      algorithm: 'equihash_200_9',
      stratumPort: 3341,
      daemon: { host: '127.0.0.1', port: 8231, user: 'wattxrpc', password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV' },
      address: 'ZEN_REWARD_ADDRESS',
      enabled: false,
    },
    ZEC: {
      name: 'Zcash',
      algorithm: 'equihash_200_9',
      stratumPort: 3341,
      daemon: { host: '127.0.0.1', port: 8232, user: 'wattxrpc', password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV' },
      address: 'ZEC_REWARD_ADDRESS',
      enabled: false,
    },
    BTCZ: {
      name: 'BitcoinZ',
      algorithm: 'equihash_200_9',
      stratumPort: 3341,
      daemon: { host: '127.0.0.1', port: 1979, user: 'wattxrpc', password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV' },
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
    // Bitnet — SHA-256d hybrid PoW/PoS (QTUM fork).  https://github.com/bitnet-io/bitnet-core
    // Port 3890: default 3889 conflicts with wattxd
    BIT: {
      name: 'Bitnet',
      algorithm: 'sha256d',
      stratumPort: 3343,
      daemon: { host: '127.0.0.1', port: 3890, user: 'wattxrpc', password: 'v4AZR3AmHHbrMkRfhXlkWH6MI1bFeHwV' },
      address: 'BIT_REWARD_ADDRESS',
      enabled: false,
    },
  },
};
