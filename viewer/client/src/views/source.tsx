import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useConsoleState } from '@/lib/queries';
import { Button, Card, CardBody, CardHeader, CardTitle, toast } from '@/components/ui';
import { navigate } from '@/router';

/**
 * The directory picker — the one view that renders *instead of* the shell,
 * because until a root is open there is nothing to navigate to.
 *
 * Deliberately minimal here: a path in, a path opened. The browsable tree is
 * Phase 5. What it must not be in the meantime is a placeholder — a console
 * whose only way to open a directory is a screen that says "Phase 5 builds
 * this" cannot be used on a machine that has not already been set up.
 */
export default function SourceView() {
  const { data: state } = useConsoleState();
  const client = useQueryClient();
  const [path, setPath] = useState('');

  const open = useMutation({
    mutationFn: (target: string) => api.openRoot(target),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast('Source opened');
      navigate('plans');
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const current = state?.root;

  return (
    <div className="mx-auto grid min-h-dvh w-full max-w-2xl place-items-center px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Choose a directory</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-ink-muted">
            The console reads <code className="text-ink">docs/plans/</code> and{' '}
            <code className="text-ink">docs/handoffs/</code> from the repository you point it at.
          </p>

          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const target = path.trim();
              if (target) open.mutate(target);
            }}
          >
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={current?.path ?? '/path/to/repo'}
              aria-label="Repository path"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="min-w-0 flex-1 rounded border border-rule bg-ground px-2 py-2 font-mono text-ink placeholder:text-ink-faint"
            />
            <Button type="submit" variant="action" disabled={open.isPending || !path.trim()}>
              {open.isPending ? 'Opening…' : 'Open'}
            </Button>
          </form>

          {current?.path && (
            <p className="mt-3 text-2xs text-ink-faint">
              Currently open: <span className="font-mono text-ink-muted">{current.path}</span>
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
