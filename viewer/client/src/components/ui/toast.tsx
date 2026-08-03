import * as ToastPrimitive from '@radix-ui/react-toast';
import { useSyncExternalStore } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Toasts.
 *
 * The four kinds are real variants, not one grey box with different words —
 * `warn` in particular did not exist before, so "the console is running older
 * code than is on disk" arrived looking exactly like "Copied". A toast that
 * cannot show severity is a toast nobody reads.
 *
 * The store is module-level so anything — a mutation handler, an SSE listener,
 * a keyboard shortcut — can raise one without being inside a provider.
 */

export type ToastKind = 'ok' | 'warn' | 'error' | 'info';

/**
 * A toast that wants something. Almost none do — this exists for the update
 * prompt, which must not act on its own and must not disappear before it has
 * been read.
 */
export interface ToastAction {
  label: string;
  onSelect: () => void;
}

export interface ToastRecord {
  id: number;
  message: string;
  kind: ToastKind;
  ms: number;
  action?: ToastAction;
}

let toasts: ToastRecord[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

const publish = () => { for (const notify of listeners) notify(); };

/** `ms: 0` means it stays until it is dismissed or acted on. */
export function toast(
  message: string,
  kind: ToastKind = 'ok',
  ms = 2600,
  action?: ToastAction,
): number {
  const id = ++nextId;
  toasts = [...toasts, { id, message, kind, ms, action }];
  publish();
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  publish();
}

export function useToasts(): ToastRecord[] {
  return useSyncExternalStore(
    (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => toasts,
    () => toasts,
  );
}

const toastVariants = cva(
  'pointer-events-auto flex items-start gap-2 rounded border px-3 py-2 text-sm shadow-card ' +
    'bg-surface-raised data-[state=open]:animate-rise',
  {
    variants: {
      kind: {
        ok: 'border-done/50 text-ink',
        warn: 'border-action/60 text-ink',
        error: 'border-blocked/55 text-blocked',
        info: 'border-progress/45 text-ink',
      },
    },
    defaultVariants: { kind: 'ok' },
  },
);

const DOT: Record<ToastKind, string> = {
  ok: 'bg-done',
  warn: 'bg-action',
  error: 'bg-blocked',
  info: 'bg-progress',
};

/**
 * Mounted once by the shell. The viewport sits above everything (`--z-toast`)
 * and clears the phone's tab bar and home indicator.
 */
export function Toaster() {
  const items = useToasts();
  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {items.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          // 0 means "until someone deals with it" — Radix reads Infinity as
          // never expiring, and a prompt that times out is a prompt that gets
          // missed.
          duration={item.ms === 0 ? Infinity : item.ms}
          onOpenChange={(open) => { if (!open) dismissToast(item.id); }}
          className={cn(toastVariants({ kind: item.kind }))}
        >
          <span className={cn('mt-1.5 size-[7px] shrink-0 rounded-full', DOT[item.kind])} aria-hidden />
          <ToastPrimitive.Description className="min-w-0 flex-1">
            {item.message}
          </ToastPrimitive.Description>
          {item.action && (
            <ToastPrimitive.Action
              altText={item.action.label}
              onClick={item.action.onSelect}
              className={cn(
                'shrink-0 rounded border border-action/60 px-2 py-0.5 text-xs font-medium text-action',
                'hover:bg-action/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              )}
            >
              {item.action.label}
            </ToastPrimitive.Action>
          )}
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        className={cn(
          'pointer-events-none fixed inset-x-0 bottom-0 z-(--z-toast) m-0 flex list-none flex-col gap-2 p-3',
          'pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]',
          // Above the tab bar on a phone; bottom-right on a desktop.
          'md:inset-x-auto md:right-0 md:w-[min(24rem,calc(100vw-1.5rem))]',
        )}
      />
    </ToastPrimitive.Provider>
  );
}

/** Copy, with the fallback a refused clipboard needs. */
export async function copy(text: string, label = 'Copied'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy');
    area.remove();
    toast(ok ? label : 'Could not copy — select the text instead', ok ? 'ok' : 'error');
    return Boolean(ok);
  }
}
