// Keep the public game's workers and chunk URLs on one origin; never forward account cookies.
export default {
  async fetch(request) {
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    url.protocol = "https:";
    url.hostname = "gta5-87g.pages.dev";
    url.port = "";
    const headers = new Headers();
    for (const name of ["Range", "If-None-Match", "If-Modified-Since"]) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    try {
      const upstream = await fetch(url, { method: request.method, headers, redirect: "manual" });
      const response = new Response(upstream.body, upstream);
      response.headers.delete("Set-Cookie");
      response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return response;
    } catch {
      return new Response("The game host is unavailable. Please try again shortly.", { status: 502 });
    }
  },
};
