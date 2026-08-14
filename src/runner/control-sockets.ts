/**
 * Что мы оставили на машине
 *
 * Управляющие сокеты переживают выход сервера: соединение общее для машины,
 * и закрытие рвало бы канал соседнему окну. Модуль отвечает только фактами —
 * какие сокеты лежат в каталоге и живы ли они. Текст для показа собирают
 * потребители: печать на выходе и ssh_monitor.
 */

import { readdir, stat } from 'fs/promises';
import { connect } from 'net';
import { join } from 'path';
import { CONTROL_SOCKET_PREFIX, resolveControlPersistSec } from './ssh-args.js';
import { resolveControlDir } from './runtime-check.js';

/** Сколько ждать ответа от локального сокета, прежде чем считать состояние неизвестным */
const PROBE_TIMEOUT_MS = 1000;

/**
 * Состояние управляющего сокета.
 *
 * `stale` — файл остался от убитого master: следующая команда поднимет
 * соединение заново, но до тех пор сокет занимает место и вводит в заблуждение.
 */
type ControlSocketState = 'alive' | 'stale' | 'unknown';

export interface ControlSocket {
  path: string;
  /**
   * Когда поднят master. Командами не обновляется, поэтому по этому времени
   * нельзя судить, сколько соединению осталось жить.
   */
  since: Date;
  state: ControlSocketState;
}

/**
 * Живо ли соединение за сокетом.
 *
 * Подключение без единого байта — штатный путь: master принимает его и ждёт
 * приветствия протокола, а разрыв не трогает ни его, ни соседние сессии.
 */
function probeSocket(path: string): Promise<ControlSocketState> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const finish = (state: ControlSocketState): void => {
      socket.destroy();
      resolve(state);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish('unknown'));
    socket.on('connect', () => finish('alive'));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'stale' : 'unknown')
    );
  });
}

/**
 * Управляющие сокеты, оставленные в каталоге.
 *
 * Каталог принадлежит серверу, но кроме сокетов там лежит askpass-скрипт,
 * поэтому имена отбираются по префиксу. Сокет, исчезнувший между чтением
 * каталога и опросом, в список не попадает: срок вышел, и он уже не наш.
 */
export async function listControlSockets(
  controlDir: string = resolveControlDir()
): Promise<ControlSocket[]> {
  let names: string[];
  try {
    names = await readdir(controlDir);
  } catch (error) {
    // Каталога нет — соединений не заводили вовсе
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const sockets: ControlSocket[] = [];

  for (const name of names) {
    if (!name.startsWith(CONTROL_SOCKET_PREFIX)) continue;

    const path = join(controlDir, name);
    try {
      const info = await stat(path);
      // Тип файла из stat решает сразу: подключением опрашивают только настоящие сокеты
      const state = info.isSocket() ? await probeSocket(path) : 'unknown';
      sockets.push({ path, since: info.mtime, state });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  return sockets;
}

/**
 * Сколько соединение живёт после последней команды, секунды.
 *
 * Именно это значение уходит в команду ssh, поэтому вызывающий называет срок,
 * а не обещание. Остаток срока не вычисляется: время сокета — это момент
 * подъёма master, команды его не двигают.
 */
export function idleWindowSec(): number {
  return resolveControlPersistSec();
}
