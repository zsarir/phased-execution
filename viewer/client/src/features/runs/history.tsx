/**
 * Earlier runs of this plan.
 *
 * The first entry of `history` is the run the rest of the page is about, so it is
 * dropped here rather than shown twice — and with one run there is nothing to
 * say, so the section does not exist at all.
 *
 * Runs are recorded outside the repository (`~/.local/state/…`), which is why
 * none of this shows up in `git status` and why a plan can have a history on one
 * machine and none on another.
 */

import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  StatusBadge,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
} from '@/components/ui';
import { money, relativeTime } from '@/lib/format';
import { runStatusTitle, runUiState } from '@/lib/status-vocab';
import type { RunState } from '@/lib/api';

export function RunHistory({ history }: { history: RunState[] }) {
  const earlier = history.slice(1);
  if (!earlier.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Earlier runs</CardTitle>
      </CardHeader>
      <CardBody className="p-0">
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH scope="col">Run</TH>
                <TH scope="col">Status</TH>
                <TH scope="col">Updated</TH>
                <TH scope="col" className="text-right">
                  Spent
                </TH>
              </TR>
            </THead>
            <TBody>
              {earlier.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <code className="font-mono text-2xs">{r.id}</code>
                  </TD>
                  <TD>
                    <StatusBadge
                      state={runUiState(r.status)}
                      label={r.status}
                      mono
                      title={runStatusTitle(r.status)}
                    />
                  </TD>
                  <TD className="text-ink-faint">{relativeTime(Date.parse(r.updatedAt))}</TD>
                  <TD className="text-right font-mono tabular-nums">{money(r.spentUsd)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      </CardBody>
    </Card>
  );
}
