"use client";

import dynamic from "next/dynamic";
import { Github } from "lucide-react";
import { useNetworkConfig } from "@/components/providers/WalletContextProvider";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

type NavbarProps = {
  status?: string;
  chips?: number;
  activeBet?: number;
};

export function Navbar({ status, chips, activeBet }: NavbarProps) {
  const { network, setNetwork } = useNetworkConfig();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 px-2 py-2 sm:px-4 md:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="glass flex items-center justify-between gap-2 sm:gap-3 rounded-2xl border border-emerald-300/15 bg-emerald-950/65 px-3 py-2 sm:px-4 sm:py-3 md:px-6">
          <a
            href="https://5ive.tech"
            target="_blank"
            rel="noreferrer"
            className="text-lg font-black tracking-wide uppercase text-emerald-50 transition-opacity hover:opacity-80 md:text-xl"
          >
            5IVE
          </a>

          <div className="hidden lg:flex items-center gap-6 text-[11px] font-mono uppercase tracking-widest text-emerald-100/80">
            <span>status: {status || "ready"}</span>
            <span>bankroll: ${chips ?? 0}</span>
            <span>bet: ${activeBet ?? 0}</span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="hidden sm:flex items-center rounded-xl border border-white/10 bg-white/5 p-1">
              <button
                type="button"
                onClick={() => setNetwork("devnet")}
                className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors ${
                  network === "devnet"
                    ? "bg-emerald-500/35 text-emerald-50"
                    : "text-emerald-200/75 hover:bg-white/10"
                }`}
              >
                Devnet
              </button>
              <button
                type="button"
                onClick={() => setNetwork("mainnet")}
                className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors ${
                  network === "mainnet"
                    ? "bg-emerald-500/35 text-emerald-50"
                    : "text-emerald-200/75 hover:bg-white/10"
                }`}
              >
                Mainnet
              </button>
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
