/**
 * Appearance — how the console looks, and the one preference that changes how
 * it paints rather than how it reads.
 *
 * Everything here is stored in this BROWSER (`localStorage`), not on the
 * server: two people watching the same console from two devices should not be
 * fighting over a theme. That is the line between this section and Automation,
 * where every knob governs the server process and is read back from
 * `/api/state`.
 */

import { usePrefs, type Theme } from '@/lib/prefs';
import { useConsoleState } from '@/lib/queries';
import { Card, CardBody, CardHeader, CardTitle, ToggleGroup, ToggleItem } from '@/components/ui';
import { MODELS as FALLBACK_MODELS } from '@/features/runs/defaults';
import { SettingsSectionFrame, sectionFor } from './nav';

/**
 * The model lineup, from the server's own `offeredModels()` — the same list the
 * launch form shows, falling back to this build's copy against an older server.
 * This control used to carry a fourth hardcoded list of full ids
 * (`claude-opus-5`, …), which missed every `[1m]` variant and would have gone
 * stale the day the lineup moved; `single-source.test.ts` now refuses a fifth.
 *
 * A value already STORED is always offered, even when the current lineup does
 * not name it: dropping it would silently re-point the preference at "each
 * plan's own target" without saying so.
 */
function modelOptions(offered: readonly string[] | undefined, stored: string): string[] {
  const list = offered?.length ? [...offered] : [...FALLBACK_MODELS];
  return ['', ...list, ...(stored && !list.includes(stored) ? [stored] : [])];
}

const THEMES: [Theme, string][] = [
  ['system', 'Auto'],
  ['dark', 'Night'],
  ['light', 'Paper'],
];

const row = 'flex flex-wrap items-center justify-between gap-2';

export function AppearanceSection() {
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();
  const section = sectionFor('appearance')!;

  return (
    <SettingsSectionFrame section={section}>
      <Card>
        <CardHeader>
          <CardTitle>Theme and density</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className={row}>
            <span className="min-w-0">
              <span className="text-sm text-ink">Theme</span>
              <span className="mt-0.5 block text-2xs text-ink-muted">
                Auto follows the operating system. Every colour is declared once with{' '}
                <code>light-dark()</code>, so this is one <code>color-scheme</code> flip, not a second
                stylesheet.
              </span>
            </span>
            <ToggleGroup
              type="single"
              value={prefs.theme}
              onValueChange={(value) => value && setPrefs({ theme: value as Theme })}
              aria-label="Theme"
            >
              {THEMES.map(([value, label]) => (
                <ToggleItem key={value} value={value}>
                  {label}
                </ToggleItem>
              ))}
            </ToggleGroup>
          </div>

          <div className={row}>
            <span className="min-w-0">
              <span className="text-sm text-ink">Density</span>
              <span className="mt-0.5 block text-2xs text-ink-muted">
                Compact tightens the padding of every card and tile by about a fifth. Type sizes and tap
                targets are untouched — the 12&nbsp;px floor and the 44&nbsp;px minimum are contracts, so
                density buys its space out of padding and never out of ink.
              </span>
            </span>
            <ToggleGroup
              type="single"
              value={prefs.density}
              onValueChange={(value) => value && setPrefs({ density: value as 'comfortable' | 'compact' })}
              aria-label="Density"
            >
              <ToggleItem value="comfortable">Comfortable</ToggleItem>
              <ToggleItem value="compact">Compact</ToggleItem>
            </ToggleGroup>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lists and defaults</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className={row}>
            <span className="min-w-0">
              <span className="text-sm text-ink">Show documents in the plan list</span>
              <span className="mt-0.5 block text-2xs text-ink-muted">
                Handoff folders with no plan file, and the loose documents beside them.
              </span>
            </span>
            <ToggleGroup
              type="single"
              value={prefs.showDocuments ? 'on' : 'off'}
              onValueChange={(value) => value && setPrefs({ showDocuments: value === 'on' })}
              aria-label="Show documents in the plan list"
            >
              <ToggleItem value="on">Shown</ToggleItem>
              <ToggleItem value="off">Hidden</ToggleItem>
            </ToggleGroup>
          </div>

          <div className={row}>
            <label htmlFor="session-model" className="min-w-0 text-sm text-ink">
              Session plan model
              <span id="session-model-hint" className="mt-0.5 block text-2xs font-normal text-ink-muted">
                Which model the session batches on the board are sized for. Empty means each plan&rsquo;s own
                target.
              </span>
            </label>
            <select
              id="session-model"
              aria-describedby="session-model-hint"
              value={prefs.model}
              onChange={(event) => setPrefs({ model: event.target.value })}
              className="min-h-(--tap-min) w-full max-w-64 min-w-0 rounded border border-rule bg-ground px-2 text-sm text-ink"
            >
              {modelOptions(state?.models, prefs.model).map((model) => (
                <option key={model} value={model}>
                  {model || "each plan's own target"}
                </option>
              ))}
            </select>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Terminal</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className={row}>
            <span className="min-w-0">
              <span className="text-sm text-ink">WebGL renderer</span>
              <span className="mt-0.5 block text-2xs text-ink-muted">
                Off by default: the addon painted nothing under headless Chrome at a device pixel ratio of 2
                or more, and a terminal that renders blank is worse than one that renders slowly. On a real
                retina device it is the faster path — turn it on, open a session, and turn it back off if the
                pane goes empty.
              </span>
            </span>
            <ToggleGroup
              type="single"
              value={prefs.terminalWebgl ? 'on' : 'off'}
              onValueChange={(value) => value && setPrefs({ terminalWebgl: value === 'on' })}
              aria-label="Terminal WebGL renderer"
            >
              <ToggleItem value="on">On</ToggleItem>
              <ToggleItem value="off">Off</ToggleItem>
            </ToggleGroup>
          </div>
          <p className="text-2xs text-ink-faint">
            The font size is on the session itself — the stepper beside the key bar — because it is the one
            terminal setting you change while reading one.
          </p>
        </CardBody>
      </Card>
    </SettingsSectionFrame>
  );
}
