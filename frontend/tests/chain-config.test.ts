import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  faucetAvailable, getAuctionAddress, getExplorerTxBase, getQuoteSymbol, isSupportedChainId, writesEnabledFor,
} from '../lib/chain/config';

afterEach(() => vi.unstubAllEnvs());

describe('chain config', () => {
  it('uses USDG on Robinhood mainnet and USDC elsewhere', () => {
    expect(getQuoteSymbol(4663)).toBe('USDG');
    expect(getQuoteSymbol(46630)).toBe('USDC');
    expect(getQuoteSymbol(31337)).toBe('USDC');
    expect(getQuoteSymbol(undefined)).toBe('USDC');
  });

  it('supports mainnet, never offers a faucet there, and gates writes', () => {
    expect(isSupportedChainId(4663)).toBe(true);
    expect(faucetAvailable(4663)).toBe(false);
    expect(faucetAvailable(46630)).toBe(true);
    vi.stubEnv('NEXT_PUBLIC_ENABLE_MAINNET_WRITES', 'false');
    expect(writesEnabledFor(4663)).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_ENABLE_MAINNET_WRITES', 'true');
    expect(writesEnabledFor(4663)).toBe(true);
    expect(getExplorerTxBase(4663)).toBe('https://explorer.chain.robinhood.com/tx/');
  });

  it('reads the mainnet auction address from env and fails closed when unset', () => {
    vi.stubEnv('NEXT_PUBLIC_DARKSWAP_AUCTION_4663', '');
    expect(() => getAuctionAddress(4663)).toThrow();
    vi.stubEnv('NEXT_PUBLIC_DARKSWAP_AUCTION_4663', '0x0bd7d308f8e1639fab988df18a8011f41eacad73');
    expect(getAuctionAddress(4663)).toBe('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
  });
});
