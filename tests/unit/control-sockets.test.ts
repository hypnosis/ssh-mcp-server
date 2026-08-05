/**
 * Unit tests for the control socket inventory
 *
 * Сокеты здесь настоящие: живой слушатель, убитый слушатель и посторонний файл
 * в том же каталоге. Мок отвечал бы на пробу тем, что придумал автор, — а
 * различать живое и мёртвое умеет только ядро.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, symlinkSync, chmodSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { listControlSockets, idleWindowSec } from '../../src/runner/control-sockets.js';

let controlDir: string;
const servers: Server[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  // Адрес unix-сокета ограничен 104 байтами, поэтому каталог короткий
  controlDir = mkdtempSync(join(tmpdir(), 'ctl-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(controlDir, { recursive: true, force: true });
  delete process.env.SSH_MCP_CONTROL_PERSIST;
});

/** Сокет с живым слушателем */
function listenOn(path: string): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer();
    servers.push(server);
    server.listen(path, resolve);
  });
}

/**
 * Сокет, чей слушатель убит без уборки, — то же, что остаётся от убитого
 * master: файл на месте, подключиться некуда.
 */
async function abandonedSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, [
    '-e',
    `require('net').createServer().listen(process.argv[1], () => console.log('up'))`,
    path,
  ]);
  children.push(child);

  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('listControlSockets', () => {
  it('без каталога отвечает пустым списком, а не ошибкой', async () => {
    await expect(listControlSockets(join(controlDir, 'missing'))).resolves.toEqual([]);
  });

  it('пустой каталог — соединений нет', async () => {
    await expect(listControlSockets(controlDir)).resolves.toEqual([]);
  });

  it('askpass-скрипт из того же каталога за соединение не считает', async () => {
    writeFileSync(join(controlDir, 'askpass.sh'), '#!/bin/sh\n');

    await expect(listControlSockets(controlDir)).resolves.toEqual([]);
  });

  it('живой сокет опознаёт живым и называет время подъёма', async () => {
    const path = join(controlDir, 's-alive');
    await listenOn(path);

    const sockets = await listControlSockets(controlDir);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].path).toBe(path);
    expect(sockets[0].state).toBe('alive');
    expect(sockets[0].since.getTime()).toBeGreaterThan(0);
  });

  it('сокет убитого слушателя опознаёт огрызком', async () => {
    const path = join(controlDir, 's-stale');
    await abandonedSocket(path);
    expect(existsSync(path)).toBe(true);

    const sockets = await listControlSockets(controlDir);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].state).toBe('stale');
  });

  it('различает живой и мёртвый в одном каталоге', async () => {
    await listenOn(join(controlDir, 's-one'));
    await abandonedSocket(join(controlDir, 's-two'));

    const sockets = await listControlSockets(controlDir);
    const states = sockets.map((socket) => socket.state).sort();

    expect(states).toEqual(['alive', 'stale']);
  });

  it('имя без файла за ним пропускает, а не роняет обход', async () => {
    // Так выглядит сокет, истёкший между чтением каталога и опросом
    symlinkSync(join(controlDir, 'gone'), join(controlDir, 's-broken'));

    await expect(listControlSockets(controlDir)).resolves.toEqual([]);
  });

  it('непонятную ошибку на имени не проглатывает', async () => {
    // Ссылка на саму себя: файл в каталоге есть, а прочитать его нельзя —
    // и это не «сокет истёк», а повод сказать вслух
    symlinkSync(join(controlDir, 's-loop'), join(controlDir, 's-loop'));

    await expect(listControlSockets(controlDir)).rejects.toThrow();
  });

  it('нечитаемый каталог — это отказ, а не «соединений нет»', async () => {
    const closed = mkdtempSync(join(tmpdir(), 'ctl-closed-'));
    chmodSync(closed, 0o000);

    try {
      await expect(listControlSockets(closed)).rejects.toThrow();
    } finally {
      chmodSync(closed, 0o700);
      rmSync(closed, { recursive: true, force: true });
    }
  });

  it('обычный файл с тем же префиксом соединением не объявляет', async () => {
    writeFileSync(join(controlDir, 's-not-a-socket'), 'текст');

    const sockets = await listControlSockets(controlDir);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].state).toBe('unknown');
  });
});

describe('idleWindowSec', () => {
  it('называет тот же срок, что уходит в команду ssh', () => {
    expect(idleWindowSec()).toBe(600);

    process.env.SSH_MCP_CONTROL_PERSIST = '42';
    expect(idleWindowSec()).toBe(42);
  });
});
