/**
 * Форма команды, которой снимается отменённый вызов.
 *
 * Команда уезжает на сервер строкой и разбирается его оболочкой, поэтому
 * проверяется именно текст: место маркера, способ достать группу процессов и
 * то, чего в команде быть не должно — `--` у `kill` BusyBox не понимает вовсе.
 */

import { describe, it, expect } from 'vitest';
import { buildCancelCommand, CALL_MARKER_PREFIX } from '../../src/runner/cancel-command.js';

const MARKER = `${CALL_MARKER_PREFIX}a1b2c3d4e5f60718`;

describe('команда снятия', () => {
  /**
   * Отметка ищется в аргументах, а не в окружении: `environ` чужого процесса
   * закрыт даже для root — на его чтение нужны права ptrace, которых нет ни в
   * контейнере, ни на машине с ужатым ядром.
   */
  it('ищет процесс по отметке вызова в его аргументах', () => {
    const { command } = buildCancelCommand(MARKER);

    expect(command).toContain(`grep -qa "${MARKER}" "$p/cmdline"`);
    expect(command).not.toContain('environ');
    expect(command).toContain('for p in /proc/[0-9]*');
  });

  /**
   * Своя же команда несёт отметку в аргументах: не пропусти она собственную
   * группу, снятие убило бы себя на полпути и цель осталась бы жива.
   */
  it('свою группу процессов обходит стороной', () => {
    const { command } = buildCancelCommand(MARKER);

    expect(command).toContain('mine=$(sed -e "s/.*) //" /proc/$$/stat');
    expect(command).toContain('[ "$g" = "$mine" ]');
  });

  /**
   * Имя процесса стоит в `/proc/<pid>/stat` внутри скобок и может содержать
   * пробел: счёт полей слева тогда съезжает и группой окажется чужое число.
   */
  it('группу берёт после закрывающей скобки, а не счётом полей слева', () => {
    const { command } = buildCancelCommand(MARKER);

    expect(command).toContain('g=$(sed -e "s/.*) //" "$p/stat" 2>/dev/null | cut -d" " -f3)');
  });

  it('цикл закрыт, иначе оболочка не дочитает команду до конца', () => {
    expect(buildCancelCommand(MARKER).command.trimEnd()).toMatch(/done$/);
  });

  it('шлёт сигнал группе и не пишет `--`, которого нет у BusyBox', () => {
    const { command } = buildCancelCommand(MARKER);

    expect(command).toContain('kill -TERM -"$g"');
    expect(command).not.toContain('kill -TERM --');
  });

  it('без группы сигнал не шлётся', () => {
    expect(buildCancelCommand(MARKER).command).toContain('[ -z "$g" ]');
  });

  it('обычному вызову нечего слать на вход', () => {
    expect(buildCancelCommand(MARKER).stdin).toBeUndefined();
  });

  it('обычный вызов снимается без sudo вовсе', () => {
    expect(buildCancelCommand(MARKER).command).not.toContain('sudo');
  });

  describe('вызов с повышением прав', () => {
    /**
     * Команда под sudo принадлежит root, и сигнал от обычного пользователя до
     * неё не доходит — значит и сам поиск идёт под sudo.
     */
    it('с паролем спрашивает sudo и подаёт пароль на вход, а не в аргументы', () => {
      const { command, stdin } = buildCancelCommand(MARKER, {
        elevated: true,
        password: 'секрет',
      });

      expect(command).toContain("sudo -S -p '' sh -c ");
      expect(command).not.toContain('секрет');
      expect(stdin).toBe('секрет\n');
    });

    /**
     * Отвечать на приглашение sudo нечем и негде: терминала нет, а ждущий
     * sudo держал бы снятие до собственного срока.
     */
    it('без пароля спрашивает sudo молча и повторяет попытку без него', () => {
      const { command, stdin } = buildCancelCommand(MARKER, { elevated: true });

      expect(command).toContain('sudo -n sh -c ');
      expect(command.split('for p in /proc')).toHaveLength(3);
      expect(stdin).toBeUndefined();
    });

    it('язык команды берётся тот же, что у самого вызова', () => {
      expect(
        buildCancelCommand(MARKER, { elevated: true, shell: 'bash', password: 'x' }).command
      ).toContain("sudo -S -p '' bash -c ");
      expect(buildCancelCommand(MARKER, { elevated: true, password: 'x' }).command).toContain(
        "sudo -S -p '' sh -c "
      );
    });

    it('цикл внутри sudo закавычен целиком', () => {
      const { command } = buildCancelCommand(MARKER, { elevated: true, password: 'x' });

      expect(command).toContain(`-c 'mine=$(sed -e "s/.*) //" /proc/$$/stat`);
    });
  });
});
