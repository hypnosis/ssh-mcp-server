/**
 * Канал SFTP не остаётся без обработчика ошибок
 *
 * Канал — обычный EventEmitter: событие `error` без единого слушателя Node
 * превращает в необработанное исключение, то есть в смерть всего процесса.
 * Обрыв связи и упор в лимит сессий приходят именно так — уже после того,
 * как канал открылся.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const { ConnectionPool } = await import('../../src/managers/connection-pool.js');

const CONFIG: SSHConfig = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

/** Канал SFTP, каким его видит вызывающий */
class FakeSftp extends EventEmitter {
  readonly end = vi.fn();
}

describe('ConnectionPool.getSftp', () => {
  const pool = ConnectionPool.getInstance();
  let channel: FakeSftp;

  beforeEach(() => {
    vi.restoreAllMocks();
    channel = new FakeSftp();

    const client = {
      sftp: (callback: (err: Error | null, sftp: unknown) => void) => callback(null, channel),
    };
    vi.spyOn(pool, 'getClient').mockResolvedValue(client as never);
  });

  it('отдаёт канал с уже установленным обработчиком ошибок', async () => {
    const sftp = await pool.getSftp('production', CONFIG);

    expect((sftp as unknown as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
  });

  it('ошибка канала после открытия не превращается в необработанное исключение', async () => {
    await pool.getSftp('production', CONFIG);

    expect(() => channel.emit('error', new Error('Channel open failure'))).not.toThrow();
  });
});
