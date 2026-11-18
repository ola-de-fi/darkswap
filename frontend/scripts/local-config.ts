import { createPublicClient, http } from 'viem';
import { anvilChain } from '../lib/chain/config';
import { auctionAbi } from '../lib/chain/auctionAbi';
import { erc20Abi } from '../lib/chain/erc20Abi';

async function main() {
const auction = process.env.AUCTION_ADDRESS as `0x${string}` | undefined;
const rpcUrl = process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545';
const deploymentBlock = process.env.DEPLOYMENT_BLOCK || '0';
if (!/^(0|[1-9][0-9]*)$/.test(deploymentBlock)) throw new Error('DEPLOYMENT_BLOCK must be a non-negative integer.');
if (!auction || !/^0x[0-9a-fA-F]{40}$/.test(auction)) throw new Error('Set AUCTION_ADDRESS to an auction deployed on local Anvil.');
const client = createPublicClient({ chain: anvilChain, transport: http(rpcUrl, { timeout: 8_000 }) });
const chainId = await client.getChainId();
if (chainId !== 31337) throw new Error(`Refusing configuration generation for chain ${chainId}; local Anvil 31337 is required.`);
const code = await client.getCode({ address: auction });
if (!code || code === '0x') throw new Error('No contract code exists at AUCTION_ADDRESS.');
const [weth, usdc] = await Promise.all([
  client.readContract({ abi: auctionAbi, address: auction, functionName: 'weth' }),
  client.readContract({ abi: auctionAbi, address: auction, functionName: 'usdc' }),
]);
const [wethDecimals, usdcDecimals] = await Promise.all([
  client.readContract({ abi: erc20Abi, address: weth, functionName: 'decimals' }),
  client.readContract({ abi: erc20Abi, address: usdc, functionName: 'decimals' }),
]);
if (wethDecimals !== 18 || usdcDecimals !== 6) throw new Error(`Unexpected pair decimals: WETH=${wethDecimals}, USDC=${usdcDecimals}.`);
console.log('# Copy these values to frontend/.env.local. Read from the verified local deployment.');
console.log(`NEXT_PUBLIC_DARKSWAP_AUCTION_31337=${auction}`);
console.log(`NEXT_PUBLIC_DARKSWAP_WETH_31337=${weth}`);
console.log(`NEXT_PUBLIC_DARKSWAP_USDC_31337=${usdc}`);
console.log(`NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_31337=${deploymentBlock}`);
console.log('NEXT_PUBLIC_ENABLE_TESTNET_WRITES=false');
console.log(`# Verified pair: WETH=${weth} (18 decimals), USDC=${usdc} (6 decimals)`);

}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
