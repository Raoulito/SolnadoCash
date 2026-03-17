#!/bin/bash
# scripts/trusted_setup.sh
#
# Trusted setup ceremony for SolnadoCash ZK circuits.
# Run ONCE after circuits are frozen (Phase 1 complete, T06 verified).
#
# Output:
#   circuits/build/withdraw_final.zkey
#   circuits/build/deposit_final.zkey
#   circuits/build/withdraw_vk.json
#   circuits/build/deposit_vk.json
#
# WARNING: DO NOT re-run after this script completes.
# Re-running invalidates all existing proving/verifying keys.
# Existing notes generated from old keys become unspendable.
#
# After completing:
#   git add circuits/build/withdraw_final.zkey circuits/build/deposit_final.zkey
#   git add circuits/build/withdraw_vk.json circuits/build/deposit_vk.json
#   git tag trusted-setup-v1
#   git push --tags
#
# See PROJET_enhanced.md Section 12.8 for context.
set -e

CIRCUITS_DIR="$(cd "$(dirname "$0")/../circuits" && pwd)"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build"

# Powers of Tau — Hermez public ceremony (supports up to 2^17 constraints)
# The withdraw circuit has ~25k constraints (20-level Merkle + 4 Poseidon = ~25k R1CS rows)
# pot17 (131k constraints) provides ample headroom.
POWERS_OF_TAU_URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_17.ptau"
PTAU_FILE="$BUILD_DIR/pot17_final.ptau"

echo "================================================="
echo " SolnadoCash Trusted Setup"
echo " Working directory: $CIRCUITS_DIR"
echo "================================================="

# ── Step 0: Prerequisite checks ───────────────────────────────────────────────
command -v circom   >/dev/null 2>&1 || { echo "ERROR: circom not found. Run: cargo install circom"; exit 1; }
command -v snarkjs  >/dev/null 2>&1 || { echo "ERROR: snarkjs not found. Run: npm install -g snarkjs"; exit 1; }
command -v node     >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node.js >= 18."; exit 1; }
command -v wget     >/dev/null 2>&1 || command -v curl >/dev/null 2>&1 || { echo "ERROR: wget or curl required"; exit 1; }

# Verify circuits directory has node_modules (circomlib)
if [ ! -d "$CIRCUITS_DIR/node_modules/circomlib" ]; then
    echo "Installing circuit dependencies..."
    cd "$CIRCUITS_DIR" && npm install
fi

mkdir -p "$BUILD_DIR"

# ── Step 1: Download Hermez Powers of Tau (one-time public ceremony) ──────────
echo ""
echo "=== Step 1: Download Hermez Powers of Tau (pot17) ==="
if [ ! -f "$PTAU_FILE" ]; then
    echo "Downloading $POWERS_OF_TAU_URL..."
    if command -v wget >/dev/null 2>&1; then
        wget -O "$PTAU_FILE" "$POWERS_OF_TAU_URL"
    else
        curl -L -o "$PTAU_FILE" "$POWERS_OF_TAU_URL"
    fi
    echo "Download complete: $PTAU_FILE"
else
    echo "Using cached Powers of Tau: $PTAU_FILE"
fi

# ── Step 2: Compile circuits ───────────────────────────────────────────────────
echo ""
echo "=== Step 2: Compile circuits ==="
cd "$CIRCUITS_DIR"

echo "Compiling withdraw.circom..."
circom withdraw/withdraw.circom --r1cs --wasm --sym -o "$BUILD_DIR" -l node_modules
echo "Withdraw constraint count:"
snarkjs r1cs info "$BUILD_DIR/withdraw.r1cs"

echo "Compiling deposit.circom..."
circom deposit/deposit.circom --r1cs --wasm --sym -o "$BUILD_DIR" -l node_modules
echo "Deposit constraint count:"
snarkjs r1cs info "$BUILD_DIR/deposit.r1cs"

# ── Step 3: Phase 2 trusted setup — withdraw circuit ─────────────────────────
echo ""
echo "=== Step 3: Withdraw circuit trusted setup ==="

echo "Phase 2 setup for withdraw..."
snarkjs groth16 setup \
    "$BUILD_DIR/withdraw.r1cs" \
    "$PTAU_FILE" \
    "$BUILD_DIR/withdraw_0.zkey"

echo "Contributing entropy (you: Contributor1)..."
snarkjs zkey contribute \
    "$BUILD_DIR/withdraw_0.zkey" \
    "$BUILD_DIR/withdraw_1.zkey" \
    --name="SolnadoCash-Contributor1" \
    -e="$(openssl rand -hex 32)"

