/**
 * Registration, the update prompt, and the online signal.
 *
 * Two of these guard things that fail silently and expensively.
 *
 * The URL and scope are a contract with every device already subscribed to
 * push: a subscription belongs to a registration, and a registration is
 * identified by its scope. Serving the worker from `/assets/sw-<hash>.js`, or
 * registering it at a narrower scope, unsubscribes every one of them — and
 * nothing anywhere reports it, because from the browser's point of view nothing
 * went wrong. That is why it is asserted rather than trusted.
 *
 * The other is the reload loop. `controllerchange` fires on a first install
 * too, so "reload when the controller changes" reloads the very first time the
 * app is ever opened, which installs, changes controller, and goes round again.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster, useToasts } from '@/components/ui';
import { registerServiceWorker, resetServiceWorkerForTests, useOnline, useServiceWorker } from './pwa';

/** A `ServiceWorker` with only the parts this module touches. */
function fakeWorker() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    state: 'installing' as ServiceWorker['state'],
    postMessage: vi.fn(),
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
    emit(type: string) { for (const fn of [...(listeners.get(type) ?? [])]) fn(); },
  };
}

function fakeRegistration() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    installing: null as ReturnType<typeof fakeWorker> | null,
    waiting: null as ReturnType<typeof fakeWorker> | null,
    update: vi.fn().mockResolvedValue(undefined),
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
    emit(type: string) { for (const fn of [...(listeners.get(type) ?? [])]) fn(); },
  };
}

let registration: ReturnType<typeof fakeRegistration>;
let container: {
  controller: unknown;
  register: ReturnType<typeof vi.fn>;
  addEventListener: (t: string, f: () => void) => void;
  removeEventListener: (t: string, f: () => void) => void;
  emit: (t: string) => void;
};
let reload: ReturnType<typeof vi.fn>;
const realLocation = window.location;

beforeEach(() => {
  resetServiceWorkerForTests();
  // The auto-apply one-shot persists in sessionStorage; a marker left by one
  // case must not decide the next.
  sessionStorage.clear();
  // Vitest runs in dev mode; the module skips registration there because no
  // worker is built for the dev server.
  vi.stubEnv('DEV', false);

  registration = fakeRegistration();
  const listeners = new Map<string, Set<() => void>>();
  container = {
    controller: { scriptURL: '/sw.js' },
    register: vi.fn().mockResolvedValue(registration),
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
    emit: (type: string) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); },
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });

  reload = vi.fn();
  // `reload` on a jsdom Location is unforgeable, so it cannot be spied in
  // place; the whole `location` can be swapped, and is put back afterwards.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, href: realLocation.href, reload },
  });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

/** Mounts the hook and exposes whatever the toast store is holding. */
function Harness() {
  useServiceWorker();
  const toasts = useToasts();
  return (
    <>
      <div data-testid="count">{toasts.length}</div>
      <div data-testid="messages">{toasts.map((t) => t.message).join('|')}</div>
      <Toaster />
    </>
  );
}

describe('service worker registration', () => {
  it('registers /sw.js at scope / — the pair every push subscription is bound to', async () => {
    const reg = await registerServiceWorker();
    expect(reg).toBe(registration);
    expect(container.register).toHaveBeenCalledTimes(1);
    const [url, options] = container.register.mock.calls[0];
    expect(url).toBe('/sw.js');
    expect(options.scope).toBe('/');
    // An update check answered from the HTTP cache is an update that never
    // arrives.
    expect(options.updateViaCache).toBe('none');
  });

  it('registers once however many callers ask', async () => {
    await Promise.all([registerServiceWorker(), registerServiceWorker(), registerServiceWorker()]);
    expect(container.register).toHaveBeenCalledTimes(1);
  });

  it('does not register in dev, where no worker is built', async () => {
    vi.stubEnv('DEV', true);
    resetServiceWorkerForTests();
    expect(await registerServiceWorker()).toBeNull();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('survives a browser with no service workers at all', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    resetServiceWorkerForTests();
    expect(await registerServiceWorker()).toBeNull();
  });

  it('survives a refused registration', async () => {
    container.register.mockRejectedValue(new Error('insecure context'));
    resetServiceWorkerForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await registerServiceWorker()).toBeNull();
  });
});

