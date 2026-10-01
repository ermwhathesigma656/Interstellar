<div align="center">
    <img src="https://raw.githubusercontent.com/UseInterstellar/Interstellar/main/.github/branding/in.png">
    <p>Serving over 15 million users since 2022.<p>
    <p>Interstellar is a web proxy with a Clean and Sleek UI and easy to use menus. Our goal is to provide the best user experience to everyone.</p>
</div>

![inpreview](https://github.com/UseInterstellar/Interstellar/assets/89202835/2669efed-5186-4932-83c4-725acae60bd2)

> [!IMPORTANT]
> If you fork this project, consider giving it a star in the original repository!

**Join Our [Discord Community](https://discord.gg/interstellar) for support, more links, and an active community!**

## Features

- About:Blank Cloaking
- Tab Cloaking
- Wide collection of apps & games
- Clean, Easy to use UI
- Inspect Element
- Various Themes
- Password Protection (Optional)
- Built-in Tab System
- Now.gg Support
- Fast Speeds
- Geforce NOW Support

## Deployment

### Cloudflare Workers

This fork includes a Workers adapter. Connect this repository in Workers Builds and
use `npx wrangler deploy` as the deploy command. Leave the dashboard build command
empty; `wrangler.jsonc` runs the existing build and bundles the Worker automatically.
No Containers or paid plan is required. To test locally, run `pnpm preview`,
then `pnpm test:worker` in another terminal.

Workers automatically uses its native HTTP and WebSocket APIs for browsing instead
of restricted TCP sockets. Discord's public app files use Cloudflare Browser Run
when Discord rejects ordinary Worker requests. A SQLite Durable Object saves these
files for seven days and shares one browser across concurrent requests. Account
traffic and WebSockets continue through the regular transport; credentials are
never forwarded to the shared browser or stored in the asset cache. Browsers close
after eight idle seconds. This stays entirely on Cloudflare's free products, subject
to their daily quotas, including Browser Run's 10 minutes per day. Existing cached
files remain available when that allowance runs out. Other destination websites'
restrictions still apply; UDP is unavailable. Custom Wisp URLs use the selected
Epoxy/libcurl transport.
Local settings and the standard Node deployment remain supported.
`pnpm test:worker` checks Discord app scripts against their original bytes, checks
the saved copies, and tests the login HTML, API, and gateway connection.

The **AI** tab supports text conversations and JPEG, PNG, or WebP uploads through
OpenAI's `gpt-6-luna` model. On Cloudflare, add `OPENAI_API_KEY` as a
**Secret** under the Worker's Settings → Variables and Secrets, or run
`npx wrangler secret put OPENAI_API_KEY`. Never put the key in `static/` or Git.
For local Workers development, put `OPENAI_API_KEY="your-key"` in the ignored
`.dev.vars` file beside the Wrangler config. Run `npm run test:ai` for the API checks.
This endpoint runs on the Workers deployment, not the optional Node server.
Chats stay in the current tab and send recent context plus up to three images to
OpenAI. Uploads are resized before sending; no chat database is used. Requests are
limited to ten per minute per IP at each Cloudflare location, plus OpenAI's account
limits. These are best-effort abuse limits, not a billing cap. The OpenAI model
may need updating if OpenAI retires it.

The **PC** tab connects to a real Windows 10 Azure VM using noVNC. Each account
automatically claims one available VM on its first start. When automatic provisioning
is configured, it creates a VM if none is available, up to the owner's total PC cap.
Each account owns one PC at a time; repeated starts never create another.
**Delete my PC** asks for confirmation before permanently erasing its files, apps,
and settings. The account remains, and can create a fresh PC after cleanup finishes.
Deletion continues through Durable Object alarms even if the page closes, and retains
the old assignment until the VM, disk and dedicated network resources are confirmed
removed. Deleted preconfigured PCs are retired from the assignment pool. The original
PCs' shared virtual network is retained. The Azure role needs `delete` permissions for
`Microsoft.Compute/virtualMachines`, `Microsoft.Compute/disks`, and
`Microsoft.Network/{networkInterfaces,publicIPAddresses,networkSecurityGroups,virtualNetworks}`
within the same resource group; resource-group deletion is not required.
`VirtualPC` Durable Objects serialize
session ownership: only one tab/device can control an account's PC. Closing the
tab releases it; lost connections expire after three minutes. Durable Object alarms
retry Azure deallocation until confirmed, and start requests wait for shutdown
to finish. Windows files persist on the OS disk; save documents before leaving,
because running applications and unsaved work do not survive shutdown.

The Worker uses an Azure user-assigned managed identity with federated trust in
its signing key and a resource-group-scoped role for VM lifecycle and deployment of
dedicated VM/network resources. `PC_AZURE` and `PC_MACHINES` are **Worker secrets**. Only the
public verification key is served by `/pc-jwks.json`. The guest runs TightVNC on
loopback, a WebSocket bridge, and Caddy HTTPS. Azure exposes only ports 80/443;
desktop requests also require a private gateway key injected by the Worker.

Owner setup scripts live in `scripts/`: `create-pc.ps1`, `install-pc.ps1`, and
`configure-pc.mjs`. Generated Windows passwords, signing keys,
and deployment inputs stay in the ignored `.wrangler` directory. After adding a
VM, run `node scripts/configure-pc.mjs <all-vm-names>` and upload the resulting
`.wrangler/pc-secrets.json` with `wrangler secret bulk`. Keep every existing VM in
that list. Each added PC consumes Azure credits, including disk/IP charges while
deallocated. Keep the Azure Students spending limit enabled. This is not an
unlimited free VM service. Run `npm run test:pc` for isolation and lifecycle checks.

For automatic creation, put `resourceGroup` (full Azure resource ID), `location`,
`maxPCs` (the total account/PC cap), and `sourceRoot` (an immutable Git commit's
HTTPS scripts directory) in `.wrangler/pc-provisioning.json` before running the
configuration script. `location` is the region for new PCs; existing PCs keep their
original region, including deployment retries. Validate the VM size and regional
quota before changing it or raising the total cap. The deployment uses secure parameters for Windows passwords
and gateway credentials, creates a separate network per PC, installs the gateway,
and restarts Windows after the extension completes. A closed session is deallocated
after any in-progress deployment finishes. Existing Windows image activation is
preserved; website users never enter a Windows key or a PC assignment code.

The desktop reconnects automatically after an interrupted connection. Its toolbar
provides Restart, Reconnect, Show desktop, picture quality and full-screen controls.
Full screen includes noVNC's body-mounted fallback cursor; a visible dot is shown
when Windows has not supplied a cursor image.
Upload file / EXE streams files up to 50 MB into that PC's Windows Downloads folder;
files are never automatically run or overwritten. The guest validates Windows
filenames, removes interrupted transfers, and preserves Windows download marking.
`schoolwork.gonicvrnew.workers.dev` uses a service binding for the PC and AI APIs,
so both addresses share accounts and PC ownership. GitHub deployments retain that
binding. Deploy that address with `npx wrangler deploy --name schoolwork`; keep the
main `interstellar` Worker because it owns the PCs and supplies Azure's signing keys.

> [!IMPORTANT]
> You **cannot** deploy to static web hosts, including Netlify, Cloudflare Pages, and GitHub Pages.

### Password Protection

1. Go to the `config.js` file and set `challenge` to **true**. Then, set the environment variable as follows:
2. For PNPM: Run either `config=true pnpm start` or `$env:config=true; pnpm start`, depending on your server.
3. For Bun: Run either `config=true bun start` or `$env:config=true; bun start` if you prefer Bun.
4. For NPM: Run either `config=true npm start` or `$env:config=true; npm start` if you prefer NPM.


### Server Deployment

You must run these commands on your server:

```bash
git clone https://github.com/UseInterstellar/Interstellar
cd Interstellar
```

#### Ad-Free Deployment

```bash
git clone --branch Ad-Free https://github.com/UseInterstellar/Interstellar
cd Interstellar
```

Next depending on your package manager, run one of the following commands:

#### Bun

If you are using Bun, run the following commands:

```bash
bun i
bun start
```

#### pnpm

If you are using pnpm, run the following commands:

```bash
pnpm i
pnpm start
```

#### npm

If you are using npm, run the following commands:

```bash
npm i
npm run start
```

### Updating

```bash
cd Interstellar
git pull --force --allow-unrelated-histories # This may overwrite your local changes
```

<a target="_blank" href="https://heroku.com/deploy/?template=https://github.com/UseInterstellar/Interstellar"><img alt="Deploy to Heroku" src="https://binbashbanana.github.io/deploy-buttons/buttons/remade/heroku.svg"></a>
<a target="_blank" href="https://app.koyeb.com/deploy?type=git&repository=github.com/UseInterstellar/Interstellar"><img alt="Deploy to Koyeb" src="https://binbashbanana.github.io/deploy-buttons/buttons/remade/koyeb.svg"></a>

### Deployment Alternatives

For more deployment options, join our [Discord Server](https://discord.gg/interstellar) for various ways to deploy Interstellar.
This includes methods of deploying to Render/OnRender.

#### What happened to Replit Deployment?

As of January 1st, 2024, Replit is [no longer free](https://blog.replit.com/hosting-changes). Try GitHub Codespaces instead.

### GitHub Codespaces

> [!NOTE]
> If you're setting the port below 1023, then you must run `sudo PORT=1023`

1. Create a GitHub account if you haven't already.
2. Click "Code" (green button) and then "Create Codespace on main."
3. In the terminal at the bottom, paste `pnpm i && pnpm start`.
4. Respond to the application popup by clicking "Make public."
> [!IMPORTANT]
> Make sure you click the "Make public." button, or the proxy won't function properly.<br>
> If you get a Range Error, go back and make sure you clicked Make public!
5. Access the deployed website from the ports tab.
6. For subsequent uses in the same codespace, just run `pnpm start`

### Solution for if there is no popup.

1. Run `pnpm i`, and before `pnpm start`, prepend `PORT=8080`, replacing 8080 with another port. For example, `PORT=6969 pnpm start`.
2. If this does not work then you can prepend `$env:PORT=8080;`, replacing 8080 with another port. For example, `$env:PORT=6969; pnpm start`
3. Go to the ports tab, Click Forward A Port, And type the port number.
4. Right-click Visibility and set Port Visibility to Public.

> [!NOTE]
> We are committed to making Interstellar easy and personalized however, as of now we need your support in making it ad-free. Consider keeping ads so Interstellar can run freely or contribute by being a supporter.

## Report Issues

If you encounter problems, open an issue on GitHub, and we'll address it promptly.

> [!TIP]
> If you're having trouble, don't hesitate to reach out to us on [Discord](https://discord.gg/interstellar) for personalized support.

# Credits

A huge thanks goes out to all of the people who have contributed to Interstellar.

[![Contributors](https://contrib.rocks/image?repo=UseInterstellar/Interstellar)](https://github.com/UseInterstellar/Interstellar/graphs/contributors)