echo "Beacon finalisation (public randomness)..."
snarkjs zkey beacon \
    "$BUILD_DIR/withdraw_1.zkey" \
    "$BUILD_DIR/withdraw_final.zkey" \
    "$(openssl rand -hex 32)" \
    10

echo "Verifying withdraw zkey..."
snarkjs zkey verify \
    "$BUILD_DIR/withdraw.r1cs" \
    "$PTAU_FILE" \
    "$BUILD_DIR/withdraw_final.zkey"

# ── Step 4: Phase 2 trusted setup — deposit circuit ──────────────────────────
echo ""
echo "=== Step 4: Deposit circuit trusted setup ==="

echo "Phase 2 setup for deposit..."
snarkjs groth16 setup \
    "$BUILD_DIR/deposit.r1cs" \
    "$PTAU_FILE" \
    "$BUILD_DIR/deposit_0.zkey"

echo "Contributing entropy..."
snarkjs zkey contribute \
    "$BUILD_DIR/deposit_0.zkey" \
    "$BUILD_DIR/deposit_1.zkey" \
    --name="SolnadoCash-Contributor1" \
    -e="$(openssl rand -hex 32)"

echo "Beacon finalisation..."
snarkjs zkey beacon \
    "$BUILD_DIR/deposit_1.zkey" \
    "$BUILD_DIR/deposit_final.zkey" \
    "$(openssl rand -hex 32)" \
    10

echo "Verifying deposit zkey..."
snarkjs zkey verify \
    "$BUILD_DIR/deposit.r1cs" \
    "$PTAU_FILE" \
    "$BUILD_DIR/deposit_final.zkey"

# ── Step 5: Export verifying keys ─────────────────────────────────────────────
echo ""
echo "=== Step 5: Export verifying keys ==="
snarkjs zkey export verificationkey \
    "$BUILD_DIR/withdraw_final.zkey" \
    "$BUILD_DIR/withdraw_vk.json"

snarkjs zkey export verificationkey \
    "$BUILD_DIR/deposit_final.zkey" \
    "$BUILD_DIR/deposit_vk.json"

echo "Verifying keys exported to:"
echo "  $BUILD_DIR/withdraw_vk.json"
echo "  $BUILD_DIR/deposit_vk.json"

# ── Step 6: Generate Rust verifying key ───────────────────────────────────────
echo ""
echo "=== Step 6: Generate Rust verifying key for withdraw ==="
if [ -f "$SCRIPTS_DIR/convert_vk_to_rust.js" ]; then
    node "$SCRIPTS_DIR/convert_vk_to_rust.js" \
        "$BUILD_DIR/withdraw_vk.json" \
        > "$REPO_DIR/programs/solnadocash/src/vk.rs"
    echo "Rust verifying key written to programs/solnadocash/src/vk.rs"
else
    echo "NOTE: scripts/convert_vk_to_rust.js not found."
    echo "  Manually convert $BUILD_DIR/withdraw_vk.json to Rust."
    echo "  See PROJET_enhanced.md Section 12.3 for the format."
fi

# ── Clean up intermediate zkeys ───────────────────────────────────────────────
echo ""
echo "=== Cleaning up intermediate zkeys ==="
rm -f "$BUILD_DIR/withdraw_0.zkey" "$BUILD_DIR/withdraw_1.zkey"
rm -f "$BUILD_DIR/deposit_0.zkey"  "$BUILD_DIR/deposit_1.zkey"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "================================================="
echo " Trusted setup complete."
echo ""
echo " Files produced:"
echo "   $BUILD_DIR/withdraw_final.zkey"
echo "   $BUILD_DIR/deposit_final.zkey"
echo "   $BUILD_DIR/withdraw_vk.json"
echo "   $BUILD_DIR/deposit_vk.json"
echo ""
echo " IMPORTANT: these files are now frozen."
echo " Any change to .circom files requires a new ceremony."
echo ""
echo " Next steps:"
echo "   git add circuits/build/withdraw_final.zkey"
echo "   git add circuits/build/deposit_final.zkey"
echo "   git add circuits/build/withdraw_vk.json"
echo "   git add circuits/build/deposit_vk.json"
echo "   git add programs/solnadocash/src/vk.rs"
echo "   git commit -m 'chore: trusted setup v1'"
echo "   git tag trusted-setup-v1"
echo "   git push --tags"
echo "================================================="
