/**
 * The permission policy — the shipped lists, the operator's adds and strikes,
 * and the one edit verb.
 */

import { request, post, q } from './client';

/* ---------------- the permission policy ---------------- */

export interface RuleSupport {
  raw: string;
  tool: string;
  form: string;
  support: string;
  note?: string;
}

export interface PolicyLists {
  deny: string[];
  ask: string[];
  allow: string[];
}

/**
 * What a policy FILE holds: the operator's own rules plus the shipped
 * ask/allow defaults they have struck by name. Deliberately no `removed.deny`
 * — the shipped deny list is the wall and cannot be struck from a browser.
 */
export interface PolicyExtras extends PolicyLists {
  /** `deny` is optional: servers from before the 2026-08 parity omit it. */
  removed?: { deny?: string[]; ask: string[]; allow: string[] };
}

export interface PolicyView {
  defaults: PolicyLists;
  extra: PolicyExtras;
  plan: { slug: string; path: string; extra: PolicyExtras } | null;
  effective: PolicyLists;
  file: string;
  profiles: { id: string; label: string }[];
  /** Rules the syntax accepts that nothing honours. */
  inert: { raw: string; note: string }[];
  support: RuleSupport[];
  hookTools: string[];
  wrappersNotStripped: string[];
  /** Tools this console has actually been asked about. */
  seen?: string[];
}

/** What `POST /api/policy` accepts — one scope, one edit. */
export interface PolicyEdit {
  scope: 'global' | 'plan';
  slug?: string | null;
  add?: Partial<Record<keyof PolicyLists, string[]>>;
  /** Also strikes a SHIPPED default by name — deny included since the 2026-08 parity. */
  remove?: Partial<Record<keyof PolicyLists, string[]>>;
  /** Return these parts to stock at the chosen scope: your rules out, strikes forgiven. */
  reset?: (keyof PolicyLists)[];
  /** Forgive individual strikes — the named shipped defaults apply again, as defaults. */
  restore?: { deny?: string[]; ask?: string[]; allow?: string[] };
}

/** The policy fetchers — merged into `api` by `./index`. */
export const policyApi = {
  policy: (slug?: string) => request<PolicyView>(`/api/policy${slug ? `?slug=${q(slug)}` : ''}`),
  addPolicy: (rules: unknown) => post<PolicyView>('/api/policy', rules),
  editPolicy: (edit: PolicyEdit) => post<PolicyView>('/api/policy', { by: 'console', ...edit }),
};
