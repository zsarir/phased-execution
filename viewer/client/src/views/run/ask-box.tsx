/**
 * Talking to a session that is already running.
 *
 * A phase used to be a process you could watch and not speak to: the only way to
 * ask it anything was to stop it, which throws the session away. Its stdin is
 * held open now, so a message is one more turn in the same conversation — the
 * context is intact, the cache is warm, and the phase carries on after.
 *
 * Two modes, because they are genuinely different acts. **Ask** is framed to be
 * inert: it says out loud that it is not a change to the phase, which is what
 * stops "why did you skip the cache?" being read as an instruction to go back and
 * do it. That framing makes it useless for the case people reached for it anyway
 * — watching a phase head somewhere wrong and wanting to say so — so **Steer** is
 * the honest version of that, framed as an instruction and journaled under its
 * own name.
 *
 * The `/btw` prefix is optional and stripped if typed. It is there because it is
 * what people reach for, not because anything needs it.
 */

import { useRef, useState } from 'react';
import { Button, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

export function AskBox({
  slug,
  enabled,
  allowRun,
  phase,
}: {
  slug: string;
  enabled: boolean;
  allowRun: boolean;
  phase?: number | null;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'ask' | 'steer'>('ask');
  const [sending, setSending] = useState(false);
  // A ref, not the `sending` state, and this is the whole point: a click and a
  // keydown firing in the same tick both read the state captured at the last
  // render — `false` for both — so the guard passed twice and the question went
  // to the model twice. A ref is written and read in the same tick, so the
  // second caller sees the first.
  const inFlight = useRef(false);

  const steering = mode === 'steer';

  const send = async () => {
    const body = text.replace(/^\/(btw|steer)\s*/i, '').trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    // Belt to the ref's braces: the key survives a retry the browser makes on
    // its own, which no amount of client-side guarding can see.
    const key = `${mode}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const sent = steering ? await api.runSteer(slug, body, key) : await api.runAsk(slug, body, key);
      setText('');
      // Nothing is pushed into the console here. The server emits the line the
      // instant it writes to stdin, and the CLI's echo folds into that same line
      // as a delivery tick — an optimistic third copy is what made one `/btw`
      // appear three times.
      if (sent?.repeated) toast('Already sent — this one was a duplicate', 'ok');
    } catch (error) {
      // The server distinguishes "nothing is listening" (409) from "bad request",
      // so the message is worth showing verbatim rather than flattening to failed.
      toast((error as Error).message, 'warn');
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <div className={cn('border-t border-rule px-3 py-2', steering && 'bg-action/6')}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`ask-mode-${slug}`}>
          What this message is
        </label>
        <select
          id={`ask-mode-${slug}`}
          value={mode}
          disabled={!enabled || sending}
          title={
            steering
              ? 'An instruction the phase should act on'
              : 'A question that must not change what the phase is doing'
          }
          onChange={(e) => setMode(e.target.value as 'ask' | 'steer')}
          className="h-8 [@media(hover:none)]:min-h-(--tap-min) shrink-0 rounded border border-rule bg-ground px-2 text-xs disabled:opacity-50"
        >
          <option value="ask">Ask</option>
          <option value="steer">Steer</option>
        </select>

        <label className="sr-only" htmlFor={`ask-text-${slug}`}>
          {steering ? 'What to do differently' : 'A question for the session'}
        </label>
        <input
          id={`ask-text-${slug}`}
          value={text}
          disabled={!enabled || sending}
          placeholder={
            enabled
              ? steering
                ? `tell the session running phase ${phase} to do something differently…`
                : `/btw ask the session running phase ${phase}…`
              : allowRun
                ? 'Nothing is running to ask'
                : 'Asking needs --allow-run'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
          className="h-8 [@media(hover:none)]:min-h-(--tap-min) min-w-0 flex-1 rounded border border-rule bg-ground px-2 text-xs disabled:opacity-50"
        />
        <Button size="sm" disabled={!enabled || sending || !text.trim()} onClick={() => void send()}>
          {sending ? 'Sending…' : steering ? 'Steer' : 'Ask'}
        </Button>
      </div>
      <p className="mt-1.5 text-2xs text-ink-faint">
        {!enabled
          ? 'Available while a phase is running'
          : steering
            ? "Folded into the work — the plan's verification still decides if the phase passes"
            : 'Answered in the same session, then it carries on'}
      </p>
    </div>
  );
}
