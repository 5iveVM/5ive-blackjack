"use client";

import { useMemo } from "react";
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
  className?: string;
}

export function PlayingCard({ rankLabel, suitLabel, hidden, index, className }: PlayingCardProps) {
  const isRed = suitLabel === "♥" || suitLabel === "♦";
  
  // Create a pseudo-random rotation based on the index to simulate organic dealing
  const randomRotation = useMemo(() => (Math.random() * 6 - 3), [index]);

  return (
    <div style={{ perspective: 1000 }} className={cn("w-14 h-20 sm:w-16 sm:h-24 md:w-20 md:h-28 shrink-0", className)}>
      <motion.div
        className="w-full h-full relative"
        initial={{ rotateY: 180, y: -150, x: 100, opacity: 0, rotate: 20 }}
        animate={{ 
          rotateY: hidden ? 180 : 0, 
          y: 0, 
          x: 0, 
          opacity: 1,
          rotate: randomRotation 
        }}
        transition={{
          duration: 0.7,
          type: "spring",
          bounce: 0.3,
          delay: index * 0.12,
        }}
        style={{ transformStyle: "preserve-3d" }}
      >
        {/* Front */}
        <div
          className={cn(
            "absolute inset-0 rounded-lg border-2 shadow-2xl bg-white overflow-hidden",
            isRed ? "border-red-500/20 text-red-600" : "border-slate-300/50 text-slate-900"
          )}
          style={{ backfaceVisibility: "hidden" }}
        >
          {/* Main content wrapper with padding */}
          <div className="relative w-full h-full p-1.5 sm:p-2 flex flex-col items-center justify-between">
            {/* Top-Left Label */}
            <div className="absolute top-1.5 left-1.5 flex flex-col items-start leading-none pointer-events-none">
              <span className="text-xs sm:text-sm md:text-base font-black tracking-tighter uppercase">{rankLabel}</span>
              <span className="text-[10px] sm:text-xs md:text-sm font-bold -mt-0.5">{suitLabel}</span>
            </div>
            
            <div className="text-3xl sm:text-4xl md:text-4xl self-center drop-shadow-sm select-none my-auto">
              {suitLabel}
            </div>
            
            {/* Bottom-Right Label */}
            <div className="absolute bottom-1.5 right-1.5 flex flex-col items-end leading-none rotate-180 pointer-events-none">
              <span className="text-xs sm:text-sm md:text-base font-black tracking-tighter uppercase">{rankLabel}</span>
              <span className="text-[10px] sm:text-xs md:text-sm font-bold -mt-0.5">{suitLabel}</span>
            </div>
          </div>
          
          {/* Subtle card texture overlay */}
          <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[url('https://www.transparenttextures.com/patterns/linen.png')] rounded-lg" />
        </div>

        {/* Back */}
        <div
          className="absolute inset-0 rounded-lg border-2 border-primary/30 overflow-hidden shadow-2xl bg-[#1a1a1a]"
          style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
        >
          <div className="w-full h-full bg-[radial-gradient(circle_at_50%_50%,_rgba(212,175,55,0.2)_0%,_transparent_80%)] flex items-center justify-center p-1">
             <div className="w-full h-full border border-primary/20 rounded-md flex items-center justify-center bg-black/40 backdrop-blur-sm overflow-hidden relative">
                {/* Guilloche-style pattern */}
                <div className="absolute inset-0 opacity-20 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] scale-150" />
                <span className="relative text-lg sm:text-xl md:text-2xl font-black italic tracking-widest text-primary drop-shadow-[0_0_10px_rgba(212,175,55,0.4)]">
                  5
                </span>
             </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

