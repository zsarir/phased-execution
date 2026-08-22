/**
 * General — the directory this console reads, the engine behind every status,
 * and the three keys.
 *
 * These three cards were spread across the 2.x page (Source at the top, Engine
 * in the middle, Keyboard at the bottom) and they are one answer: *what is this
 * console actually looking at, and what is answering my questions about it*.
 * The Source card is a summary with a link, not an editor — picking a directory
 * is a chromeless full-screen act (`#/source`) because it replaces everything
 * else on the screen with its consequences.
 */

import { navigate } from '@/app/router';
import { useConsoleState } from '@/lib/queries';
import { weight } from '@/lib/format';
import { Button, Card, CardBody, CardHeader, CardTitle, KeyValue, Skeleton } from '@/components/ui';
import { SettingsSectionFrame, sectionFor } from './nav';

export function GeneralSection() {
  const { data: state } = useConsoleState();
  const section = sectionFor('general')!;

  if (!state) {
    return (
      <SettingsSectionFrame section={section}>
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </SettingsSectionFrame>
    );
  }

  const repo = state.repo;
  const dirty = repo?.dirty ?? [];

  return (
    <SettingsSectionFrame section={section}>
      <Card>
        <CardHeader>
          <CardTitle>Source</CardTitle>
          <Button size="sm" onClick={() => navigate('source')}>
            Change
          </Button>
        </CardHeader>
        <CardBody>
          <KeyValue
            items={[
              ['Directory', <code key="d">{state.root?.path}</code>],
              ['Plans', `${state.root?.planCount ?? 0} files in docs/plans`],
              ['Handoff folders', String(state.root?.handoffCount ?? 0)],
              [
                'Repository',
                repo?.available
                  ? `${repo.branch}${repo.ahead ? ` · ${repo.ahead} ahead` : ''}${repo.behind ? ` · ${repo.behind} behind` : ''}`
                  : 'not a git repository',
              ],
              [
                'Uncommitted under docs/',
                dirty.length ? (
                  <span key="u" className="font-mono text-2xs break-words">
                    {dirty.slice(0, 6).join(', ')}
                    {dirty.length > 6 ? ` +${dirty.length - 6}` : ''}
                  </span>
                ) : (
                  'none'
                ),
              ],
              ['Indexed sections', String(state.searchDocs ?? 0)],
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Engine</CardTitle>
        </CardHeader>
        <CardBody>
          <KeyValue
            items={[
              ['Scripts', <code key="s">{state.scriptsDir}</code>],
              [
                'Writes',
                state.allowWrites ? (
                  'enabled — scaffolds, QA records and locks'
                ) : (
                  <span key="w">
                    read-only · restart with <code>--allow-writes</code>
                  </span>
                ),
              ],
              [
                'Phase weights',
                `S ${weight(state.sizing?.S)} · M ${weight(state.sizing?.M)} · L ${weight(state.sizing?.L)}`,
              ],
              [
                'Session budgets',
                `1M-class ${weight(state.sizing?.budgetBig)} · 200K-class ${weight(state.sizing?.budgetHaiku)}`,
              ],
            ]}
          />
          <p className="mt-3 text-2xs text-ink-faint">
            Status, session batches, boot prompts and lint always come from these scripts. The console parses
            the markdown only for the parts they do not expose.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keyboard</CardTitle>
        </CardHeader>
        <CardBody>
          {/* Three keys, not eight. The 2.x list was seven single-letter jumps
              that had to be memorised from a card you had to remember to
              visit; the palette replaced all of them with one chord that shows
              you its own contents — and prints the chord on itself, in the
              header, on every page. What is left here is what the palette
              cannot document from inside itself. */}
          <KeyValue
            items={[
              ['⌘ K', 'search and commands'],
              ['/', 'the same, without a modifier'],
              ['Esc', 'close a dialog, sheet or the palette'],
            ]}
          />
        </CardBody>
      </Card>
    </SettingsSectionFrame>
  );
}
