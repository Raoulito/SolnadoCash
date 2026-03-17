#!/bin/bash
# scripts/benchmark_cu.sh
#
# Runs CU benchmarks on devnet for:
#   A) groth16_verify syscall (withdraw path)
#   B) 20-level Poseidon hashing (deposit path)
#
# These are MANDATORY before writing any deposit or withdraw logic (T11, T12).
# All CU budget decisions depend on the measured numbers, not estimates.
#
# Usage:
#   anchor build --features benchmark
#   bash scripts/benchmark_cu.sh
#
# Record the output numbers in PROJET_enhanced.md Section 2 CU table.
set -e

echo "================================================="
echo " SolnadoCash — CU Benchmark (devnet)"
echo "================================================="

command -v anchor >/dev/null 2>&1 || { echo "ERROR: anchor not found"; exit 1; }
command -v solana >/dev/null 2>&1 || { echo "ERROR: solana CLI not found"; exit 1; }

# Verify we are on devnet
CLUSTER=$(solana config get | grep "RPC URL" | awk '{print $3}')
echo "Cluster: $CLUSTER"
if [[ "$CLUSTER" != *"devnet"* ]]; then
    echo "WARNING: Not on devnet. Switch with: solana config set --url devnet"
    echo "Proceeding anyway..."
fi

echo ""
echo "Running CU benchmarks..."
anchor test -- --grep "CU benchmark" 2>&1 | tee /tmp/cu_benchmark_output.txt

echo ""
echo "================================================="
echo " Results saved to /tmp/cu_benchmark_output.txt"
echo ""
echo " Next step (T13):"
echo "   1. Find 'groth16_verify CU cost' in the output"
echo "   2. Find 'Poseidon 20-level CU cost' in the output"
echo "   3. Update PROJET_enhanced.md Section 2 CU table"
echo "   4. If Poseidon > 800k CUs: reduce TREE_DEPTH to 16 in circuits"
echo "      and recalculate POOL_SIZE accordingly"
echo "================================================="
