"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { Hexagon } from "lucide-react";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

export function Navbar() {
  const { connected } = useWallet();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 px-6 py-4">
      <div className="mx-auto max-w-7xl">
        <div className="glass flex items-center justify-between rounded-2xl px-6 py-3">
          <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
            <Hexagon className="h-6 w-6 text-primary" />
            <span className="text-xl font-bold tracking-tight text-white">5ive<span className="text-primary/80">Blackjack</span></span>
          </Link>

          <div className="flex items-center gap-4">
            <div className="hidden md:flex gap-6 text-sm font-medium mr-4">
              <span className="text-muted-foreground">{connected ? "Wallet connected" : "Wallet disconnected"}</span>
            </div>
            {/* Embedded styles overrides for modern Wallet Modal UI directly in the class wrapper */}
            <div className="[&_.wallet-adapter-button]:bg-primary [&_.wallet-adapter-button]:hover:bg-primary/90 [&_.wallet-adapter-button]:h-10 [&_.wallet-adapter-button]:px-6 [&_.wallet-adapter-button]:rounded-xl [&_.wallet-adapter-button]:font-medium transition-all active:scale-95 shadow-lg shadow-primary/20 rounded-xl">
              <WalletMultiButton />
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
