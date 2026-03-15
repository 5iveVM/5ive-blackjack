"use client";

import { motion } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface PlayingCardProps {
  rankLabel: string;
  suitLabel: string;
  hidden: boolean;
  index: number;
}

export function PlayingCard({ rankLabel, suitLabel, hidden, index }: PlayingCardProps) {
  const isRed = suitLabel === "♥" || suitLabel === "♦";
  
  return (
    <div style={{ perspective: 1000 }} className="w-20 h-28 shrink-0">
      <motion.div
        className="w-full h-full relative"
        initial={{ rotateY: 180, y: -50, opacity: 0 }}
        animate={{ rotateY: hidden ? 180 : 0, y: 0, opacity: 1 }}
        transition={{
          duration: 0.6,
          type: "spring",
          bounce: 0.4,
          delay: index * 0.15,
        }}
        style={{ transformStyle: "preserve-3d" }}
      >
        {/* Front */}
        <div
          className={cn(
            "absolute inset-0 rounded-xl border flex flex-col justify-between p-2 shadow-2xl bg-gradient-to-br from-white to-slate-50",
            isRed ? "border-red-400/50 text-red-600" : "border-slate-300 text-slate-900"
          )}
          style={{ backfaceVisibility: "hidden" }}
        >
          <div className="text-sm font-bold leading-none tracking-tighter">{rankLabel}</div>
          <div className="text-4xl self-center drop-shadow-sm">{suitLabel}</div>
          <div className="text-sm font-bold leading-none tracking-tighter rotate-180 self-end">{rankLabel}</div>
        </div>

        {/* Back */}
        <div
          className="absolute inset-0 rounded-xl border border-indigo-400/30 overflow-hidden shadow-2xl glass-card"
          style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
        >
          <div className="w-full h-full bg-[radial-gradient(circle_at_50%_0%,_rgba(157,78,221,0.3)_0%,_transparent_70%)] flex items-center justify-center p-1">
             <div className="w-full h-full border border-white/10 rounded-lg flex items-center justify-center bg-black/20 backdrop-blur-sm">
                <span className="text-lg font-black italic tracking-widest text-transparent bg-clip-text bg-gradient-to-br from-purple-400 to-pink-300 drop-shadow-[0_0_10px_rgba(224,170,255,0.5)]">
                  5.
                </span>
             </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
