'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { anvilChain, isMainnetConfigured, robinhoodMainnetChain, robinhoodTestnetChain } from '../lib/chain/config';

const wagmiConfig = createConfig({
  // First chain is the default for visitors without a connected wallet: mainnet once deployed, else testnet.
  chains: isMainnetConfigured()
    ? [robinhoodMainnetChain, robinhoodTestnetChain, anvilChain]
    : [robinhoodTestnetChain, robinhoodMainnetChain, anvilChain],
  connectors: [injected()],
  transports: {
    [anvilChain.id]: http(process.env.NEXT_PUBLIC_ANVIL_RPC_URL || 'http://127.0.0.1:8545'),
    [robinhoodTestnetChain.id]: http(process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com'),
    [robinhoodMainnetChain.id]: http(process.env.NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'),
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 2_000, retry: 2, refetchOnWindowFocus: true } },
  }));
  return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></WagmiProvider>;
}
