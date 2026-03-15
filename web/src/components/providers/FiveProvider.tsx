"use client";

import { createContext, useContext, useMemo } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { FiveSDK } from "@5ive-tech/sdk";

interface FiveContextState {
  sdk: FiveSDK;
  isReady: boolean;
  execute: (scriptAccount: string, functionName: string, parameters?: any[], accounts?: string[]) => Promise<any>;
}

const FiveContext = createContext<FiveContextState | null>(null);

export function FiveProvider({ children }: { children: React.ReactNode }) {
  const { wallet, publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const sdk = useMemo(
    () =>
      FiveSDK.create({
        debug: true,
        fiveVMProgramId: process.env.NEXT_PUBLIC_FIVE_VM_PROGRAM_ID,
      }),
    []
  );

  const execute = async (scriptAccount: string, functionName: string, parameters: any[] = [], accounts: string[] = []) => {
    if (!publicKey || !wallet?.adapter) {
      throw new Error("Wallet not connected");
    }
    
    // In a real app you'd adapt the adapter to the required interface
    // or use the server to sign transactions. Here we use the adapter directly.
    return FiveSDK.executeOnSolana(
      scriptAccount,
      connection,
      wallet.adapter as any,
      functionName,
      parameters,
      accounts,
      {
        debug: true,
      }
    );
  };

  const value = useMemo(() => ({
    sdk,
    isReady: true,
    execute,
  }), [sdk, execute]);

  return <FiveContext.Provider value={value}>{children}</FiveContext.Provider>;
}

export const useFive = () => {
  const context = useContext(FiveContext);
  if (!context) {
    throw new Error("useFive must be used within a FiveProvider");
  }
  return context;
};
