const encode = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
let cachedToken;

// Azure trusts this Worker's public key. The private signing key is a Worker secret.
export function pcIdentity(path, env) {
  if (!env.PC_AZURE) return new Response("Not configured", { status: 503 });
  const config = JSON.parse(env.PC_AZURE);
  const publicKey = { kty: "RSA", n: config.key.n, e: config.key.e, kid: "pc-1", use: "sig", alg: "RS256" };
  return Response.json(path.endsWith("jwks.json") ? { keys: [publicKey] } : {
    issuer: config.issuer, jwks_uri: `${config.issuer}/pc-jwks.json`,
    response_types_supported: ["id_token"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
  }, { headers: { "Cache-Control": "public, max-age=300" } });
}

async function accessToken(env) {
  const config = JSON.parse(env.PC_AZURE);
  if (cachedToken?.client === config.client && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: "pc-1" })}.${encode({
    iss: config.issuer, sub: "interstellar-pc", aud: "api://AzureADTokenExchange", iat: now, nbf: now - 30, exp: now + 300, jti: crypto.randomUUID(),
  })}`;
  const key = await crypto.subtle.importKey("jwk", config.key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const response = await fetch(`https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/token`, {
    method: "POST", signal: AbortSignal.timeout(8000), body: new URLSearchParams({
      client_id: config.client, grant_type: "client_credentials", scope: "https://management.azure.com/.default",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: `${unsigned}.${Buffer.from(signature).toString("base64url")}`,
    }),
  });
  if (!response.ok) throw new Error("Azure authorization is unavailable. Please contact the site owner.");
  const body = await response.json();
  cachedToken = { client: config.client, value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

export async function azurePower(env, machine, action) {
  if (!["start", "deallocate", "instanceView"].includes(action)) throw new Error("Invalid power action");
  const token = await accessToken(env);
  const response = await fetch(`https://management.azure.com${machine.resourceId}/${action}?api-version=2024-07-01`, {
    method: action === "instanceView" ? "GET" : "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Azure could not ${action === "deallocate" ? "stop" : action === "start" ? "start" : "check"} your PC. Please try again shortly.`);
  if (action === "instanceView") return (await response.json()).statuses?.find(item => item.code.startsWith("PowerState/"))?.code;
}

export async function desktopFetch(machine, path, upgrade = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(`${machine.url}${path}`, {
      headers: { Authorization: `Bearer ${machine.key}`, ...(upgrade ? { Upgrade: "websocket" } : {}) },
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
}
