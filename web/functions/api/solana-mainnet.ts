interface Env {
  SOLANA_MAINNET_RPC_URL?: string;
}

const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const payload = await context.request.text();
  const upstream = await fetch(context.env.SOLANA_MAINNET_RPC_URL || PUBLIC_MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
};
