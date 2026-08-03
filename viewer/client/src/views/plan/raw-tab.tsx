import { Banner, Card, CardHeader, CardTitle, CopyButton, Skeleton } from '@/components/ui';
import { usePlanRaw } from '@/lib/queries';

/** The plan file, byte for byte — the thing every other tab is a reading of. */
export function RawTab({ slug }: { slug: string }) {
  const { data, error, isPending } = usePlanRaw(slug);

  if (error) return <Banner severity="error">{String((error as Error).message ?? error)}</Banner>;
  if (isPending || data == null) return <Skeleton className="h-96" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm normal-case">docs/plans/{slug}.md</CardTitle>
        <CopyButton text={data} label="Copy markdown" />
      </CardHeader>
      <pre className="m-0 max-h-[70vh] overflow-auto overscroll-contain border-t border-rule bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {data}
      </pre>
    </Card>
  );
}
