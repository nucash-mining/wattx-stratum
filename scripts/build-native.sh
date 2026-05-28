#!/usr/bin/env bash
# Build optional native addons for wattx-stratum and copy to native/.
# Requires: cmake, make, g++, node-gyp (via npx), python3.
# Run from the wattx-stratum project root.
set -euo pipefail
POOL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cd "$POOL_DIR"
mkdir -p native

echo "=== Installing system dependencies ==="
if command -v dnf &>/dev/null; then
  sudo dnf install -y libsodium-devel
elif command -v apt-get &>/dev/null; then
  sudo apt-get install -y libsodium-dev
fi

echo "=== Installing packages (no build) ==="
npm install github:s-nomp/equihashverify github:zone117x/node-multi-hashing github:prudanoff/node-randomx --no-save --ignore-scripts

echo "=== Patching binding.gyp files for C++17 ==="
perl -pi -e 's/-std=c\+\+11/-std=c++17/' node_modules/equihashverify/binding.gyp
perl -pi -e 's/-std=c\+\+14/-std=c++17/' node_modules/multi-hashing/binding.gyp

echo "=== Patching equihashverify.cc for Node 22 V8 API ==="
python3 - <<'PYEOF'
import sys
cc = open('node_modules/equihashverify/equihashverify.cc').read()
cc = cc.replace(
    'void Verify(const v8::FunctionCallbackInfo<Value>& args) {\n    Isolate* isolate = Isolate::GetCurrent();\n    HandleScope scope(isolate);',
    'void Verify(const v8::FunctionCallbackInfo<Value>& args) {\n    Isolate* isolate = Isolate::GetCurrent();\n    Local<Context> ctx = isolate->GetCurrentContext();\n    HandleScope scope(isolate);'
)
for old, new in [
    ('String::NewFromUtf8(isolate, "Wrong number of arguments")', 'String::NewFromUtf8(isolate, "Wrong number of arguments").ToLocalChecked()'),
    ('String::NewFromUtf8(isolate, "Fourth and fifth parameters should be equihash parameters (n, k)")', 'String::NewFromUtf8(isolate, "Fourth and fifth parameters should be equihash parameters (n, k)").ToLocalChecked()'),
    ('String::NewFromUtf8(isolate, "First two arguments should be buffer objects.")', 'String::NewFromUtf8(isolate, "First two arguments should be buffer objects.").ToLocalChecked()'),
    ('String::NewFromUtf8(isolate, "Third argument should be the personalization string.")', 'String::NewFromUtf8(isolate, "Third argument should be the personalization string.").ToLocalChecked()'),
    ('Local<Object> header = args[0]->ToObject();', 'Local<Object> header = args[0]->ToObject(ctx).ToLocalChecked();'),
    ('Local<Object> solution = args[1]->ToObject();', 'Local<Object> solution = args[1]->ToObject(ctx).ToLocalChecked();'),
    ('String::Utf8Value str(args[2]);', 'String::Utf8Value str(isolate, args[2]);'),
]:
    cc = cc.replace(old, new)
open('node_modules/equihashverify/equihashverify.cc', 'w').write(cc)
print('equihashverify.cc patched')
PYEOF

echo "=== Building RandomX static library ==="
git clone --depth=1 https://github.com/tevador/RandomX.git "$TMP/randomx-src"
mkdir -p "$TMP/randomx-build"
cmake "$TMP/randomx-src" -B "$TMP/randomx-build" -DARCH=native -DBUILD_SHARED_LIBS=OFF -Wno-dev
make -C "$TMP/randomx-build" -j"$(nproc)"
cp "$TMP/randomx-build/librandomx.a" node_modules/node-randomx/
cp "$TMP/randomx-src/src/randomx.h" node_modules/node-randomx/

echo "=== Building native addons ==="
(cd node_modules/equihashverify && npx node-gyp rebuild)
(cd node_modules/multi-hashing && npx node-gyp rebuild)
(cd node_modules/node-randomx && npx node-gyp rebuild)

echo "=== Copying .node files to native/ ==="
cp node_modules/equihashverify/build/Release/equihashverify.node native/
cp node_modules/multi-hashing/build/Release/multihashing.node native/
cp node_modules/node-randomx/build/Release/addon.node native/randomx.node

echo "=== Done. Native addons ready in native/ ==="
ls -lh native/*.node
