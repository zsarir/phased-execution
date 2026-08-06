# 📱 Reaching it from your phone

> *An unattended run exists so you can stop watching it. That only pays off if it can still reach you.*

A run halts when it needs a person — a command it will not take on its own authority, a check only
you can make. It raises an **approval** and waits. If the console is only reachable from the chair in
front of it, every one of those pauses lasts until you sit back down.

This section sets up the console so you can watch a run, answer an approval, and start the next phase
from a phone, on any network, without putting anything on the public internet.

It takes about ten minutes, and most of it is clicking two switches.

> **The short way.** Settings → *Reach this console from your phone* reads your tailnet live: which
> devices are on it, whether `serve` points at this console, and whether the console's own
> `--remote` flags agree with it — that last disagreement is the one that looks fine from your desk
> and fails from the phone. The card carries a copy-paste prompt that does the whole setup; it is
> [Prompt 2 in the README](../README.md). Everything below is the same thing done by hand, plus the
> parts the card does not cover — push notifications, out-of-band alerts, and what is enforced.

## The shape of it

```
  your phone, anywhere                       your machine
  ────────────────────                       ────────────
  https://your-machine.your-tailnet.ts.net
        │
        │  encrypted, private network, no open ports
        ▼
  tailscaled ──────────── sets Tailscale-User-Login: you@example.com
        │
        │  http://127.0.0.1:4123
        ▼
  Phase Console ───────── still bound to loopback. It always was.
```

**The console does not open a port on a network — not before this, and not after.** It keeps
listening on `127.0.0.1`, and something that already knows who you are is placed in front of that
socket. [Tailscale Serve][ts-serve] is that something: it terminates TLS, authenticates the caller
against your private network, and forwards to loopback with the caller's login in a header.