describe('the update prompt', () => {
  it('offers an update when a new worker has installed behind the open one', async () => {
    render(<Harness />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const installing = fakeWorker();
    registration.installing = installing;
    act(() => { registration.emit('updatefound'); });
    installing.state = 'installed';
    act(() => { installing.emit('statechange'); });

    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
    expect(screen.getByTestId('messages').textContent).toMatch(/new version/i);
  });

  it('says nothing on a first install — there is nothing to interrupt', async () => {
    container.controller = null;
    render(<Harness />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const installing = fakeWorker();
    registration.installing = installing;
    act(() => { registration.emit('updatefound'); });
    installing.state = 'installed';
    act(() => { installing.emit('statechange'); });

    await waitFor(() => expect(registration.update).toHaveBeenCalled());
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('auto-applies one already waiting at page load — the stale shell just rendered, replacing it is free', async () => {
    const waiting = fakeWorker();
    registration.waiting = waiting;
    render(<Harness />);
    await waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
    // Taken, not offered — no toast to miss this time.
    expect(screen.getByTestId('count').textContent).toBe('0');
    act(() => { container.emit('controllerchange'); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('falls back to the toast when an auto-apply already fired this minute — the loop guard', async () => {
    sessionStorage.setItem('pc-sw-auto-applied', JSON.stringify({ at: Date.now() }));
    const waiting = fakeWorker();
    registration.waiting = waiting;
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
    expect(waiting.postMessage).not.toHaveBeenCalled();
  });

  it('never auto-applies over a live pty surface — scrollback does not survive a reload', async () => {
    window.location.hash = '#/terminal/abc123';
    const waiting = fakeWorker();
    registration.waiting = waiting;
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
    expect(waiting.postMessage).not.toHaveBeenCalled();
  });

  it('the offered path still applies only when the button is pressed', async () => {
    // Suppress the auto-apply so the toast flow is what runs.
    sessionStorage.setItem('pc-sw-auto-applied', JSON.stringify({ at: Date.now() }));
    const waiting = fakeWorker();
    registration.waiting = waiting;
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));

    // Present, and doing nothing, until it is chosen.
    expect(waiting.postMessage).not.toHaveBeenCalled();
    const button = await screen.findByRole('button', { name: 'Reload' });
    act(() => { button.click(); });
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    // Still nothing: the new worker reloads the page by taking over, not by
    // being asked to.
    expect(reload).not.toHaveBeenCalled();

    act(() => { container.emit('controllerchange'); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload on a controller change nobody asked for', async () => {
    // This is the loop: a first install and a rollback to the legacy client
    // both change the controller, and reloading on either throws away whatever
    // is on screen — repeatedly.
    render(<Harness />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    act(() => { container.emit('controllerchange'); });
    expect(reload).not.toHaveBeenCalled();
  });

  it('asks the server once per load whether there is anything newer', async () => {
    render(<Harness />);
    await waitFor(() => expect(registration.update).toHaveBeenCalledTimes(1));
  });
});

describe('the online signal', () => {
  function Online() {
    return <div data-testid="online">{String(useOnline())}</div>;
  }

  it('reports what the browser reports', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    render(<Online />);
    expect(screen.getByTestId('online').textContent).toBe('false');
  });

  it('follows the interface going down and coming back', async () => {
    render(<Online />);
    expect(screen.getByTestId('online').textContent).toBe('true');

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByTestId('online').textContent).toBe('false');

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(screen.getByTestId('online').textContent).toBe('true');
  });
});

describe('applyUpdateNow — the deterministic path the toast is not', () => {
  it('reports current when no worker is waiting, and touches nothing', async () => {
    render(<Harness />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const { applyUpdateNow } = await import('./pwa');
    const reload = vi.fn();
    await expect(applyUpdateNow(reload)).resolves.toBe('current');
    expect(reload).not.toHaveBeenCalled();
  });

  it('activates a waiting worker and reloads once it takes over', async () => {
    render(<Harness />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const waiting = fakeWorker();
    registration.waiting = waiting;
    const { applyUpdateNow } = await import('./pwa');
    const reload = vi.fn();
    const done = applyUpdateNow(reload);
    await waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
    act(() => { container.emit('controllerchange'); });
    await expect(done).resolves.toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('returning to the tab re-checks for an update', () => {
  it('auto-applies a worker that finished waiting while the tab was hidden', async () => {
    render(<Harness />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    expect(screen.getByTestId('count').textContent).toBe('0');

    // The deploy happened while the operator was elsewhere; coming back is
    // the other boundary where nothing on screen is mid-flight.
    const waiting = fakeWorker();
    registration.waiting = waiting;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    await waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
    expect(registration.update.mock.calls.length).toBeGreaterThan(1);
    act(() => { container.emit('controllerchange'); });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
