/**
 * MCP servers, on the Settings page.
 *
 * A summary rather than the whole registry: the full page is `#/mcp`, and the
 * job here is the one Settings does for everything else — tell you what this
 * console is configured to do, and give you the door to change it. What earns
 * its place is the count, whatever needs a person, and the flag's own state.
 *
 * The card renders whether or not `--allow-mcp` is set, and says what the flag
 * would add — a capability that hides when disabled looks like a bug.
 */

import { useMcp } from '@/lib/queries';
import { Button, Card, CardBody, CardHeader, CardTitle, Chip, KeyValue } from '@/components/ui';
import { navigate } from '@/app/router';

export function McpCard() {
  const { data } = useMcp();
  const servers = data?.servers ?? [];
  const allowed = data?.allowMcp ?? false;

  const on = servers.filter((server) => server.enabled);
  const attention = on.filter(
    (server) => server.status === 'needs-auth' || server.status === 'failed' || server.toolsChanged,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP servers</CardTitle>
        <div className="flex items-center gap-2">
          {allowed ? <Chip tone="warn">registration enabled</Chip> : null}
          <Button size="sm" onClick={() => navigate('mcp')}>
            Manage
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        <KeyValue
          items={[
            [
              'Registered',
              servers.length
                ? `${servers.length} · ${on.length} switched on`
                : "none — sessions use this machine's own MCP configuration",
            ],
            [
              'Needs a person',
              attention.length ? (
                <span className="text-stuck">
                  {attention.map((server) => server.label).join(', ')} — phases naming
                  {attention.length === 1 ? ' it' : ' them'} will park at boarding
                </span>
              ) : on.length ? (
                'nothing — every switched-on server answered'
              ) : (
                '—'
              ),
            ],
          ]}
        />
        {!allowed && (
          <p className="border-t border-rule pt-3 text-xs text-ink-muted">
            Start the console with <code>--allow-mcp</code> to register servers, hold their credentials and
            attach them to plans and phases. The registry, the connection statuses and the catalog above work
            without it.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
