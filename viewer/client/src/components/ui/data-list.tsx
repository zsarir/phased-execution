import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A long list that only renders what is on screen — journals, transcripts,
 * notifications, hundreds of runs. TanStack Virtual measures each row as it
 * lands (`measureElement`), so rows may be any height.
 *
 * The list owns ONE scroller, vertical, of a height the caller sets through
 * `maxHeight` (default: bounded by `--app-height`, never `dvh`). Its optional
 * header is ordinary flow ABOVE the scroller — never `sticky top-0` inside an
 * overflow-x wrapper, where sticky can only stick to the wrapper and costs a
 * layer per row. The scroller chains its overscroll at the ends, so a flick
 * that runs out of list continues the page instead of trapping the thumb.
 */
export interface DataListProps<T> {
  items: readonly T[];
  /** A stable key per row — the virtualizer and React both need it. */
  keyOf: (item: T, index: number) => string | number;
  renderRow: (item: T, index: number) => ReactNode;
  /** A starting guess at a row's height, in px; rows are measured after mount. */
  estimateRowHeight?: number;
  header?: ReactNode;
  empty?: ReactNode;
  /** The scroller's max height; defaults to ~60 % of the visible viewport. */
  maxHeight?: string;
  /** Rows rendered beyond the viewport on either side. */
  overscan?: number;
  /** The accessible role of the list ("list" by default; "log" for a journal that appends). */
  role?: 'list' | 'log' | 'feed';
  label?: string;
  className?: string;
  rowClassName?: string;
}

export function DataList<T>({
  items,
  keyOf,
  renderRow,
  estimateRowHeight = 44,
  header,
  empty,
  maxHeight = 'min(40rem, calc(var(--app-height, 100%) * 0.6))',
  overscan = 8,
  role = 'list',
  label,
  className,
  rowClassName,
}: DataListProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimateRowHeight,
    overscan,
    getItemKey: (index) => keyOf(items[index], index),
  });
  const rows = virtualizer.getVirtualItems();
  const rowRole = role === 'list' ? 'listitem' : 'article';

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      {header != null && <div className="shrink-0">{header}</div>}
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-ink-muted">{empty ?? 'Nothing here.'}</div>
      ) : (
        <div
          ref={scroller}
          role={role}
          aria-label={label}
          className="min-h-0 overflow-y-auto overscroll-y-auto"
          style={{ maxHeight }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {rows.map((row) => {
              const style: CSSProperties = {
                position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)`,
              };
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  role={rowRole}
                  // Only a subset is in the DOM: setsize/posinset carry "row N of
                  // total" and are valid on listitem and article, where the grid
                  // attributes (aria-rowcount/rowindex) are not.
                  aria-setsize={items.length}
                  aria-posinset={row.index + 1}
                  className={cn('min-w-0', rowClassName)}
                  style={style}
                >
                  {renderRow(items[row.index], row.index)}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
