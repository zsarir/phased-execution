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
import type { Severity } from '@/components/ui';

export interface PromptCardProps {
  title: string;
  /** The query key and the fetch — both, so a collapsed card costs nothing. */
  queryKey: readonly unknown[];
  load: () => Promise<string>;
  note?: string;
  /**
   * What the reader needs to know BEFORE they copy this.
   *
   * A boot prompt is always technically valid — the scripts print it whatever
   * the phase is doing — so the thing that makes it safe or pointless to paste
   * is context the card cannot see: another session already on this phase,
   * dependencies not met, a gate not cleared. The caller knows; this renders
   * it above the prompt rather than beside the card, where it would be read
   * after the copy button had already been pressed.
   */
  banner?: { severity: Severity; text: string };
  collapsed?: boolean;
  className?: string;
}

export function PromptCard({
  title,
  queryKey,
  load,
  note,
  banner,
  collapsed = false,
  className,
}: PromptCardProps) {
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
          {open ? (
            <CopyButton text={() => data ?? ''} label="Copy prompt" />
          ) : (
            <Button size="sm" onClick={() => setOpen(true)}>
              Show
            </Button>
          )}
        </div>
      </CardHeader>

      {/* Outside the `open` gate on purpose: the caution is the reason the card
          is collapsed, so hiding it behind the same toggle would show it only
          to someone who had already decided to look. */}
      {banner && (
        <div className="px-3 pb-2">
          <Banner severity={banner.severity}>{banner.text}</Banner>
        </div>
      )}

      {open && (
        <div className="min-w-0">
          {error && (
            <div className="p-3">
              <Banner severity="error">{String((error as Error).message ?? error)}</Banner>
            </div>
          )}
          {!error && isPending && (
            <div className="p-3">
              <Spinner label="Reading the engine" />
            </div>
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
