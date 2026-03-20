interface Env {
  SOLANA_MAINNET_RPC_URL?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const rpcTarget = context.env.SOLANA_MAINNET_RPC_URL?.trim();
  if (!rpcTarget) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "SOLANA_MAINNET_RPC_URL is not configured for this Cloudflare environment.",
        },
        id: null,
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      }
    );
  }

  const payload = await context.request.text();
  const upstream = await fetch(rpcTarget, {
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
