'use strict'

// Every user-facing string in one place. translate(key, params) interpolates
// {placeholders} before the text is rendered/displayed. This is the single
// source of truth for copy — help, usage, hints, errors, lifecycle events,
// spinner labels — so wording and tone can't drift across the codebase.
// Note: {curly} placeholders (not ${}) keep the catalog lint-clean.

const messages = {
  // parsing (lib/state.js)
  'parse.invalid': "invalid entry '{raw}': expected <hostname>[/path][:port][:https]",
  'parse.invalidSpec': "invalid entry '{spec}'",
  'parse.invalidPort': "invalid port '{port}' ({min}-{max})",

  // map (lib/state.js, lib/commands.js)
  'map.duplicate': "duplicate entry '{host}{path}' — remove it first or edit the map",
  'map.duplicateInFile': "duplicate entry '{host}{path}'",
  'map.errors': 'map has errors — fix ~/.rootflare/domains first ({detail})',
  'map.lineError': 'line {line}: {message}',
  'map.empty': 'map is already empty',

  // lock
  'lock.busy': 'another rootflare command is running — try again in a moment',

  // cloudflared (lib/cloudflared.js)
  'cloudflared.installed': 'cloudflared installed',
  'cloudflared.installedVia': 'cloudflared installed ({kind})',
  'cloudflared.missing': "cloudflared not found — run 'rootflare install' first",
  'cloudflared.installHint': "run 'rootflare install'",
  'cloudflared.missingReason': "cloudflared not found — run 'rootflare install' first ({why})",
  'cloudflared.commandFailed': 'cloudflared {command} failed (exit {exitCode}): {stderr}',
  'cloudflared.zoneHint': "the domain's zone must be on your Cloudflare account; add the domain there first",

  // domain verification (lib/cloudflared.js)
  'verify.zoneNotCloudflare': "the zone '{zone}' is not on Cloudflare — add the domain to your Cloudflare account first",
  'verify.conflict': "'{host}' already resolves to '{target}' — the tunnel will override it",

  // login (lib/doctor.js, lib/commands.js)
  'login.hint': "run 'cloudflared tunnel login'",
  'login.done': 'logged in to Cloudflare',
  'login.required': "not logged in to Cloudflare — run 'cloudflared tunnel login', then re-run 'rootflare start …'",
  'login.prompt': "run 'cloudflared tunnel login' in another terminal, then press Enter to continue…",
  'login.stillMissing': 'still not logged in — run `cloudflared tunnel login` and re-run',

  // tunnel (lib/commands.js)
  'tunnel.initHint': "run 'rootflare init <tunnel-name-or-id>'",
  'tunnel.initHintFirst': "run 'rootflare init <tunnel-name-or-id>' first",
  'tunnel.initHintCreate': "run 'rootflare init <tunnel-name-or-id>' to create it",
  'tunnel.noTunnel': "no tunnel set — run 'rootflare init <tunnel-name-or-id>' first",
  'tunnel.created': "tunnel '{tunnel}' created",
  'tunnel.ready': "tunnel '{tunnel}' ready",
  'tunnel.createdAndSet': "tunnel '{tunnel}' created and set",
  'tunnel.set': "tunnel '{tunnel}' set",

  // daemon
  'daemon.notRunningHint': "ℹ daemon not running — run 'rootflare up' to go live",
  'daemon.started': 'daemon started',
  'daemon.alreadyRunning': 'daemon already running',
  'daemon.stopped': 'daemon stopped',
  'daemon.stopFailed': 'could not stop the daemon',
  'daemon.failedToStart': 'daemon failed to start — check `rootflare logs`',
  'daemon.running': "● rootflare is running (pid {pid}) — tunnel '{tunnel}'",

  // lifecycle events written to tunnel.log
  'lifecycle.daemonStarted': 'rootflare: daemon started (pid {pid})',
  'lifecycle.daemonStopped': 'rootflare: daemon stopped',
  'lifecycle.startFailed': 'rootflare: failed to start cloudflared: {message}',
  'lifecycle.mapped': 'rootflare: mapped {host}{path} → localhost:{port}',
  'lifecycle.removed': 'rootflare: removed {host}',
  'lifecycle.removedAll': 'rootflare: removed all {count} entries',

  // start command
  'start.live': 'https://{host} is live → localhost:{port}',
  'start.mapped': '{host} → localhost:{port}{path}',
  'start.alreadyMapped': '{host} already mapped to localhost:{port}',

  // add / remove
  'add.done': '{host} {service}',
  'remove.done': '{host} removed',
  'remove.missing': '{host} is not in the map',
  'removeAll.done': 'removed all {count} {noun} from the map',

  // list
  'list.dnsMissing': 'cloudflared not installed',
  'list.invalidLines': '⚠ {count} invalid line(s) skipped — see the map file',
  'list.hint': 'edit the map and run `rootflare up` to apply',
  'list.header.hostname': 'HOSTNAME',
  'list.header.port': 'PORT',
  'list.header.dns': 'DNS',
  'list.header.service': 'SERVICE',

  // doctor
  'doctor.check.tunnelSet': 'tunnel set',
  'doctor.check.tunnelExists': 'tunnel exists in Cloudflare',
  'doctor.check.mapValid': 'map valid',
  'doctor.checkLine': '{name} — {hint}',
  'doctor.failed': '{count} preflight check(s) failed — fix them and re-run',
  'doctor.allGood': 'all systems go',
  'doctor.unsupported': 'run on macOS or Linux (WSL recommended on Windows)',
  'doctor.installStepFailed': 'install step failed: {step} ({why})',

  // logs / countdown
  'logs.waitingForLog': 'waiting for tunnel.log — start the daemon with `rootflare up`',
  'countdown.waiting': 'waiting {seconds}s for the tunnel to connect…',
  'countdown.warmup': 'warming up the tunnel',

  // spinner labels
  'spin.routing': 'routing DNS + applying',
  'spin.install': 'installing cloudflared',
  'spin.apply': 'applying map',
  'spin.startDaemon': 'starting daemon',
  'spin.foreground': 'starting in foreground',

  // dry-run plan
  'dryrun.banner': '# dry-run — nothing was executed',
  'dryrun.install': '# would install: cloudflared',
  'dryrun.login': '# requires: cloudflared tunnel login (browser step)',
  'dryrun.init': "# would init: tunnel '{tunnel}'",
  'dryrun.add': '# would add + route dns: {host} → localhost:{port}',
  'dryrun.updatePort': '# would update port: {host} {oldPort} → {port}',
  'dryrun.up': '# would start the daemon (up)',
  'dryrun.routeDns': '# would run: cloudflared tunnel route dns {tunnel} {host}',
  'dryrun.remove': '# would remove: {host}',
  'dryrun.removeAll': '# would remove all {count} {noun}',

  // usage
  'usage.start': 'usage: rootflare start <hostname> [port][/path][:https] [--tunnel <name>] [--no-install] [--dry-run]',
  'usage.init': 'usage: rootflare init <tunnel-name-or-id>',
  'usage.add': 'usage: rootflare add <hostname> [port][/path][:https] [--dry-run]',
  'usage.remove': 'usage: rootflare remove <hostname> | remove --all [--dry-run]',
  'usage.removeAllConflict': 'cannot combine --all with a hostname',

  // help / version (bin/rootflare.js)
  'help.usage': 'Usage: rootflare <command> [options]',
  'help.commands': 'Commands:',
  'help.options': 'Options:',
  'help.commandLine': '  {name} {desc}',
  'help.versionFlag': '  --version  Print the version',
  'help.helpFlag': '  --help     Show this help',
  'help.unknownCommand': "unknown command '{name}'",
  'version.line': 'rootflare v{version}',

  // status dot
  'ui.dot.running': '● running (pid {pid})',
  'ui.dot.stopped': '○ stopped',

  // command registry descriptions (shown in --help)
  'cmd.desc.start': 'One-click: install → init → add → up → live (idempotent)',
  'cmd.desc.install': 'Install cloudflared for your OS',
  'cmd.desc.init': 'Set the tunnel, create ~/.rootflare, seed the map',
  'cmd.desc.add': 'Map a domain → route DNS → apply',
  'cmd.desc.remove': 'Unmap a domain → apply',
  'cmd.desc.list': 'Map table + daemon status (--json for scripts)',
  'cmd.desc.up': 'Generate config + start the daemon (--dry-run, --foreground)',
  'cmd.desc.down': 'Stop the daemon',
  'cmd.desc.logs': 'Live-tail tunnel.log',
  'cmd.desc.doctor': 'Preflight checks + install hints'
}

function translate (key, params = {}) {
  const template = messages[key]
  if (template === undefined) throw new Error(`unknown message key '${key}'`)
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

module.exports = { translate, messages }
