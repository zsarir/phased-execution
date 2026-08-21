import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Empty } from '@/components/ui';

/**
 * The page frame every view sits in.
 *
 * `min-w-0` on the scroll container is the whole reason a wide table or a long
 * command does not push the phone sideways: a grid child's default `min-width:
 * auto` lets its content set the track width, and one over-wide cell then makes
 * the *shell* scroll, taking the tab bar off the edge of the screen with it.
 */
export function Page({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full min-w-0 max-w-(--content-max) px-3 py-4 md:px-5', className)}>
      {(title != null || actions != null) && (
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title != null && <h1 className="font-display text-3xl leading-none">{title}</h1>}
            {subtitle != null && <p className="mt-1.5 text-sm text-ink-muted">{subtitle}</p>}
          </div>
          {actions != null && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}

/**
 * A view whose surface a later phase owns. It is a real route — it navigates,
 * deep-links and reloads — with nothing in it yet, which is exactly what the
 * shell needs to be verifiable before the content exists.
 */
export function Placeholder({ title, phase, what }: { title: string; phase: number; what: string }) {
  return (
    <Page title={title}>
      <Empty title={`${title} is built in Phase ${phase}`} body={what} />
    </Page>
  );
}
