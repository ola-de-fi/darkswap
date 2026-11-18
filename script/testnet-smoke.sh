#!/usr/bin/env bash
# Real swap on Robinhood testnet against deployments/46630.json with a running TESTNET_EXECUTE keeper.
# Creates two throwaway trader wallets (keys kept in gitignored keeper/data/smoke-wallets.env),
# funds them with a little gas from the keeper wallet, mints mock tokens, then commit -> reveal -> keeper settle -> claim.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RPC=https://rpc.testnet.chain.robinhood.com
[[ $(cast chain-id --rpc-url $RPC) == 46630 ]] || { echo "not Robinhood testnet"; exit 1; }
M=deployments/46630.json
AUCTION=$(jq -r .auction $M); WETH=$(jq -r .weth $M); USDC=$(jq -r .usdc $M); ORACLE=$(jq -r .oracle $M)
KEEPER_PRIVATE_KEY=$(grep '^KEEPER_PRIVATE_KEY=' keeper/.env | cut -d= -f2)

W=keeper/data/smoke-wallets.env
if [[ ! -s $W ]]; then
  umask 077
  { cast wallet new --json | jq -r '.data[0] | "BUYER_KEY=\(.private_key)\nBUYER=\(.address)"'
    cast wallet new --json | jq -r '.data[0] | "SELLER_KEY=\(.private_key)\nSELLER=\(.address)"'; } > $W
fi
. ./$W

num() { cast call "$@" --rpc-url $RPC | cut -d' ' -f1; }
send() { cast send --rpc-url $RPC --private-key "$1" "${@:2}" >/dev/null; }
now() { cast block latest -f timestamp --rpc-url $RPC; }

for a in $BUYER $SELLER; do
  (( $(cast balance $a --rpc-url $RPC) >= 200000000000000 )) || send $KEEPER_PRIVATE_KEY $a --value 0.0005ether
done
echo "traders funded: buyer=$BUYER seller=$SELLER"

send $BUYER_KEY $USDC "mint(address,uint256)" $BUYER 5000000000
send $SELLER_KEY $WETH "mint(address,uint256)" $SELLER 1000000000000000000
send $BUYER_KEY $USDC "approve(address,uint256)" $AUCTION 5000000000
send $SELLER_KEY $WETH "approve(address,uint256)" $AUCTION 1000000000000000000
B0_USDC=$(num $USDC 'balanceOf(address)(uint256)' $BUYER); B0_WETH=$(num $WETH 'balanceOf(address)(uint256)' $BUYER)
S0_USDC=$(num $USDC 'balanceOf(address)(uint256)' $SELLER); S0_WETH=$(num $WETH 'balanceOf(address)(uint256)' $SELLER)

while :; do
  B=$(num $AUCTION "currentBatchId()(uint256)")
  CD=$(num $AUCTION "commitDeadline(uint256)(uint256)" $B)
  (( CD - $(now) >= 15 )) && break; sleep 1
done
echo "using batch $B"

SALT_B=0x$(openssl rand -hex 32); SALT_S=0x$(openssl rand -hex 32)
BUY_LIMIT=100000000000000000000000   # 100,000 USDC/WETH
SELL_LIMIT=100000000000000000000     # 100 USDC/WETH
CB=$(cast call $AUCTION "computeCommitment(address,uint256,uint8,address,uint256,uint256,bytes32)(bytes32)" $BUYER $B 0 $USDC 5000000000 $BUY_LIMIT $SALT_B --rpc-url $RPC)
CS=$(cast call $AUCTION "computeCommitment(address,uint256,uint8,address,uint256,uint256,bytes32)(bytes32)" $SELLER $B 1 $WETH 1000000000000000000 $SELL_LIMIT $SALT_S --rpc-url $RPC)
send $BUYER_KEY $AUCTION "commitOrder(uint256,bytes32,uint8,uint256)" $B $CB 0 5000000000
send $SELLER_KEY $AUCTION "commitOrder(uint256,bytes32,uint8,uint256)" $B $CS 1 1000000000000000000
echo "committed"

while (( $(now) < CD )); do sleep 1; done
send $BUYER_KEY $AUCTION "revealOrder(uint256,uint8,uint256,uint256,bytes32)" $B 0 5000000000 $BUY_LIMIT $SALT_B
send $SELLER_KEY $AUCTION "revealOrder(uint256,uint8,uint256,uint256,bytes32)" $B 1 1000000000000000000 $SELL_LIMIT $SALT_S
echo "revealed"

for _ in $(seq 1 120); do
  [[ $(cast call $AUCTION "batchSettled(uint256)(bool)" $B --rpc-url $RPC) == true ]] && break; sleep 1
done
[[ $(cast call $AUCTION "batchSettled(uint256)(bool)" $B --rpc-url $RPC) == true ]] || { echo "FAIL: keeper did not settle batch $B"; exit 1; }
echo "settled by keeper"

send $BUYER_KEY $AUCTION "claim(address)" $WETH
send $BUYER_KEY $AUCTION "claim(address)" $USDC
send $SELLER_KEY $AUCTION "claim(address)" $USDC

TX=$(cast logs --from-block $(( $(cast block-number --rpc-url $RPC) - 2000 )) --address $AUCTION "MatchExecuted(uint256 indexed,address indexed,address indexed,uint256,uint256,uint256)" $(cast to-uint256 $B) --rpc-url $RPC --json | jq -r '.[0].transactionHash')
echo "settlement tx: https://explorer.testnet.chain.robinhood.com/tx/$TX"
echo "buyer  WETH: +$(( $(num $WETH 'balanceOf(address)(uint256)' $BUYER) - B0_WETH ))  USDC: $(( $(num $USDC 'balanceOf(address)(uint256)' $BUYER) - B0_USDC ))"
echo "seller USDC: +$(( $(num $USDC 'balanceOf(address)(uint256)' $SELLER) - S0_USDC ))  WETH: $(( $(num $WETH 'balanceOf(address)(uint256)' $SELLER) - S0_WETH ))"
echo "auction holds WETH=$(num $WETH 'balanceOf(address)(uint256)' $AUCTION) USDC=$(num $USDC 'balanceOf(address)(uint256)' $AUCTION)"
echo "escrow+claimable WETH=$(( $(num $AUCTION 'totalEscrowed(address)(uint256)' $WETH) + $(num $AUCTION 'totalClaimable(address)(uint256)' $WETH) )) USDC=$(( $(num $AUCTION 'totalEscrowed(address)(uint256)' $USDC) + $(num $AUCTION 'totalClaimable(address)(uint256)' $USDC) ))"
echo "TESTNET SMOKE PASSED"
