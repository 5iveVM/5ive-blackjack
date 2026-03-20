"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";

// Default styles from adapter
import "@solana/wallet-adapter-react-ui/styles.css";

export type NetworkName = "localnet" | "devnet" | "mainnet";

type NetworkContextValue = {
  network: NetworkName;
  endpoint: string;
  displayEndpoint: string;
  setNetwork: (network: NetworkName) => void;
};

const DEVNET_ENDPOINT =
  "https://api.devnet.solana.com";
const LOCALNET_ENDPOINT =
  process.env.NEXT_PUBLIC_LOCALNET_RPC_URL ||
  (process.env.NEXT_PUBLIC_RPC_URL?.includes("127.0.0.1") ? process.env.NEXT_PUBLIC_RPC_URL : "") ||
  "http://127.0.0.1:8899";
const LOCALNET_WS_ENDPOINT = "ws://127.0.0.1:8900";
const DEVNET_WS_ENDPOINT = "wss://api.devnet.solana.com/";
const DEVNET_PROXY_PATH = "/api/solana-devnet";
const MAINNET_DISPLAY_ENDPOINT = "https://api.mainnet-beta.solana.com";
const MAINNET_WS_ENDPOINT = "wss://api.mainnet-beta.solana.com/";
const MAINNET_PROXY_PATH = "/api/solana-mainnet";
const DEFAULT_NETWORK: NetworkName =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK === "localnet"
    ? "localnet"
    : process.env.NEXT_PUBLIC_DEFAULT_NETWORK === "mainnet"
      ? "mainnet"
      : "devnet";
const NETWORK_STORAGE_KEY = "five-blackjack-network";

const NetworkContext = createContext<NetworkContextValue | null>(null);

function resolveMainnetRpcEndpoint(): string {
  if (typeof window === "undefined") return MAINNET_DISPLAY_ENDPOINT;
  return new URL(MAINNET_PROXY_PATH, window.location.origin).toString();
}

function resolveDevnetRpcEndpoint(): string {
  if (typeof window === "undefined") return DEVNET_ENDPOINT;
  return new URL(DEVNET_PROXY_PATH, window.location.origin).toString();
}

function isUserRejectedWalletAction(error: WalletError): boolean {
  return /user rejected|rejected the request|declined|cancelled/i.test(error.message);
}

export function useNetworkConfig(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useNetworkConfig must be used within WalletContextProvider.");
  return ctx;
}

export function WalletContextProvider({ children }: { children: React.ReactNode }) {
  const [network, setNetwork] = useState<NetworkName>(DEFAULT_NETWORK);
  const endpoint = useMemo(
    () =>
      network === "mainnet"
        ? resolveMainnetRpcEndpoint()
        : network === "localnet"
          ? LOCALNET_ENDPOINT
          : resolveDevnetRpcEndpoint(),
    [network]
  );
  const wsEndpoint = useMemo(
    () =>
      network === "mainnet"
        ? MAINNET_WS_ENDPOINT
        : network === "localnet"
          ? LOCALNET_WS_ENDPOINT
          : DEVNET_WS_ENDPOINT,
    [network]
  );
  const displayEndpoint = useMemo(
    () =>
      network === "mainnet"
        ? MAINNET_DISPLAY_ENDPOINT
        : network === "localnet"
          ? LOCALNET_ENDPOINT
          : DEVNET_ENDPOINT,
    [network]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(NETWORK_STORAGE_KEY);
    if (stored === "mainnet" || stored === "devnet" || stored === "localnet") {
      const frame = window.requestAnimationFrame(() => setNetwork(stored));
      return () => window.cancelAnimationFrame(frame);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(NETWORK_STORAGE_KEY, network);
  }, [network]);

  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const value = useMemo(
    () => ({ network, endpoint, displayEndpoint, setNetwork }),
    [network, endpoint, displayEndpoint]
  );
  const onWalletError = (error: WalletError, adapter?: Adapter) => {
    if (isUserRejectedWalletAction(error)) return;
    if (adapter?.name) {
      console.error(`[wallet:${adapter.name}]`, error);
      return;
    }
    console.error(error);
  };

  return (
    <NetworkContext.Provider value={value}>
      <ConnectionProvider endpoint={endpoint} config={{ wsEndpoint }}>
        <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </NetworkContext.Provider>
  );
}
