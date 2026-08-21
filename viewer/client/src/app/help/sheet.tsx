/**
 * The help sheet — the guide, over whatever page you are on.
 *
 * The 2.x guide was a destination (`#/guide/:section`), which meant reading how
 * a thing works cost leaving the thing. It is an overlay now: `?help=<section>`
 * on any route, with `&card=` still addressing one card inside it. Every old
 * `#/guide/…` URL redirects here with both halves of its address intact, so the
 * phone-setup instructions people were told to open still open exactly what they
 * always did.
 *
 * What did NOT change is the content model, and that is deliberate: sections are
 * still `client/src/content/guide/*.md`, still cut into cards at their headings
 * by `split.ts`, still rendered through the same sanitizer every other surface
 * uses. The guide is text a person can edit, not markup a component owns, and
 * nothing in this directory knows a heading by name.
 *
 * Two things the move fixed on the way. The section strip used to be scrolled
 * with `scrollIntoView` — the call the app bans, because it scrolls every
 * ancestor including the shell; the sections simply wrap now, which a 28rem
 * drawer has the room for. And `GUIDE_SECTIONS` stays the frozen vocabulary in
 * `shared/route-meta.js`: a section added to one and forgotten in the other is
 * still a test failure rather than an empty tab.
 */

import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { useConsoleState } from '@/lib/queries';
import { Sheet, SheetContent } from '@/components/ui';
import { useNavigate } from '@/app/router';
import { OVERLAY_KEYS, closeOverlaysHref, helpHref, type Route } from '@/app/routes';
import { SECTIONS, resolveSection } from './sections';
import { SectionPanel } from './section';

export function HelpSheet({ route }: { route: Route }) {
  const navigate = useNavigate();
  const phone = usePhone();
  const asked = route.query[OVERLAY_KEYS.help];
  const open = asked != null;
  // `?help=` with no value is how `#/guide` (and the More sheet) ask for "the
  // guide" without naming a section; `resolveSection` answers with the first.
  const section = resolveSection(asked || undefined);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) navigate(closeOverlaysHref(route));
      }}
    >
      {/* `showTitle`: the sheet's own header names it and carries the close
          button, so a second heading inside would say "Help" twice. */}
      <SheetContent side={phone ? 'bottom' : 'right'} title="Help" showTitle className="p-0">
        {open && (
          <div className="flex flex-col gap-4 p-4">
            <ConsolePosture />

            <nav aria-label="Guide sections" className="flex flex-wrap gap-1.5">
              {SECTIONS.map((s) => {
                const active = s.id === section.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => navigate(helpHref(s.id, undefined, route))}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-2xs transition-colors duration-fast ease-transit',
                      '[@media(hover:none)]:min-h-(--tap-min)',
                      active
                        ? 'border-action bg-action/15 text-ink'
                        : 'border-rule text-ink-muted hover:border-rule-strong hover:text-ink',
                    )}
                  >
                    {s.label}
                  </button>
                );
              })}
            </nav>

            <SectionPanel section={section} card={route.query.card} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * What this console can actually do, said before the guide describes what a
 * console can do in general. Reading "start a run" on a console that cannot is
 * the fastest way to conclude the software is broken.
 */
export function ConsolePosture() {
  const { data: state } = useConsoleState();
  if (!state) return null;
  const on = state.autopilot === true && state.allowRun === true;
  const text =
    state.autopilot === false
      ? 'This console predates the autopilot. Restart it to pick up the run endpoints.'
      : state.allowRun
        ? 'Runs are enabled on this console.'
        : 'This console can show runs but not start them — it was started without --allow-run.';

  return (
    <p className="flex items-center gap-2 text-sm text-ink-muted">
      <span
        aria-hidden
        className={cn('size-2 shrink-0 rounded-full', on ? 'bg-status-done' : 'bg-ink-faint/50')}
      />
      {text}
    </p>
  );
}
