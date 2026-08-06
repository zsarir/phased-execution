import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom has no matchMedia, and the shell asks for it on first render to decide
// whether it is a phone. Default: not a phone, no listeners — a test that cares
// overrides this per case.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// Nor `scrollIntoView`, which jsdom leaves unimplemented because it has no
// layout. The guide uses it in two places — bringing the active tab into a
// ten-tab strip, and landing on a `?card=` deep link — and neither has anything
// to assert in a DOM with no viewport. A no-op keeps those paths exercised
// rather than guarded in app code for a test environment's benefit.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// Neither does it have EventSource. The data plane opens exactly one on boot.
if (!('EventSource' in globalThis)) {
  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) { this.url = url; }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void { this.readyState = 2; }
  }
  Object.defineProperty(globalThis, 'EventSource', { value: FakeEventSource, writable: true });
}
