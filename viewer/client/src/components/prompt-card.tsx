/**
 * Boot-prompt cards.
 *
 * The text is whatever `phase-graph.sh --boot-prompt` or
 * `next-phase-prompt.sh` printed, copied to the clipboard byte for byte — this
 * console never writes a prompt of its own. That is the whole contract: a
 * prompt the console composed would be a second, divergent implementation of
 * the thing the skill's scripts already decide.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banner, Button, Card, CardHeader, CopyButton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface PromptCardProps {
  title: string;
  /** The query key and the fetch — both, so a collapsed card costs nothing. */
  queryKey: readonly unknown[];
  load: () => Promise<string>;
  note?: string;
  collapsed?: boolean;
  className?: string;
}

export function PromptCard({ title, queryKey, load, note, collapsed = false, className }: PromptCardProps) {
  const [open, setOpen] = useState(!collapsed);

  // `enabled: open` is why a collapsed card is free: the engine is shelled out
  // to per prompt, and a plan's Route tab can hold several of these.
  const { data, error, isPending } = useQuery({
    queryKey,
    queryFn: async () => String(await load()).trim(),
    enabled: open,
  });

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="items-center gap-2 py-2">
        <span className="min-w-0 truncate font-display text-sm">{title}</span>
        <div className="flex shrink-0 items-center gap-2">
          {note && <span className="hidden text-2xs text-ink-faint md:inline">{note}</span>}
          {open
            ? <CopyButton text={() => data ?? ''} label="Copy prompt" />
            : <Button size="sm" onClick={() => setOpen(true)}>Show</Button>}
        </div>
      </CardHeader>

      {open && (
        <div className="min-w-0">
          {error && (
            <div className="p-3">
              <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
            </div>
          )}
          {!error && isPending && (
            <div className="p-3"><Spinner label="Reading the engine" /></div>
          )}
          {!error && data != null && (
            <pre className="m-0 max-h-96 overflow-auto overscroll-contain bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre">
              {data}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}
