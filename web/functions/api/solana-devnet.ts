interface Env {
  SOLANA_DEVNET_RPC_URL?: string;
}

const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const payload = await context.request.text();
  const upstream = await fetch(context.env.SOLANA_DEVNET_RPC_URL || PUBLIC_DEVNET_RPC, {
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
