/**
 * Отчёт об оставленных management-сокетах при выключении сервера.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/runner/control-sockets.js', () => ({
  listControlSockets: vi.fn(),
  idleWindowSec: vi.fn(() => 600),
}));

import { listControlSockets } from '../../src/runner/control-sockets.js';
import { reportLeftoverConnections } from '../../src/runner/leftover-report.js';

describe('отчёт об оставленных соединениях при выключении', () => {
  let written: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    written = [];
    spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    });
    vi.mocked(listControlSockets).mockReset();
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('печатает путь и время подъёма живых сокетов', async () => {
    vi.mocked(listControlSockets).mockResolvedValue([
      { path: '/tmp/ctl-a', since: new Date('2026-01-01T00:00:00.000Z'), state: 'alive' },
    ]);

    await reportLeftoverConnections();

    const output = written.join('\n');
    expect(output).toContain('Left 1 connection(s) open (will close automatically after 600s idle)');
    expect(output).toContain('/tmp/ctl-a — opened 2026-01-01T00:00:00.000Z');
    expect(output).not.toContain('Stale sockets');
  });

  it('сообщает число осиротевших сокетов без живого соединения', async () => {
    vi.mocked(listControlSockets).mockResolvedValue([
      { path: '/tmp/ctl-b', since: new Date('2026-01-01T00:00:00.000Z'), state: 'stale' },
    ]);

    await reportLeftoverConnections();

    const output = written.join('\n');
    expect(output).toContain('Left 0 connection(s) open');
    expect(output).toContain('Stale sockets: 1 — will be cleaned up on next command');
  });

  it('молчит, когда сокетов не осталось', async () => {
    vi.mocked(listControlSockets).mockResolvedValue([]);

    await reportLeftoverConnections();

    expect(written).toEqual([]);
  });
});
