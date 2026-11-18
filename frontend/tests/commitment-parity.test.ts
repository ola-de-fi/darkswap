import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { calculateCommitment } from '../lib/commitment';

type Artifact = { abi: Abi; bytecode: { object: Hex } };
const MIN_WETH_IN = 10n ** 15n;
const MIN_USDC_IN = 10n ** 6n;
const repo = resolve(process.cwd(), '..');
const artifact = (source: string, name: string): Artifact => JSON.parse(readFileSync(resolve(repo, 'out', `${source}.sol`, `${name}.json`), 'utf8')) as Artifact;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local RPC port.');
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function waitForRpc(url: string, child: ChildProcess): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Anvil exited early (${child.exitCode}).`);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (response.ok) {
        const data = await response.json() as { result?: string };
        if (data.result === '0x7a69') return;
      }
    } catch { /* Local node is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error('Timed out waiting for local Anvil.');
}

describe('frontend commitment parity with deployed Solidity', () => {
  let anvil: ChildProcess;
  let rpcUrl: string;

  beforeAll(async () => {
    const port = await reservePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    const anvilPath = join(process.env.FOUNDRY_BIN_DIR || join(homedir(), '.foundry', 'bin'), 'anvil');
    anvil = spawn(anvilPath, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--accounts', '3', '--silent'], { stdio: 'ignore' });
    await waitForRpc(rpcUrl, anvil);
  }, 30_000);

  afterAll(() => { if (anvil && anvil.exitCode === null) anvil.kill('SIGTERM'); });

  it('matches computeCommitment from the compiled auction artifact', async () => {
    const chain = { ...foundry, id: 31337, rpcUrls: { default: { http: [rpcUrl] } } };
    const transport = http(rpcUrl);
    const publicClient = createPublicClient({ chain, transport });
    const accountResponse = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_accounts', params: [] }) });
    const accountData = await accountResponse.json() as { result: Address[] };
    const owner = accountData.result[0];
    const keeper = accountData.result[1];
    if (!owner || !keeper) throw new Error('Anvil did not provide local unlocked accounts.');
    const wallet = createWalletClient({ account: owner, chain, transport });

    async function deploy(which: Artifact, args: readonly unknown[] = []): Promise<Address> {
      const hash = await wallet.deployContract({ abi: which.abi, bytecode: which.bytecode.object, args: args as never });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error('Local contract deployment returned no address.');
      return receipt.contractAddress;
    }

    const wethArtifact = artifact('MockWETH', 'MockWETH');
    const usdcArtifact = artifact('MockUSDC', 'MockUSDC');
    const oracleArtifact = artifact('MockPriceOracle', 'MockPriceOracle');
    const auctionArtifact = artifact('SealedBatchAuction', 'SealedBatchAuction');
    const weth = await deploy(wethArtifact);
    const usdc = await deploy(usdcArtifact);
    const latest = await publicClient.getBlock({ blockTag: 'latest' });
    const oracle = await deploy(oracleArtifact, [2_000n * 10n ** 18n, latest.timestamp]);
    const auction = await deploy(auctionArtifact, [weth, usdc, oracle, keeper, MIN_WETH_IN, MIN_USDC_IN, 120n, true, owner]);

    const input = {
      chainId: 31337n,
      verifyingContract: auction,
      owner,
      batchId: 1n,
      side: 0 as const,
      inputToken: usdc,
      amountIn: 25_000_000n,
      limitPriceX18: 3_000n * 10n ** 18n,
      salt: `0x${'5a'.repeat(32)}` as Hex,
    };
    const frontendHash = calculateCommitment(input);
    const solidityHash = await publicClient.readContract({
      abi: auctionArtifact.abi,
      address: auction,
      functionName: 'computeCommitment',
      args: [owner, input.batchId, input.side, usdc, input.amountIn, input.limitPriceX18, input.salt],
    } as never) as Hex;
    expect(frontendHash).toBe(solidityHash);
  }, 60_000);
});
