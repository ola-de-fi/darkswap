import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http } from 'viem';
import { auctionAbi } from '../lib/chain/auctionAbi';
import { erc20Abi } from '../lib/chain/erc20Abi';
import { anvilChain } from '../lib/chain/config';

async function main() {
const rpc = process.env.LOCAL_ANVIL_RPC_URL || 'http://127.0.0.1:8545';
const parsed = new URL(rpc);
if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
  throw new Error('Local demo refuses non-loopback RPC URLs.');
}
const client = createPublicClient({ chain: anvilChain, transport: http(rpc, { timeout: 8_000 }) });
if (await client.getChainId() !== 31337) throw new Error('Local demo requires Anvil chain 31337.');

const keeperDir = resolve(process.cwd(), '../keeper');
const result = spawnSync('npm', ['run', 'simulate'], { cwd: keeperDir, encoding: 'utf8', env: { ...process.env, LOCAL_ANVIL_RPC_URL: rpc }, maxBuffer: 8 * 1024 * 1024 });
if (result.status !== 0) throw new Error(`Keeper local simulation failed:\n${result.stderr || result.stdout}`);
const start = result.stdout.indexOf('\n{\n  "rpcUrl"');
const end = result.stdout.lastIndexOf('}');
if (start < 0 || end <= start) throw new Error(`Could not parse the keeper simulation result:\n${result.stdout}`);
const summary = JSON.parse(result.stdout.slice(start + 1, end + 1)) as {
  chainId: number;
  addresses: { auction: string; weth: string; usdc: string };
  batchId: string;
  matchCount: number;
  conserved: boolean;
};
if (summary.chainId !== 31337 || !summary.conserved) throw new Error('The simulation did not confirm local chain and escrow conservation.');
const auctionCode = await client.getBytecode({ address: summary.addresses.auction as `0x${string}` });
if (!auctionCode || auctionCode === '0x') throw new Error('Simulation auction has no deployed code.');
const [weth, usdc] = await Promise.all([
  client.readContract({ abi: auctionAbi, address: summary.addresses.auction as `0x${string}`, functionName: 'weth' }),
  client.readContract({ abi: auctionAbi, address: summary.addresses.auction as `0x${string}`, functionName: 'usdc' }),
]);
if (weth.toLowerCase() !== summary.addresses.weth.toLowerCase() || usdc.toLowerCase() !== summary.addresses.usdc.toLowerCase()) throw new Error('Simulation pair does not match deployed auction getters.');
const [wethDecimals, usdcDecimals] = await Promise.all([
  client.readContract({ abi: erc20Abi, address: weth, functionName: 'decimals' }),
  client.readContract({ abi: erc20Abi, address: usdc, functionName: 'decimals' }),
]);
if (wethDecimals !== 18 || usdcDecimals !== 6) throw new Error(`Unexpected token decimals: WETH=${wethDecimals}, USDC=${usdcDecimals}.`);
const envFile = resolve(process.cwd(), '.env.local');
const contents = [
  '# Generated from a verified local Anvil deployment by npm run local:demo.',
  `NEXT_PUBLIC_DARKSWAP_AUCTION_31337=${summary.addresses.auction}`,
  `NEXT_PUBLIC_DARKSWAP_WETH_31337=${summary.addresses.weth}`,
  `NEXT_PUBLIC_DARKSWAP_USDC_31337=${summary.addresses.usdc}`,
  'NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_31337=0',
  'NEXT_PUBLIC_ENABLE_TESTNET_WRITES=false',
  `NEXT_PUBLIC_ANVIL_RPC_URL=${rpc}`,
  '',
].join('\n');
writeFileSync(envFile, contents, { mode: 0o600 });
console.log(`Local keeper simulation completed on chain ${summary.chainId}, batch ${summary.batchId}, ${summary.matchCount} match(es), conservation=${summary.conserved}.`);
console.log(`Verified local frontend configuration written to ${envFile}. Restart Next.js after config generation.`);
console.log('All mock orders were settled and claimed by the Anvil simulation accounts. No public network was used.');

}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
