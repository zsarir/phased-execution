## Reaching the console from a phone

An unattended run exists so you can stop watching it. That only pays off if it can still reach you —
a run that halts on an approval waits until somebody answers, and if the console is only reachable
from the chair in front of it, every pause lasts until you sit back down.

This takes about ten minutes, and most of it is clicking switches. Nothing here puts anything on the
public internet.

### The shape of it

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

> **⚠️ Never use `--host 0.0.0.0`.** The identity header is the whole authentication story, and it
> is only worth anything *because* the console stays on loopback. If it listened on a network
> interface, anyone who could reach it could simply send the header themselves. `--remote`
> deliberately does not widen the bind, and Tailscale's own guidance says the same: have the service
> listen on localhost only.

You need a [Tailscale](https://tailscale.com) account. The free tier covers this comfortably.

### Step 1 · Turn on three things for your tailnet

All three are off by default and all three are needed. The first two are on the DNS page of the
Tailscale admin console.

1. **Enable MagicDNS** — what makes `your-machine.your-tailnet.ts.net` resolve for your own devices.
   Without it you would be typing an IP address, and an IP address cannot have a certificate.
2. **Enable HTTPS Certificates** — Tailscale then provisions a real, publicly-trusted certificate
   for that name. HTTPS *requires* MagicDNS, so do them in this order.
3. **Enable Serve** — this one has no switch to find in advance. The first time you run
   `tailscale serve` on a tailnet that has never used it, the command prints an approval link and
   then **waits** rather than exiting. Open the link, approve it, and the command continues on its
   own.

> **Know what you are agreeing to.** Every certificate on the web is recorded in the public
> Certificate Transparency log, so enabling this publishes your machine's *name*. The machine itself
> does not become reachable: nothing here opens a port.

While you are in the admin console, on the Machines page, **disable key expiry** for this machine.
Node keys expire by default, and when one does, remote access stops with no warning and no obvious
cause.

### Step 2 · Put your phone on the same tailnet

Install the Tailscale app, sign in with the same account, and — easy to miss — make sure **"Use
Tailscale DNS" is ON** in the app's settings. It is what lets the phone resolve the `.ts.net` name.
Without it the name simply will not load.

Check `tailscale status` on your machine; the phone should be listed.

### Step 3 · Tell the console who may arrive

```bash
./start --root ~/code/your-repo --allow-writes --allow-run --allow-agent \
        --remote your-machine.your-tailnet.ts.net \
        --remote-user you@example.com
```

(`--allow-agent` is optional — it is what makes the **Agent** page and the *New plan with AI*
wizard work from the phone; leave it off if you only want the boards.)

| Flag | Meaning |
|---|---|
| `--remote <host>` | The console also answers to this hostname, fronted by an authenticating proxy. Repeatable. Turns on strict `Host` checking. |
| `--remote-user <login>` | A login allowed to arrive that way. Repeatable, or `PHASE_CONSOLE_REMOTE_USERS` as a comma-separated list. **Required** by `--remote`. |

Use your real MagicDNS name — `tailscale status --json` prints it as `Self.DNSName` — and the login
you signed in with.

`--remote` without `--remote-user` **refuses to start**. Starting with no allowlist would look
completely correct and quietly admit everyone on your network, so it is an error rather than a
warning.

To survive reboots, install it as a background agent (launchd on macOS, a systemd user service on
Linux) with the same flags:

```bash
./start --install-agent --root ~/code/your-repo --allow-writes --allow-run --allow-agent \
        --remote your-machine.your-tailnet.ts.net --remote-user you@example.com
./start --agent-status
```

(The *agent* here is the background **process supervisor** — nothing to do with the
console's Agent page; the flag for that is `--allow-agent`.)

### Step 4 · Put the proxy in front of it

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4123
tailscale serve status
```

**`--bg` is not optional if you want this to last.** With it, Serve is persistent: it comes back
after a reboot and after `tailscale down` / `tailscale up`. Without it, Serve lives only as long as
that foreground command.

To undo it: `tailscale serve --https=443 http://127.0.0.1:4123 off`, or `tailscale serve reset`.

Now open `https://your-machine.your-tailnet.ts.net/` on the phone. Padlock, no warning, no port
number.

### Step 5 · Install it on the Home Screen

In Safari: **Share → Add to Home Screen**.

This is not decoration. On iOS, **web notifications only exist for a site installed to the Home
Screen** — in an ordinary Safari tab the permission cannot even be requested. Since the notification
is the entire point of being reachable, the install is part of the setup rather than a nicety.

Android needs none of this — notifications work in a normal HTTPS tab — but installing it still
gives you a cleaner window.

### Step 6 · Turn on push, and choose what it sends

**Notifications → Devices** has two switches, and the difference between them is the whole point:

| | What it is | When it fires |
|---|---|---|
| **In this tab** | The Notification API, raised by the page. | Only while a tab is open somewhere. |
| **On this device** | A push subscription, delivered by Apple, Google or Mozilla to a service worker. | With the console closed, the phone locked, the laptop asleep. |

Press **Turn on** under *On this device*, then **Send a test** — it goes out through the real push
service and back, so a notification appearing proves the whole chain rather than the last hop of it.

Do it on the laptop too. `http://127.0.0.1` counts as a secure context, so the same button works
there with no HTTPS involved, and every browser gets its own subscription and its own choices.

**If you run a console per project**, each is its own origin with its own signing keys and its own
list of subscribed devices. Subscribe from each one you want to hear from — and to reach more than
one from the phone, serve each on its own HTTPS port and install each as its own Home Screen app.

Permission is never demanded on load: a page that asks the moment it opens gets refused by reflex,
and that refusal is permanent.

**Categories are per device**, because a phone and a laptop rarely want the same ones. Only
*Permission needed* and *Run halted* are sent urgent, because they are the two that mean nothing
moves until you act. A channel that always buzzes is a channel you turn off, and the notification it
gets turned off for is the one that mattered.

Payloads are encrypted to a key only your browser holds (RFC 8291), so the push service relays a
notification about your plans without being able to read one.

### Step 7 · Alerts with no browser involved *(optional)*

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
export PHASE_CONSOLE_NOTIFY=~/.local/bin/phase-notify
```

Under the background agent it has to be baked into the plist / unit, not exported in your shell:
`deploy/agent.sh install --notify '<command>'`.

> **This sends plan names and approval details to whatever service you choose.** Pick a topic name
> nobody will guess, and if the work is sensitive, self-host or point the script somewhere you
> control. The variable is environment-only on purpose — nothing reachable from a web page gets to
> choose which command runs.

### What is actually enforced

Once you name a hostname, strict `Host` checking turns on and exactly two kinds of request are
served:

| Request | Verdict |
|---|---|
| Loopback `Host`, no identity header | **Served.** You, at this machine — unchanged from before. |
| Your `--remote` hostname + an allowlisted login | **Served.** You, through the proxy. |
| Your `--remote` hostname, no identity header | **403.** Something reached the console without going through the proxy. |
| Your `--remote` hostname, a login not on the list | **403.** Someone else on your network. |
| Any other `Host` | **421.** This is what a DNS-rebinding page arrives with. |
