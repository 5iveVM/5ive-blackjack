const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

function resolveMainnetRpcTarget(): string {
  const configured = process.env.SOLANA_MAINNET_RPC_URL?.trim();
  return configured || PUBLIC_MAINNET_RPC;
}

export async function POST(request: Request): Promise<Response> {
  const payload = await request.text();
  const upstream = await fetch(resolveMainnetRpcTarget(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    cache: "no-store",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
}
