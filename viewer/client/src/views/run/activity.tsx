/**
 * The three things a `claude -p` process does that a scrolling log cannot show.
 *
 * A transcript answers "what has it said". These answer "what is it doing" —
 * which is a question about *state*, and state read off a log is the reader doing
 * the folding in their head: scrolling back for the last task write, remembering
 * which `Bash` never came back, unpicking two subagents' sentences from one
 * interleaved paragraph.
 *
 * All three are derived from the same events the console renders, by
 * `shared/console-model.js`, so they replay after a reload for the same reason it
 * does — and a finished run shows the task list it ended on rather than an empty
 * box.
 */

import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import { toolTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Activity } from './console-model';

/** Tool calls worth showing at once; the rest are in the console. */
const TOOLS_SHOWN = 24;

const TODO_TONE: Record<string, string> = {
  completed: 'text-done',
  in_progress: 'text-progress',
};

export function ActivityPanels({ activity, live }: { activity: Activity; live: boolean }) {
  const { todos, tools, agents } = activity;
  if (!todos.length && !tools.length && !agents.length) return null;

  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const recent = tools.slice(-TOOLS_SHOWN).reverse();
  const running = tools.filter((t) => t.ok === null).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>What it is doing</CardTitle>
      </CardHeader>
      <CardBody className="grid gap-4 lg:grid-cols-2">
        {todos.length > 0 && (
          <section className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-display text-sm">Task list</h3>
              <span className="font-mono text-2xs text-ink-faint tabular-nums">
                {doneCount}/{todos.length}
              </span>
            </div>
            <ol className="mt-1.5 flex flex-col gap-0.5">
              {todos.map((todo, i) => (
                <li key={todo.id ?? todo.key ?? i} className="flex items-baseline gap-2 text-2xs">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1 size-1.5 shrink-0 rounded-full bg-current',
                      TODO_TONE[todo.status] ?? 'text-ink-faint',
                    )}
                  />
                  <span className={cn('min-w-0', todo.status === 'completed' && 'text-ink-faint line-through')}>
                    {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-1.5 text-2xs text-ink-faint">
              The session's own list, as it last wrote it — not the plan's phases.
            </p>
          </section>
        )}

        {tools.length > 0 && (
          <section className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-display text-sm">Tool activity</h3>
              <span className="font-mono text-2xs text-ink-faint tabular-nums">
                {tools.length}
                {tools.length === TOOLS_SHOWN ? '+' : ''}
                {running ? ` · ${running} running` : ''}
              </span>
            </div>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {recent.map((tool, i) => (
                <li
                  key={tool.id ?? `${tool.name}-${i}`}
                  className={cn(
                    'flex items-baseline gap-2 text-2xs',
                    tool.ok === false && 'text-blocked',
                    tool.ok === null && 'text-progress',
                  )}
                >
                  <span className="shrink-0 font-mono">
                    {tool.name}
                    {tool.agent && <span className="text-ink-faint"> {tool.agent}</span>}
                  </span>
                  {tool.summary && (
                    <code className="min-w-0 truncate font-mono text-ink-faint">{tool.summary}</code>
                  )}
                  <span
                    className="ml-auto shrink-0 font-mono tabular-nums"
                    title={tool.ok === false ? tool.detail || 'the call failed' : undefined}
                  >
                    {/* No result yet means it is still going, and on an
                        unattended run that is the interesting state — a `Bash`
                        six minutes in reads identically to one that finished,
                        without this. */}
                    {tool.ok === null
                      ? (live ? '…' : '—')
                      : tool.ms == null
                        ? (tool.ok ? 'ok' : 'failed')
                        : `${tool.ok ? '' : '✗ '}${toolTime(tool.ms)}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {agents.length > 0 && (
          <section className="min-w-0 lg:col-span-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-display text-sm">Subagents</h3>
              <span className="font-mono text-2xs text-ink-faint tabular-nums">
                {agents.filter((a) => !a.done).length} running · {agents.length} total
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-2">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className={cn(
                    'border-l-2 pl-2',
                    agent.done ? 'border-rule text-ink-faint' : 'border-progress',
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <strong className="text-2xs">{agent.agent || 'agent'}</strong>
                    <span className="text-2xs text-ink-faint">
                      {agent.done ? 'finished' : 'working'}
                    </span>
                  </div>
                  {agent.title && <div className="text-2xs text-ink-faint">{agent.title}</div>}
                  {agent.text && (
                    <p className="mt-0.5 max-h-32 overflow-y-auto text-2xs whitespace-pre-wrap text-ink-muted">
                      {agent.text.slice(-600)}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1.5 max-w-prose text-2xs text-ink-faint">
              One lane per delegated agent, matched to the <code className="font-mono">Agent</code>{' '}
              call that started it. Unnamed when that call did not say which agent — the field is
              optional. Their words used to arrive as one voice and read as neither.
            </p>
          </section>
        )}
      </CardBody>
    </Card>
  );
}
