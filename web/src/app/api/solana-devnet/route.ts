const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

function resolveDevnetRpcTarget(): string {
  const configured = process.env.SOLANA_DEVNET_RPC_URL?.trim();
  return configured || PUBLIC_DEVNET_RPC;
}

export async function POST(request: Request): Promise<Response> {
  const payload = await request.text();
  const upstream = await fetch(resolveDevnetRpcTarget(), {
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
