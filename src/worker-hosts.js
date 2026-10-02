const backend = "https://interstellar.gonicvrnew.workers.dev";

export function routeHost(request, env) {
  const url = new URL(request.url);
  const accountAPI = url.pathname.startsWith("/api/pc/") || url.pathname === "/api/ai/chat";
  // Keep existing desktop sessions able to release their leases during the move.
  if (url.hostname === "schoolwork.gonicvrnew.workers.dev" && !accountAPI) {
    url.hostname = "schoolworkv2.gonicvrnew.workers.dev";
    return new Response(null, { status: 307, headers: { Location: url.href, "Cache-Control": "no-store" } });
  }
  if (url.origin !== backend && env.PC_BACKEND && accountAPI) {
    const headers = new Headers(request.headers);
    if (headers.get("Origin") === url.origin) headers.set("Origin", backend);
    url.hostname = new URL(backend).hostname;
    return env.PC_BACKEND.fetch(new Request(new Request(url, request), { headers }));
  }
  return null;
}
