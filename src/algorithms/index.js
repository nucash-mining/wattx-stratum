// Each algorithm module exports: { verify(header, target) -> bool, name, nativeRequired }
// verify() returns true if the hash of `header` meets `target` difficulty.
// `header` is a Buffer; `target` is a Buffer (32 bytes, little-endian).

module.exports = {
  randomx:       require('./randomx'),
  ethash:        require('./ethash'),
  scrypt:        require('./scrypt'),
  sha256d:       require('./sha256d'),
  x11:           require('./x11'),
  equihash_200_9: require('./equihash'),
  kheavyhash:    require('./kheavyhash'),
};
