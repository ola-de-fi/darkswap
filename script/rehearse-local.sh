#!/usr/bin/env bash
# End-to-end rehearsal on a throwaway local Anvil node:
# DeployTestnet.s.sol -> keeper (LOCAL_EXECUTE + oracle pusher) -> buyer/seller commit, reveal -> settle -> claim.
# Uses only Anvil's public dev accounts. Never point this at a public network.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC=http://127.0.0.1:8545
PORT=8545

# Anvil default dev accounts (public, unfunded everywhere else).
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEEPER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
BUYER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
BUYER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
SELLER=0x90F79bf6EB2c4f870365E785982E1f101E93b906
SELLER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6

anvil --port $PORT --block-time 1 --silent &
ANVIL_PID=$!
KEEPER_PID=""
# set +e: under errexit a no-match pkill used to abort cleanup before anvil was killed, leaking port 8545.
cleanup() {
  set +e
  if [[ -n "$KEEPER_PID" ]]; then pkill -P "$KEEPER_PID"; kill "$KEEPER_PID"; fi
  kill -9 "$ANVIL_PID"
} 2>/dev/null
trap cleanup EXIT
sleep 2

cd "$ROOT"
KEEPER_ADDRESS=$KEEPER forge script script/DeployTestnet.s.sol --rpc-url $RPC --private-key $DEPLOYER_KEY --broadcast >/dev/null
M=deployments/31337.json
AUCTION=$(jq -r .auction $M); WETH=$(jq -r .weth $M); USDC=$(jq -r .usdc $M); ORACLE=$(jq -r .oracle $M)
echo "deployed auction=$AUCTION oracle=$ORACLE"
DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
OWNER=$(cast call $AUCTION "owner()(address)" --rpc-url $RPC)
[[ "$OWNER" == "$DEPLOYER" ]] || { echo "FAIL: owner $OWNER is not deployer $DEPLOYER"; exit 1; }
echo "owner=$OWNER minWethIn=$(cast call $AUCTION 'minWethIn()(uint256)' --rpc-url $RPC | cut -d' ' -f1) minUsdcIn=$(cast call $AUCTION 'minUsdcIn()(uint256)' --rpc-url $RPC | cut -d' ' -f1)"

STATE=$(mktemp -d)/state.json
# Fixed price keeps the rehearsal offline; run with ORACLE_FIXED_PRICE_USD= (empty) to use the live Coinbase quote.
# Settlement needs a price pushed at/after the batch's reveal deadline; the keeper's periodic push provides it.
(cd keeper && exec env EXECUTION_MODE=LOCAL_EXECUTE CHAIN_ID=31337 RPC_URL=$RPC AUCTION_ADDRESS=$AUCTION \
  LOCAL_EXECUTE_ACCOUNT=$KEEPER ORACLE_ADDRESS=$ORACLE KEEPER_STATE_FILE=$STATE POLL_INTERVAL_MS=1000 \
  ORACLE_FIXED_PRICE_USD="${ORACLE_FIXED_PRICE_USD-3000}" \
  KEEPER_ENV_FILE=/dev/null ./node_modules/.bin/tsx src/index.ts > "$STATE.log" 2>&1) &
KEEPER_PID=$!

num() { cast call "$@" --rpc-url $RPC | cut -d' ' -f1; }
send() { cast send --rpc-url $RPC --private-key "$1" "${@:2}" >/dev/null; }
send $BUYER_KEY $USDC "mint(address,uint256)" $BUYER 5000000000
send $SELLER_KEY $WETH "mint(address,uint256)" $SELLER 1000000000000000000
send $BUYER_KEY $USDC "approve(address,uint256)" $AUCTION 5000000000
send $SELLER_KEY $WETH "approve(address,uint256)" $AUCTION 1000000000000000000

now() { cast block latest -f timestamp --rpc-url $RPC; }
# Wait for a fresh commit window with at least 15s left.
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

for _ in $(seq 1 90); do
  [[ $(cast call $AUCTION "batchSettled(uint256)(bool)" $B --rpc-url $RPC) == true ]] && break; sleep 1
done
[[ $(cast call $AUCTION "batchSettled(uint256)(bool)" $B --rpc-url $RPC) == true ]] || { echo "FAIL: keeper did not settle"; cat "$STATE.log"; exit 1; }
echo "settled by keeper"

send $BUYER_KEY $AUCTION "claim(address)" $WETH
send $BUYER_KEY $AUCTION "claim(address)" $USDC
send $SELLER_KEY $AUCTION "claim(address)" $USDC

PRICE=$(num $ORACLE "priceX18()(uint256)")
echo "oracle price X18: $PRICE"
echo "buyer  WETH: $(num $WETH 'balanceOf(address)(uint256)' $BUYER)"
echo "buyer  USDC: $(num $USDC 'balanceOf(address)(uint256)' $BUYER)"
echo "seller USDC: $(num $USDC 'balanceOf(address)(uint256)' $SELLER)"
echo "auction WETH left: $(num $WETH 'balanceOf(address)(uint256)' $AUCTION)"
echo "auction USDC left: $(num $USDC 'balanceOf(address)(uint256)' $AUCTION)"
grep -c oracle_price_pushed "$STATE.log" | xargs echo "oracle pushes:"
echo "REHEARSAL PASSED"
