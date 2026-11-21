#!/bin/sh
# WASM 패리티 수동 게이트: Rust 크레이트에서 Node용 pkg를 다시 빌드하고
# JS<->WASM 교차검증(verify.mjs, 112개 벡터)을 돌린다.
# WASM 관련 변경(크레이트 소스·빌드된 .wasm) 푸시 전에 실행한다:
#   cd m1 && npm run verify:wasm
# pre-push 훅에는 넣지 않는다: cargo 빌드가 느리고 툴체인이
# 워크스페이스 전용($HOME/.cargo)이라 클론만으로는 돌지 않는다.
set -e

ENGINE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM_DIR="$ENGINE_ROOT/../wasm"

if [ ! -d "$WASM_DIR" ]; then
  echo "verify:wasm: Rust 크레이트가 없습니다: $WASM_DIR (워크스페이스 전용)" >&2
  exit 1
fi

export PATH="$HOME/.cargo/bin:$PATH"
# /tmp는 512M tmpfs라 cargo 빌드가 디스크 부족으로 실패할 수 있다.
export TMPDIR="$HOME/tmp"
export CARGO_TARGET_DIR="$HOME/tmp/aldol-wasm-target"

cd "$WASM_DIR"
cargo build --release --target wasm32-unknown-unknown

WASM_FILE="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/aldol_sim.wasm"
if [ ! -f "$WASM_FILE" ]; then
  WASM_FILE="$WASM_DIR/target/wasm32-unknown-unknown/release/aldol_sim.wasm"
fi
if [ ! -f "$WASM_FILE" ]; then
  echo "verify:wasm: 빌드된 .wasm을 찾을 수 없습니다" >&2
  exit 1
fi

# wasm-bindgen CLI는 크레이트 버전(=0.2.100)과 반드시 일치해야 한다.
wasm-bindgen --target nodejs --out-dir pkg "$WASM_FILE"
node verify.mjs
