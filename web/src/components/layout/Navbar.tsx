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
        <div className="glass flex items-center justify-between gap-2 sm:gap-3 rounded-2xl border border-primary/20 bg-black/60 px-3 py-2 sm:px-4 sm:py-3 md:px-6 shadow-xl">
          <a
            href="https://5ive.tech"
            target="_blank"
            rel="noreferrer"
            className="text-lg font-black tracking-widest uppercase text-primary transition-all hover:text-white md:text-xl drop-shadow-[0_0_8px_rgba(212,175,55,0.3)]"
          >
            5IVE
          </a>

          <div className="hidden lg:flex items-center gap-6 text-[11px] font-mono uppercase tracking-[0.2em] text-primary/70">
            <span>status: <span className="text-white/80">{status || "ready"}</span></span>
            <span>bankroll: <span className="text-white/80">${chips ?? 0}</span></span>
            <span>bet: <span className="text-white/80">${activeBet ?? 0}</span></span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="hidden sm:flex items-center rounded-xl border border-primary/10 bg-black/40 p-1">
              <button
                type="button"
                onClick={() => setNetwork("localnet")}
                className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-widest transition-all ${
                  network === "localnet"
                    ? "bg-primary text-primary-foreground shadow-lg"
                    : "text-primary/60 hover:text-primary hover:bg-white/5"
                }`}
              >
                Localnet
              </button>
              <button
                type="button"
                onClick={() => setNetwork("devnet")}
                className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-widest transition-all ${
                  network === "devnet"
                    ? "bg-primary text-primary-foreground shadow-lg"
                    : "text-primary/60 hover:text-primary hover:bg-white/5"
                }`}
              >
                Devnet
              </button>
              <button
                type="button"
                onClick={() => setNetwork("mainnet")}
                className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-widest transition-all ${
                  network === "mainnet"
                    ? "bg-primary text-primary-foreground shadow-lg"
                    : "text-primary/60 hover:text-primary hover:bg-white/5"
                }`}
              >
                Mainnet
              </button>
            </div>
            <div className="[&_.wallet-adapter-button]:h-9 sm:[&_.wallet-adapter-button]:h-10 [&_.wallet-adapter-button]:rounded-xl [&_.wallet-adapter-button]:border [&_.wallet-adapter-button]:border-primary/30 [&_.wallet-adapter-button]:bg-primary/10 [&_.wallet-adapter-button]:px-3 sm:[&_.wallet-adapter-button]:px-5 [&_.wallet-adapter-button]:text-primary [&_.wallet-adapter-button]:font-black [&_.wallet-adapter-button]:text-[10px] sm:[&_.wallet-adapter-button]:text-xs [&_.wallet-adapter-button]:uppercase [&_.wallet-adapter-button]:tracking-widest [&_.wallet-adapter-button]:hover:bg-primary/20 [&_.wallet-adapter-button]:transition-all active:scale-95 rounded-xl">
              <WalletMultiButton />
            </div>
            <a
              href="https://github.com/5iveVM/5ive-blackjack"
              target="_blank"
              rel="noreferrer"
              aria-label="5ive Blackjack GitHub repository"
              className="inline-flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/5 text-primary transition-all hover:bg-primary/15 hover:border-primary/40"
            >
              <Github className="h-5 w-5" />
            </a>
          </div>
        </div>

      </div>
    </nav>
  );
}
