# rootflare

![rootflare banner](public/banner.svg)

**Your localhost, live on your own domain. Free. Forever.**

[![npm version](https://img.shields.io/npm/v/rootflare.svg)](https://www.npmjs.com/package/rootflare)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-1--pino-brightgreen.svg)](package.json)

Everyone who uses free [Ngrok](https://stackoverflow.com/questions/64058822/ngrok-url-changes-everyday-i-launch-ngrok) complains about how the URL keeps on changing.

You can [configure Ngrok to be static](https://ngrok.com/blog/free-static-domains-ngrok-users) or you can use rootflare (this NPM package) and map unlimited number of domains to your local ports.

```bash
npx rootflare start app.example.com 3000
```

That's all. The `start` is idempotent — re-run it anytime to make sure the domain is still mapped and running.

Your domains, your URLs.
No random subdomains, no quotas, and no "Upgrade" screen.

## What it does

Running `start` installs `cloudflared` if needed, creates the tunnel, routes your DNS, starts the daemon, and confirms the domain is live. Every step is also its own command below.

## Prerequisites

1. **Node ≥ 18.**
2. **A Cloudflare account with your own domain.** Your domain's zone must be added to
   Cloudflare and use Cloudflare's nameservers — that's how Cloudflare verifies you own
   it. Tunnels serve _your_ domains: there are no throwaway URLs like some tunnel services.
3. **Your app running locally** on the port you map (e.g. `localhost:3000` serving a [NextJS app](http://nextjs.org/)).

`start` installs `cloudflared` for you and pauses for `cloudflared tunnel login` if you're not logged in yet.

## Commands

| Command                                | What it does                                                              |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `start <hostname> <port>`              | One-click: install → init → add → up → live (`--dry-run` prints the plan) |
| `install`                              | Install cloudflared for your OS                                           |
| `init <tunnel-name-or-id>`             | Set the tunnel (auto-creates it if missing)                               |
| `add <hostname> [port][/path][:https]` | Map a domain (`--dry-run` prints the plan)                                |
| `remove <hostname>`                    | Unmap a domain (`--all` clears the map)                                   |
| `list [--json]`                        | Map table + daemon status (`--json` for scripts)                          |
| `up [--foreground] [--dry-run]`        | Generate config + start the daemon                                        |
| `down`                                 | Stop the daemon                                                           |
| `logs`                                 | Live-tail `tunnel.log`, colorized                                         |
| `doctor`                               | Preflight checks + install hints                                          |

Bare `rootflare` (or `--help`) prints help with the banner. Exit codes: `0` ok, `1` runtime error, `2` usage.

## The map file

`~/.rootflare/domains` is the single source of truth — hand-editable:

```
# <hostname>[/path][:port][:https] — port defaults to 3000
app.example.com:3000
app.example.com/api:8080
*.dev.example.com:3000
secure.example.com:3000:https
```

Edit the file and run `rootflare up` to apply.

## Environment variables

| Variable                | Effect                                                                   |
| ----------------------- | ------------------------------------------------------------------------ |
| `ROOTFLARE_HOME`        | Custom state directory instead of `~/.rootflare`                         |
| `ROOTFLARE_CLOUDFLARED` | Custom `cloudflared` binary path                                         |
| `ROOTFLARE_COUNTDOWN`   | Seconds `start` waits for the tunnel to connect (default `5`, `0` skips) |
| `ROOTFLARE_SKIP_VERIFY` | Skip the pre-flight domain checks                                        |
| `NO_COLOR`              | Disables colored output                                                  |

## Not in v1

- `tcp://` services (SSH, databases, …) — HTTP/HTTPS origins only.
- Autostart on boot.
- `remove` leaves the DNS CNAME in place (deleting it needs the Cloudflare API).

## License

MIT — see [LICENSE](./LICENSE).
