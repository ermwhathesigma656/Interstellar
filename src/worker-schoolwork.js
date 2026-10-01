// Keep the existing schoolwork namespaces intact; both addresses use the same live site and accounts.
export { VirtualPC } from "./worker-pc.js";
export { DiscordAssets } from "./discord-assets.js";
export default { fetch: (request, env) => env.INTERSTELLAR.fetch(request) };
