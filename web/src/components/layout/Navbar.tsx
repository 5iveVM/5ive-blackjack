"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { Github, Hexagon } from "lucide-react";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

type NavbarProps = {
  status?: string;
  chips?: number;
  activeBet?: number;
  walletConnected?: boolean;
};

export function Navbar({ status, chips, activeBet, walletConnected }: NavbarProps) {
  const { connected } = useWallet();
  const isConnected = walletConnected ?? connected;

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 px-2 py-2 sm:px-4 md:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="glass flex items-center justify-between gap-2 sm:gap-3 rounded-2xl border border-emerald-300/15 bg-emerald-950/65 px-3 py-2 sm:px-4 sm:py-3 md:px-6">
          <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
            <Hexagon className="h-6 w-6 text-emerald-300" />
            <span className="text-lg font-black tracking-wide uppercase text-emerald-50 md:text-xl">
              5ive<span className="text-emerald-300">Blackjack</span>
            </span>
          </Link>

          <div className="hidden lg:flex items-center gap-6 text-[11px] font-mono uppercase tracking-widest text-emerald-100/80">
            <span>status: {status || "ready"}</span>
            <span>bankroll: ${chips ?? 0}</span>
            <span>bet: ${activeBet ?? 0}</span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="hidden md:flex text-xs font-semibold uppercase tracking-wider">
              <span className={isConnected ? "text-emerald-300" : "text-rose-300"}>
                {isConnected ? "Wallet connected" : "Wallet disconnected"}
              </span>
            </div>
            <div className="[&_.wallet-adapter-button]:h-9 sm:[&_.wallet-adapter-button]:h-10 [&_.wallet-adapter-button]:rounded-xl [&_.wallet-adapter-button]:border [&_.wallet-adapter-button]:border-emerald-300/30 [&_.wallet-adapter-button]:bg-emerald-500/20 [&_.wallet-adapter-button]:px-3 sm:[&_.wallet-adapter-button]:px-5 [&_.wallet-adapter-button]:text-emerald-50 [&_.wallet-adapter-button]:font-bold [&_.wallet-adapter-button]:text-xs sm:[&_.wallet-adapter-button]:text-sm [&_.wallet-adapter-button]:hover:bg-emerald-500/35 transition-all active:scale-95 rounded-xl">
              <WalletMultiButton />
            </div>
            <a
              href="https://github.com/5iveVM/5ive-blackjack"
              target="_blank"
              rel="noreferrer"
              aria-label="5ive Blackjack GitHub repository"
              className="inline-flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl border border-emerald-300/25 bg-emerald-500/10 text-emerald-100 transition-colors hover:bg-emerald-500/20"
            >
              <Github className="h-5 w-5" />
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
}
