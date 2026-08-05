<div align="center">

# 🪜 phased-execution

**یک اسکیلِ [Claude Code](https://claude.com/claude-code) برای اجرای کارهایی که در یک نشست جا نمی‌شوند —
به‌شکلِ یک گرافِ وابستگی از نشست‌های هم‌اندازه، به‌همراهِ یک کنسولِ وبِ محلی برای تماشای آن.**

[![CI](https://github.com/zsarir/phased-execution/actions/workflows/ci.yml/badge.svg)](https://github.com/zsarir/phased-execution/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/phase-console?style=flat-square&color=CB3837)](https://www.npmjs.com/package/phase-console) ![Skill](https://img.shields.io/badge/Claude%20Code-Agent%20Skill-d97757?style=flat-square) ![Platforms](https://img.shields.io/badge/platforms-macOS%20·%20Linux%20·%20WSL2-3fb68b?style=flat-square) ![Dependencies](https://img.shields.io/badge/runtime%20dependencies-none-3fb68b?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-7A8B92?style=flat-square)

[English](README.md) · **فارسی**

</div>

```
Phase graph — checkout-rewrite   (3/7 done)

  ✅  1  done         Schema + migrations · QA:verified
  ✅  2  done         Pricing service · QA:verified
  ✅  3  done         Payment adapter · QA:verified
  🔓  4  ready        Cart API
  🔓  5  ready        Refund worker
  ⏳  6  waiting      Checkout UI
  ⏳  7  waiting      Ship (GATED) 🔒GATED needs: 6

READY NOW:   4 5
WAITING:     6(←4), 7(←6)
SUGGESTED BATCHES (budget ~200K, joined phases share a session): [4 5]  [6]  [7]
```

<div dir="rtl">

کارِ بزرگ به فازهایی با وابستگیِ اعلام‌شده تبدیل می‌شود. هر فاز در نشستِ هم‌اندازهٔ خودش اجرا می‌شود،
خودش را تأیید می‌کند، و یک handoff می‌نویسد که نشستِ بعدی از صفر با آن بالا می‌آید.

*آن تخته، خودِ محصول است. هیچ‌چیز در این سیستم «الان کدام فازم؟» را ذخیره نمی‌کند — هر بار از جدولِ
وابستگیِ نقشه و فایل‌های handoff روی دیسک محاسبه می‌شود. برای همین کارِ خارج از ترتیب و از‌سرگرفته‌شده
درست می‌ماند.*

---

## نصب

| می‌خواهید | اجرا کنید | توضیح |
|---|---|---|
| کنسول، آمادهٔ استفاده | <span dir="ltr">`npm install -g phase-console`</span> | کلاینت از پیش build شده — مرحلهٔ build ندارد؛ فایل‌های اسکیل هم داخلش هست |
| … با Homebrew | <span dir="ltr">`brew install zsarir/homebrew-tap/phase-console`</span> | macOS **و** لینوکس؛ روی Node خودِ brew |
| … بدون نصب | <span dir="ltr">`npx phase-console ~/code/your-repo`</span> | یک‌باره، همیشه آخرین نسخه |
| **اسکیل** در Claude Code | <span dir="ltr">`/plugin marketplace add zsarir/phased-execution`</span> و سپس <span dir="ltr">`/plugin install phased-execution@mobin`</span> | با هر کامیت خودش به‌روز می‌شود؛ کنارش npm/brew بگذارید یا کنسولش را یک‌بار build کنید |
| یک درختِ قابل‌ویرایش | <span dir="ltr">`git clone https://github.com/zsarir/phased-execution ~/.claude/skills/phased-execution`</span> | اسکیل + کنسول از یک پوشه زیر کنترل خودتان |

بعد کنسول را به مخزنی بدهید که `docs/plans` دارد (یا باید داشته باشد):

</div>

```bash
phase-console ~/code/your-repo        # run it, right here
phase-console install-skill           # copy the skill where Claude Code reads it
phase-console start | stop | restart | status | logs   # drive the background agent
```

<div dir="rtl">

روی **macOS** و **لینوکس** کار می‌کند، و روی **ویندوز داخل WSL2** — مسیرها، به‌روزرسانی، حذف و
نکته‌های هر پلتفرم در **[docs/install.md](docs/install.md)** (انگلیسی).

### اجرای هم‌زمانِ چند پروژه

یک نصب، برای هر پروژه یک کنسول. داخل مخزن بروید و اجرایش کنید — بقیه همچنان بالا می‌مانند.
(زنجیرهٔ اولویت، چیدمان وضعیت و موبایل: **[docs/console.md](docs/console.md)** — انگلیسی.)

</div>

```bash
cd ~/code/alpha && phase-console start   # http://127.0.0.1:4123
cd ~/code/beta  && phase-console start   # a second console, its own port
phase-console list                       # NAME · ROOT · PORT · STATUS · UNIT
phase-console open beta                  # by name, from anywhere
phase-console stop beta                  # every verb takes the same selector
```

<div dir="rtl">

هر فرمان `[<name>]` یا `--instance <sel>` یا `--root <dir>` می‌گیرد؛ اگر هیچ‌کدام را ندهید یعنی
کنسولِ همان پوشه‌ای که در آن ایستاده‌اید، و `phase-console status` به‌تنهایی همه را گزارش می‌کند. هر
کنسول به یک **ریشهٔ** مخزن تعلق دارد و هویتش از همان مسیر می‌آید، پس یک پروژه همیشه همان کنسول است —
در ری‌استارت و ریبوت، بدون اینکه چیزی جایی نوشته شود.

- **پورت‌ها.** اولین کنسولِ هر ماشین **۴۱۲۳** را نگه می‌دارد؛ هر پروژهٔ دیگر پورتی پایدار در بازهٔ
  **۴۱۲۴ تا ۴۲۲۳** می‌گیرد و اگر آن یکی گرفته باشد، اولین پورت آزاد بعدی. شروع روی پورتی که مالِ
  پروژهٔ دیگری است، *با نام بردن از آن پروژه* رد می‌شود.
- **اسم بگذارید.** فایل `{"name": "alpha", "port": 4150}` را با نام `.phase-console.json` در ریشهٔ
  مخزن کامیت کنید تا برای هرکسی که کلون می‌کند تعیین شده باشد. هر دو کلید اختیاری‌اند.
- **چه چیزی جداست.** لاگ‌ها، اعلان‌ها، دستگاه‌های push و تنظیمات برای هر کنسول جداست. اولین کنسول
  همان مسیرها، پورت و نام سرویسِ همیشگی‌اش را نگه می‌دارد — ماشینِ تک‌پروژه هیچ فایل تازه‌ای نمی‌گیرد و
  با ارتقا چیزی جابه‌جا نمی‌شود.
- **در زمان ورود به سیستم:** `phase-console --install-agent --root ~/code/beta` به آن پروژه سرویس
  launchd/systemd خودش را می‌دهد و به کنسولی که از قبل نصب کرده‌اید دست نمی‌زند. برای برگرداندن:
  `agent.sh uninstall beta` (ثبت‌شده می‌ماند، بی‌سرپرست)؛ و `instances.mjs remove <id>` کاملاً
  فراموشش می‌کند.

### یا بسپاریدش به Claude Code

این را در Claude Code بچسبانید. پیش از هر قدم می‌پرسد و خودش هیچ چیزی را روشن نمی‌کند.

</div>

```
Install the phased-execution skill for me, and ask before each step.

1. Install the skill itself, whichever way I prefer — offer all of these:
     Plugin:  claude plugin marketplace add zsarir/phased-execution
              claude plugin install phased-execution@mobin
     Clone:   git clone https://github.com/zsarir/phased-execution \
                ~/.claude/skills/phased-execution
     npm:     npm install -g phase-console     (console prebuilt, skill files inside)
     Brew:    brew install zsarir/homebrew-tap/phase-console
   Claude Code discovers the SKILL from the plugin or the clone; npm and brew
   install the console — after one of those, phase-console install-skill puts
   the skill where Claude Code reads it. If I already have it, update it the
   same way instead and tell me what changed.
2. Ask which repository holds my work. The console reads plans from
   <repo>/docs/plans and handoffs from <repo>/docs/handoffs; it will not start
   without docs/plans, so create it if I say to.
3. Ask whether I want the web console at all. The skill works without it — it is
   scripts and markdown. npm and brew ship it prebuilt; for a plugin or clone:
     cd <skill>/viewer && npm ci && npm run build
4. Before enabling anything, explain these one at a time and let me answer each:
     --allow-writes   scaffold plans and handoffs, record QA, take phase locks,
                      close and reopen plans
     --allow-run      spawn unattended Claude sessions that edit my repository
                      for hours — the widest of the four, say so plainly
     --allow-terminal a real shell in the browser, running as me
     --allow-agent    interactive claude sessions and the New-plan wizard
   Default every one of them to off. Then install with only what I chose:
     bash <skill>/viewer/deploy/agent.sh install --root <repo> [flags]
   (from npm or brew: phase-console --install-agent --root <repo> [flags])
   That installs a login agent (launchd on macOS, systemd on Linux) that
   starts at login and survives a crash.
5. Open http://127.0.0.1:4123 and confirm it loads. If it does not, read
   ~/.local/state/phase-console/console.err.log and tell me what it says.
6. Finish by listing what you enabled, what you left off, and how to change it.

Do not turn on a flag I did not agree to, and do not start a phase run to
"test" it — a run edits my repository.
```

<div dir="rtl">

---

## دسترسی از گوشی

اختیاری، و فقط وقتی می‌ارزد که کنسول بالا آمده باشد. کنسول را روی tailnet خودتان با HTTPS منتشر
می‌کند — خودِ سرور هرگز از loopback بیرون نمی‌رود.

</div>

```
Make my Phase Console reachable from my phone over Tailscale.

1. Check the ground first and stop if any of it is missing:
     tailscale status            is it installed, and signed in?
     tailscale status --json     read MagicDNSSuffix, CurrentTailnet.MagicDNSEnabled,
                                 Self.DNSName and User for my login
   If MagicDNS is off, or HTTPS certificates are not enabled for the tailnet,
   tell me to turn both on in the Tailscale admin console (DNS → MagicDNS, and
   DNS → HTTPS Certificates) — they are tailnet-wide settings you cannot set
   from here — then wait for me.
2. Publish the console on the tailnet, on 443, still bound to loopback:
     tailscale serve --bg --https=443 http://127.0.0.1:4123
   Use my real port if it is not 4123. Confirm with: tailscale serve status
3. Re-install the console agent so it answers to that hostname, keeping every
   flag it already has — read them from the current plist / unit, never guess:
     bash <skill>/viewer/deploy/agent.sh install --root <repo> [existing flags] \
       --remote <Self.DNSName without the trailing dot> \
       --remote-user <my login>
   Without --remote the console refuses proxied requests with a 421, so the URL
   would resolve and then fail. With it, the console still listens only on
   loopback: Tailscale terminates TLS, proves who is calling, and forwards.
4. Print the https URL and confirm it answers from this machine.
5. Then tell me what to do on each device I want to use:
     - install Tailscale and sign into the SAME tailnet
     - turn on MagicDNS / "Use Tailscale DNS"
     - open the URL
     - on iOS, add it to the Home Screen — notifications only work from there
   Only devices on my tailnet, signed in as an allowed user, can reach it.

Never widen --host to expose the console on a network interface. The identity
header is trustworthy only because nothing but the proxy can reach the port.
```

<div dir="rtl">

نسخهٔ کامل، شاملِ نوتیفیکیشن‌ها و اینکه دقیقاً چه چیزی اعمال می‌شود →
**[docs/phone.md](docs/phone.md)** (انگلیسی)

---

## بقیهٔ مستندات

**[📖 مستنداتِ کامل →](docs/README.md)** — همه به انگلیسی:

[نمای کلی](docs/overview.md) · [اولین نقشه](docs/first-plan.md) · [حلقه](docs/loop.md) ·
[آرتیفکت‌ها](docs/artifacts.md) · [کنترل‌ها](docs/controls.md) ·
[بودجهٔ نشست](docs/session-budget.md) · [انتخاب مدل](docs/model-handling.md) ·
[گیتِ QA](docs/qa-gating.md) · [حفاظ‌های ایمنی](docs/safety-rails.md) ·
[Phase Console](docs/console.md) · [نصبِ دستی](docs/install.md) ·
[نسخه‌بندی و انتشار](docs/releasing.md) · [مرجع](docs/reference.md)

به Claude Code و `bash` و `git` نیاز دارد. کنسول علاوه بر آن Node ‏22.18+ (یا ‏23.6+) می‌خواهد و
**هیچ وابستگیِ اجرایی** ندارد. انتشارها با تگِ `vX.Y.Z` و از راه CI با provenance منتشر می‌شوند —
[CHANGELOG](CHANGELOG.md). مجوز MIT — [LICENSE](LICENSE).

</div>
