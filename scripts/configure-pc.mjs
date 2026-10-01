import { readFile, writeFile } from "node:fs/promises";
import { generateKeyPairSync, createHash } from "node:crypto";
const privateDir = new URL("../.wrangler/", import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, privateDir), "utf8"));
const identity = await read("pc-azure-identity.json");
let key;
try { key = await read("pc-signing-key.json"); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
  await writeFile(new URL("pc-signing-key.json", privateDir), JSON.stringify(key));
}
const machines = [];
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["interstellar-pc-01"]) {
  const pc = await read(`${name}.json`);
  machines.push({ id: name, resourceId: `${identity.id.split("/providers/")[0]}/providers/Microsoft.Compute/virtualMachines/${name}`,
    url: `https://${pc.dns}.${pc.location}.cloudapp.azure.com`, key: pc.gatewayKey,
    invitationHash: createHash("sha256").update(pc.invitation).digest("hex"),
  });
}
await writeFile(new URL("pc-secrets.json", privateDir), JSON.stringify({
  PC_AZURE: JSON.stringify({ client: identity.clientId, tenant: identity.tenantId, issuer: "https://interstellar.gonicvrnew.workers.dev", key }),
  PC_MACHINES: JSON.stringify(machines),
}));
console.log("Private PC configuration prepared for Cloudflare.");
