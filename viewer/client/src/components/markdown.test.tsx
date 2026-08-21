/**
 * The sanitizer, against things that are trying to get through.
 *
 * The plan files are local, but "local" is not "trusted": a plan can be pasted
 * from anywhere, a handoff is written by an agent that read the internet, and
 * the console renders both into a page that can approve tool calls. So this
 * suite is written the way a sanitizer test has to be — every fixture is an
 * attack, and each assertion names what would have happened if it landed.
 *
 * Both paths are covered on purpose: `toFragment` (what the component actually
 * renders) and `sweep` on hand-built DOM (attacks `marked` would never emit but
 * a future markdown option might).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, MarkdownInline, plainText, sweep, toFragment } from './markdown';

/** Render markdown the way the component does and hand back the resulting HTML. */
function renderMd(source: string): string {
  const host = document.createElement('div');
  host.replaceChildren(toFragment(source).cloneNode(true));
  return host.innerHTML;
}

describe('sweep — the forbidden elements', () => {
  it('removes a script tag, inline or fenced as raw HTML', () => {
    const html = renderMd('before\n\n<script>window.pwned = 1</script>\n\nafter');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('pwned');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it.each([
    ['style', '<style>body{display:none}</style>'],
    ['iframe', '<iframe src="https://example.com"></iframe>'],
    ['object', '<object data="x.swf"></object>'],
    ['embed', '<embed src="x.swf">'],
    ['form', '<form action="/api/approvals/1"><input name="decision"></form>'],
    ['input', '<input value="x">'],
    ['button', '<button>Approve</button>'],
    ['link', '<link rel="stylesheet" href="https://example.com/x.css">'],
    ['meta', '<meta http-equiv="refresh" content="0;url=https://example.com">'],
    ['base', '<base href="https://example.com/">'],
    ['svg', '<svg><use href="#x"/></svg>'],
    ['math', '<math><mi>x</mi></math>'],
  ])('removes <%s>', (tag, fixture) => {
    const html = renderMd(fixture);
    expect(html.toLowerCase()).not.toContain(`<${tag}`);
  });

  it('removes a forbidden element that arrives nested inside allowed markup', () => {
    const html = renderMd('- item\n\n  <div><p>text<script>bad()</script></p></div>');
    expect(html).not.toContain('<script');
    expect(html).toContain('text');
  });
});

describe('sweep — event handlers and style', () => {
  it('strips onerror from an image that would otherwise fire it', () => {
    const html = renderMd('<img src="/missing.png" onerror="window.pwned = 1">');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('pwned');
  });

  it.each(['onclick', 'onload', 'onmouseover', 'onfocus', 'onanimationend'])(
    'strips %s from any element',
    (attribute) => {
      const template = document.createElement('template');
      template.innerHTML = `<p ${attribute}="boom()">text</p>`;
      sweep(template.content);
      expect(template.innerHTML).not.toContain(attribute);
    },
  );

  it('strips a capitalised handler — attribute names are compared lowercased', () => {
    const template = document.createElement('template');
    template.innerHTML = '<p OnClick="boom()">text</p>';
    sweep(template.content);
    expect(template.innerHTML.toLowerCase()).not.toContain('onclick');
  });

  it('strips style, so nothing rendered can cover the page it is rendered in', () => {
    const template = document.createElement('template');
    template.innerHTML = '<p style="position:fixed;inset:0;z-index:99999">overlay</p>';
    sweep(template.content);
    expect(template.innerHTML).not.toContain('style=');
    expect(template.innerHTML).toContain('overlay');
  });

  it('strips srcset, which is a second source attribute the allowlist misses', () => {
    const template = document.createElement('template');
    template.innerHTML = '<img src="/ok.png" srcset="javascript:alert(1) 1x">';
    sweep(template.content);
    expect(template.innerHTML).not.toContain('srcset');
    expect(template.innerHTML).toContain('/ok.png');
  });
});

describe('sweep — the protocol allowlist', () => {
  it('drops a javascript: href but keeps the link text', () => {
    const html = renderMd('[click me](javascript:window.pwned=1)');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click me');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('drops href=%s', (href) => {
    const template = document.createElement('template');
    template.innerHTML = `<a href="${href}">x</a>`;
    sweep(template.content);
    expect(template.innerHTML).not.toContain('href=');
  });

  it.each([
    'https://example.com/x',
    'http://127.0.0.1:4123/api/state',
    'mailto:someone@example.com',
    '#verified',
    '/plans',
    './phase-01-foundations.md',
    '../plans/x.md',
  ])('keeps href=%s', (href) => {
    const template = document.createElement('template');
    template.innerHTML = `<a href="${href}">x</a>`;
    sweep(template.content);
    expect(template.innerHTML).toContain(`href="${href}"`);
  });

  it('drops a src that is not on the allowlist', () => {
    const template = document.createElement('template');
    template.innerHTML = '<img src="data:image/svg+xml,<svg onload=alert(1)>">';
    sweep(template.content);
    expect(template.innerHTML).not.toContain('src=');
  });
});

describe('sweep — links leave the app safely', () => {
  it('marks every link target=_blank rel=noopener noreferrer', () => {
    const html = renderMd('[docs](https://example.com/docs)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('overwrites an attacker-supplied rel rather than trusting it', () => {
    const template = document.createElement('template');
    template.innerHTML = '<a href="https://example.com" rel="opener" target="_self">x</a>';
    sweep(template.content);
    expect(template.innerHTML).toContain('rel="noopener noreferrer"');
    expect(template.innerHTML).toContain('target="_blank"');
    expect(template.innerHTML).not.toContain('rel="opener"');
  });
});

describe('markdown rendering', () => {
  it('renders GFM: tables and fenced code', () => {
    const html = renderMd(
      ['| a | b |', '| - | - |', '| 1 | 2 |', '', '```bash', 'npm test', '```'].join('\n'),
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<code');
    expect(html).toContain('npm test');
  });

  it('renders a task list as text — GFM emits <input>, and <input> is forbidden', () => {
    // Not a defect and not a regression: `input` has always been on the
    // FORBIDDEN list, so a `- [x]` item has always lost its checkbox and kept
    // its words. Asserted here so nobody "fixes" it by opening the list.
    const html = renderMd('- [x] done\n- [ ] not done');
    expect(html).not.toContain('checkbox');
    expect(html).toContain('done');
    expect(html).toContain('not done');
  });

  it('does not turn a single newline into a break (breaks: false)', () => {
    // Handoff bodies are hard-wrapped at ~100 columns; `breaks: true` would put
    // a <br> at the end of every wrapped line and reflow the whole document.
    const html = renderMd('one line\nwrapped here');
    expect(html).not.toContain('<br');
  });

  it('renders nothing at all for empty or missing text', () => {
    const { container } = render(<Markdown text="" />);
    expect(container.firstChild).toBeNull();
    const { container: none } = render(<Markdown text={undefined} />);
    expect(none.firstChild).toBeNull();
  });

  it('mounts block markdown into the live DOM', () => {
    // Braces, not a quoted attribute: `text="a\nb"` in JSX is a literal
    // backslash-n, which markdown renders as one line and the assertion misses.
    render(<Markdown text={'# Heading\n\nbody text'} />);
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText('body text')).toBeInTheDocument();
  });

  it('renders inline markdown without a block wrapper', () => {
    const { container } = render(<MarkdownInline text="a **bold** word" />);
    const span = container.querySelector('.md-inline');
    expect(span).not.toBeNull();
    expect(span?.querySelector('p')).toBeNull();
    expect(span?.querySelector('strong')?.textContent).toBe('bold');
  });

  it('survives re-rendering the same text — the fragment is cloned, not spent', () => {
    // The fragment is memoised; `replaceChildren` empties whatever it consumes,
    // so handing it over directly would blank the block on the second render.
    const { rerender, container } = render(<Markdown text="stable content" />);
    rerender(<Markdown text="stable content" />);
    expect(container.textContent).toContain('stable content');
  });
});

describe('plainText', () => {
  it('drops emphasis characters and collapses whitespace for one-line cells', () => {
    expect(plainText('**Goal:** run   the\nthing `now`')).toBe('Goal: run the thing now');
    expect(plainText(undefined)).toBe('');
  });
});