That header is the whole authentication story, and it is only worth anything *because* the console
stays on loopback. If it listened on a network interface, anyone who could reach it could simply send
the header themselves. This is [Tailscale's own guidance][ts-serve]: *"it's best practice to only
have the service listen on localhost."*

You need a [Tailscale](https://tailscale.com) account. The free tier covers this comfortably.

## Step 1 · Turn on three things for your tailnet

All three are off by default and all three are needed. The first two are on the [DNS page of the
admin console](https://login.tailscale.com/admin/dns):

1. **Enable MagicDNS.** This is what makes `your-machine.your-tailnet.ts.net` resolve for your own
   devices. Without it you would be typing an IP address, and an IP address cannot have a
   certificate.
2. **Enable HTTPS Certificates.** Tailscale then provisions a real, publicly-trusted certificate for
   that name. HTTPS *requires* MagicDNS, so do them in this order.
3. **Enable Serve.** This one has no switch to find in advance: the first time you run
   `tailscale serve` on a tailnet that has never used it, the command prints an approval link
   containing that machine's node ID and then **waits** rather than exiting. Open the link, approve
   it, and the command you already ran continues on its own. If you would rather do it up front, run
   the Step 4 command now and click what it gives you.

> **Know what you are agreeing to.** Every certificate on the web is recorded in the public
> Certificate Transparency log, so enabling this publishes your machine's name — e.g.
> `your-machine.your-tailnet.ts.net`. The **name** becomes public. The machine does not: it stays
> unreachable from the internet, and nothing about this opens a port.

While you are in the admin console, on the [Machines
page](https://login.tailscale.com/admin/machines), **disable key expiry** for this machine. Node keys
expire by default, and when one does, remote access stops with no warning and no obvious cause.

## Step 2 · Put your phone on the same tailnet

Install the Tailscale app, sign in with the same account, and — this one is easy to miss — make sure
**"Use Tailscale DNS" is ON** in the app's settings. It is what lets the phone resolve the `.ts.net`
name. Without it the name simply will not load, and nothing else in this guide will work.

Check `tailscale status` on your machine; the phone should be listed.

## Step 3 · Tell the console who may arrive

Two new flags. Neither changes what the server binds to:

| Flag | Meaning |
|---|---|
| `--remote <host>` | The console also answers to this hostname, which is fronted by an authenticating proxy. Repeatable. |
| `--remote-user <login>` | A login allowed to arrive that way. Repeatable, or `PHASE_CONSOLE_REMOTE_USERS` as a comma-separated list. **Required** by `--remote`. |

```bash
./start --root ~/code/your-repo --allow-writes --allow-run \
        --remote your-machine.your-tailnet.ts.net \
        --remote-user you@example.com
```

Use your real MagicDNS name — `tailscale status --json` prints it as `Self.DNSName` — and the login
you signed in with.

`--remote` without `--remote-user` **refuses to start**. Starting with no allowlist would look
completely correct and quietly admit everyone on your network, so it is an error rather than a
warning.

To have it survive reboots and logouts, install it as a background agent (launchd on macOS, a
systemd user service on Linux) with the same flags — they are passed straight through:

```bash
./start --install-agent --root ~/code/your-repo --allow-writes --allow-run \
        --remote your-machine.your-tailnet.ts.net --remote-user you@example.com
./start --agent-status
```

## Step 4 · Put the proxy in front of it

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4123
tailscale serve status          # confirm what is being served
```

**The first run on a tailnet that has never used Serve will not return.** It prints
*"Serve is not enabled on your tailnet"* with an approval link, and waits for you to open it. That is
the Step 1 item you cannot do in advance — approve it and the command finishes by itself. Every run
after that returns immediately.

**`--bg` is not optional if you want this to last.** With it, Serve is persistent: it comes back
after a reboot and after `tailscale down` / `tailscale up`. Without it, Serve lives only as long as
that foreground command, and you will be re-running it by hand forever.

To undo it: `tailscale serve --https=443 http://127.0.0.1:4123 off`, or `tailscale serve reset` to
clear everything.

**More than one project?** 4123 is the port of the *first* console on the machine; the others derive
their own (`phase-console list` prints them). Serve each one you want on the phone, on its own
HTTPS port — `tailscale serve --bg --https=8443 http://127.0.0.1:4187` — and install each as its own
Home Screen app. Nothing below changes: a console is a normal origin, and the phone treats two of
them as two sites.

Now open `https://your-machine.your-tailnet.ts.net/` on the phone. Padlock, no warning, no port
number.

## Step 5 · Install it on the Home Screen

In Safari: **Share → Add to Home Screen**.

This is not decoration. On iOS, **web notifications only exist for a site installed to the Home
Screen** — in an ordinary Safari tab the permission cannot even be requested. Since the notification
is the entire point of being reachable, the install is part of the setup rather than a nicety.

Once it is installed, open it from the Home Screen and grant notification permission from the button
in **Settings**. Permission is never demanded on load: a page that asks the moment it opens gets
refused by reflex, and that refusal is permanent.

You will get a notification when a run **halts**, when it is **parked**, when it **finishes**, and
when an **approval** is waiting — and deliberately not for every phase, because a channel that fires
constantly is a channel you learn to ignore.

Android needs none of this — notifications work in a normal HTTPS tab — but installing it still gives
you a cleaner window.

## Step 6 · Turn on push, and choose what it sends

**Settings → Notifications** has two switches, and the difference between them is the whole point:

| | What it is | When it fires |
|---|---|---|
| **In this tab** | The Notification API, raised by the page. | Only while a tab is open somewhere. |
| **On this device** | A push subscription, delivered by Apple, Google or Mozilla to a service worker. | With the console closed, the phone locked, the laptop asleep. |

Press **Turn on** under *On this device*, then **Send a test** — it goes out through the real push
service and back, so a notification appearing proves the whole chain rather than the last hop of it.

Do it on the laptop too. `http://127.0.0.1` counts as a secure context, so the same button works
there with no HTTPS involved, and every browser gets its own subscription and its own choices.

Each console is its own origin, so it keeps its own signing keys and its own list of subscribed
devices: turning notifications on for one project does not subscribe you to another, and one project
going quiet is a choice you make per project. Subscribe from each console you want to hear from.

**Nine categories, per device**, because a phone and a laptop rarely want the same ones:

| Category | Default | Fires when |
|---|---|---|
| **Permission needed** | on | A session is blocked on a decision only you can make. Nothing proceeds until you answer. |
| **Run halted** | on | A run stopped on something that must not be automated past — or was interrupted with nothing driving it. |
| **Run parked or waiting** | on | Every remaining phase needs a person, or the run is asleep until a usage window reopens. |
| **Usage limits** | on | An account is approaching (80/95%) or hit a usage window — the 5-hour session, the weekly allowance, a per-model one — with when it resets and what the run did about it (waited, switched account, paused). |
| **Phase finished or failed** | on | Each phase as it lands. The pulse of a run nobody is watching. |
| **Plan finished** | on | A run reached the end of its plan. |
| **Work became ready** | off | A phase became startable — including because of work you finished yourself, elsewhere. |
| **Plans changed on disk** | off | Any plan or handoff was written. A firehose: an agent editing a handoff mid-phase fires it. |
| **Console problems** | on | The console degraded or its file watch went deaf — the failure that otherwise looks exactly like everything working. |

Only *Permission needed* and *Run halted* are sent urgent, because they are the two that mean nothing
moves until you act. The rest arrive quietly. A channel that always buzzes is a channel you turn off,
and the notification it gets turned off for is the one that mattered.

Payloads are encrypted to a key only your browser holds ([RFC 8291][rfc8291]), so the push service
relays a notification about your plans without being able to read one. Nothing is installed to make
that work — the implementation is `node:crypto` and about four hundred lines.

## Step 7 · Alerts with no browser involved at all *(optional)*

Push still needs a browser somewhere, even a closed one. For a machine where that is not true — a
headless box, a pager, a chat channel — point `PHASE_CONSOLE_NOTIFY` at a script. It is run as
`your-script "<title>" "<body>"` whenever a run needs a person:

```bash
#!/bin/sh
# ~/.local/bin/phase-notify
curl -s -H "Title: $1" -d "$2" https://ntfy.sh/your-private-topic-name >/dev/null
```

```bash
chmod +x ~/.local/bin/phase-notify
export PHASE_CONSOLE_NOTIFY=~/.local/bin/phase-notify   # or bake it into the agent: install --notify
```

[ntfy](https://ntfy.sh) is the shortest path — install its app, subscribe to the topic. Pushover,
Slack or a webhook of your own work the same way.

> **This sends plan names and approval details to whatever service you choose.** Pick a topic name
> nobody will guess, and if the work is sensitive, [self-host ntfy](https://docs.ntfy.sh/install/) or
> point the script somewhere you control. The variable is environment-only on purpose — nothing
> reachable from a web page gets to choose which command runs.

## What is actually enforced

Once you name a hostname, strict `Host` checking turns on and exactly two kinds of request are
served:

| Request | Verdict |
|---|---|
| Loopback `Host`, no identity header | **Served.** You, at this machine — unchanged from before. |
| Your `--remote` hostname + an allowlisted login | **Served.** You, through the proxy. |
| Your `--remote` hostname, no identity header | **403.** Something reached the console without going through the proxy. |
| Your `--remote` hostname, a login not on the list | **403.** Someone else on your network. |
| Any other `Host` | **421.** This is what a DNS-rebinding page arrives with. |
| Loopback `Host` **carrying** an identity header | **421.** See below. |

That last row is doing real work and is worth understanding. Anyone on your private network can put
whatever they like in a `Host` header — including `127.0.0.1`. If a loopback `Host` alone meant
"local", such a request would skip the identity check entirely. It cannot: the proxy sets the
identity header on everything it forwards, so a loopback `Host` arriving *with* one is a combination
no honest client produces.

The other half of the assumption is that a caller cannot simply claim to be you. Serve **overwrites**
`Tailscale-User-Login` with the authenticated identity rather than passing through whatever the
client sent — worth knowing rather than assuming, and easy to confirm on your own setup:

```bash
# sent with a forged identity, through the proxy — served, because the proxy replaced it
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Tailscale-User-Login: mallory@example.com' https://your-machine.your-tailnet.ts.net/api/state
```

A `200` means the header you sent never reached the console. A `403` would mean it did, and that the
only thing standing between you and impersonation is the attacker not knowing which login to claim.

You can check the rest of it from the machine, without a phone:

```bash
C=http://127.0.0.1:4123
H=your-machine.your-tailnet.ts.net
curl -s -o /dev/null -w '%{http_code}\n' $C/api/state                                        # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: evil.example"  $C/api/state               # 421
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $H"            $C/api/state               # 403
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $H" -H "Tailscale-User-Login: you@example.com" $C/api/state   # 200
```

Use `curl`, not a `fetch()` in a browser console — `Host` is a forbidden header name there, so it is
dropped silently and every case will look like a pass.

## Locking it down further *(optional)*

Serve obeys your access rules like anything else on the tailnet. If more than one person or machine
is on yours, scope it. In the [access controls](https://login.tailscale.com/admin/acls):

```jsonc
{
  "grants": [
    { "src": ["autogroup:owner"], "dst": ["autogroup:self"], "ip": ["tcp:443"] }
  ]
}
```

It is also worth removing machines you no longer use. They are the only devices that could reach the
console at all.

## What not to do

- **Do not use `--host 0.0.0.0` instead of this.** It puts the console — which with `--allow-run`
  starts agent sessions that edit your repository — on every network you join, with no
  authentication whatsoever. It also breaks the approval hook: the address the child sessions call
  back on is derived from the bind address, and that hook **fails open**, so the ask-list would stop
  working *silently* and every session would run on the deny rules alone.
- **Do not use `tailscale funnel`.** Funnel is Serve's public sibling: it publishes to the entire
  internet. Everything above depends on the caller being someone your network already vouched for.
- **Do not skip HTTPS.** Plain HTTP to a hostname is not a [secure context], so notifications are
  unavailable and the Home Screen install is degraded. The tunnel is encrypted either way — this is
  about what the browser will let the page do.

## When it does not work

| Symptom | Cause |
|---|---|
| The name does not resolve on the phone | MagicDNS off in the admin console, or **"Use Tailscale DNS"** off in the phone's Tailscale app. |
| `tailscale serve` prints *"Serve is not enabled on your tailnet"* and never returns | Serve is a tailnet capability that is off until someone approves it. Open the link the command printed — it is specific to that machine — and approve it. The command is waiting for exactly that and will continue on its own; do not kill it. |
| `tailscale serve` errors about certificates | HTTPS Certificates not enabled. Step 1. |
| **403** — *"No caller identity"* | You reached the console directly rather than through Serve, or Serve is not running. Check `tailscale serve status`. |
| **403** — *"… is not allowed to use this console"* | The login is real but not in `--remote-user`. |
| **421** — *"does not answer to …"* | The hostname you opened is not the one you passed to `--remote`. They must match exactly. |
| **421** — *"arrived through a proxy but asks for a local hostname"* | Something rewrote the `Host` header to `localhost`. Serve does not; a proxy in between might. |
| The console will not start | `--remote` with no `--remote-user`. The error says so. |
| The notification button does nothing on iOS | Not installed to the Home Screen, or you are on plain HTTP. Both are required. |
| **Turn on** is missing and a banner explains why | Permission was refused for this site once. A page cannot ask twice — it has to be changed in browser settings. |
| **Send a test** says it was handed over, and nothing appears | Three separate yeses are involved — the push service, the browser, and the operating system — and only the first answers back. This is almost always the third: macOS *System Settings → Notifications → your browser*, or Windows *Settings → System → Notifications*. A Focus mode does it silently too. |
| **Send a test** says *gone* | The subscription was revoked at the browser end. Turn it off and on again; the register drops dead subscriptions by itself. |
| Push worked, then stopped after reinstalling the app | A reinstall makes a new subscription. The old row is dropped on its next failure; subscribe again from the new install. |
| Worked yesterday, dead after a reboot | `tailscale serve` was run without `--bg`. |
| Worked for weeks, then stopped | The machine's node key expired. Disable key expiry (Step 1). |
| Works on wifi, not on cellular | Tailscale toggled off on the phone, or iOS disabled its VPN profile. |

[ts-serve]: https://tailscale.com/docs/features/tailscale-serve
[secure context]: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
[rfc8291]: https://datatracker.ietf.org/doc/html/rfc8291

---

