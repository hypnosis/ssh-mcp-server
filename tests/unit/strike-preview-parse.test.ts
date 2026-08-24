/**
 * Unit tests: что показывается вместо удара
 *
 * Три исхода не смешиваются и проверяются порознь: цели найдены, раскрытие
 * не нашло ничего, спросить машину нечем. Второй и третий выглядят одинаково
 * пусто, а означают противоположное — «бить не по чему» и «неизвестно, по
 * чему бьём».
 *
 * Куски ответов взяты с лаборатории, а не сочинены: заголовок `/proc/net/tcp`,
 * колонки `docker ps`, форма строки `sshd: root@notty`.
 */

import { describe, it, expect } from 'vitest';
import { findBlindStrikes } from '../../src/utils/blind-target.js';
import { buildPreviewCommand, readPreview } from '../../src/utils/strike-preview-parse.js';

const strikesOf = (command: string) => findBlindStrikes(command);

/** Ответ машины, собранный из разделов */
const reply = (...lines: string[]) => lines.join('\n');

const NET_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

describe('какой вопрос уезжает на машину', () => {
  it('раскрытие подстановки едет как есть', () => {
    const command = buildPreviewCommand(strikesOf('docker kill $(docker ps -q --filter name=web)'));
    expect(command).toContain('docker ps -q --filter name=web');
  });

  it('движок спрашивается тот, которым бьют', () => {
    const command = buildPreviewCommand(strikesOf('podman kill $(podman ps -q)'));
    expect(command).toContain('podman ps --no-trunc');
    expect(command).not.toContain('docker ps --no-trunc');
  });

  it('где процессов нет, сокеты не читаются', () => {
    const command = buildPreviewCommand(strikesOf('docker kill $(docker ps -q)'));
    expect(command).not.toContain('/proc/net/tcp');
  });

  it('отдельная программа compose спрашивает свой движок', () => {
    expect(buildPreviewCommand(strikesOf('docker-compose stop $(cat s.txt)'))).toContain(
      'docker ps --no-trunc'
    );
  });

  it('контейнерный удар про процессы не спрашивает', () => {
    expect(buildPreviewCommand(strikesOf('docker kill $(docker ps -q)'))).not.toContain('@@PROCS');
  });

  it('удар без раскрытия движок спрашивать не заставляет', () => {
    expect(buildPreviewCommand(strikesOf('docker kill $IMAGE'))).not.toContain('--no-trunc');
  });

  it('где процессов нет, время работы машины не спрашивается', () => {
    expect(buildPreviewCommand(strikesOf('docker kill $(docker ps -q)'))).not.toContain('/proc/uptime');
  });

  it('где контейнеров нет, движок не спрашивается', () => {
    const command = buildPreviewCommand(strikesOf('kill $(pgrep -f app)'));
    expect(command).not.toContain('--no-trunc');
    expect(command).toContain('/proc/net/tcp');
  });

  it('удар, которому нечего раскрывать, вопроса не порождает', () => {
    expect(buildPreviewCommand(strikesOf('kill $PID'))).not.toContain('@@STRIKE');
  });

  // Поиск по командной строке находит саму команду поиска — она эту строку и несёт
  it('своя работа из ответа исключается', () => {
    expect(buildPreviewCommand(strikesOf('pkill -f app'))).toContain('SSH_MCP_PREVIEW');
  });
});

describe('контейнеры', () => {
  const strikes = strikesOf('docker kill $(docker ps -q --filter ancestor=web)');
  const listing =
    '20039a6eb77e591d6ea986cd44f2f1f5ba251fa29bc7a9836e911c926b1c7bc8|edge|web:latest|Up 34 days|0.0.0.0:8443->8443/tcp';

  it('короткий идентификатор из пробы находит полный', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@CONTAINERS docker', listing, '@@STRIKE 0', '20039a6eb77e')
    );

    expect(preview.targets).toEqual([
      {
        kind: 'container',
        name: 'edge',
        image: 'web:latest',
        status: 'Up 34 days',
        ports: '0.0.0.0:8443->8443/tcp',
      },
    ]);
  });

  it('имя из пробы находит контейнер наравне с идентификатором', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@CONTAINERS docker', listing, '@@STRIKE 0', 'edge')
    );

    expect(preview.targets).toHaveLength(1);
  });

  it('один контейнер дважды не показывается', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@CONTAINERS docker', listing, '@@STRIKE 0', '20039a6eb77e', 'edge')
    );

    expect(preview.targets).toHaveLength(1);
  });

  it('нет движка — это не «целей нет», а «спросить нечем»', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@CONTAINERS docker', 'SSH_MCP_NO_TOOL', '@@STRIKE 0', '')
    );

    expect(preview.targets).toEqual([]);
    expect(preview.unavailable).toContain('docker');
  });

  it('раскрытие не нашло ничего — целей нет, и спрашивать было чем', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@CONTAINERS docker', listing, '@@STRIKE 0', '')
    );

    expect(preview.targets).toEqual([]);
    expect(preview.unavailable).toBeUndefined();
  });
});

describe('процессы', () => {
  const strikes = strikesOf('kill $(pgrep -f relay)');

  /** Ответ с одним процессом: слушает 22, несёт одно соединение */
  const answer = reply(
    '@@CLK',
    '100',
    '@@UPTIME',
    '386240.03 6919981.54',
    '@@NET',
    NET_HEADER,
    '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 16634181 1',
    '   2: 050011AC:0016 0141A8C0:96CE 01 00000000:00000000 02:000AFC7C 00000000     0        0 18183334 4',
    '@@STRIKE 0',
    '280',
    '@@PROCS 0',
    '#280 37137694 /usr/sbin/sshd -D -e',
    '16634181',
    '18183334'
  );

  it('процесс назван вместе с тем, что он держит', () => {
    const [preview] = readPreview(strikes, answer);

    expect(preview.targets).toEqual([
      {
        kind: 'process',
        pid: 280,
        command: '/usr/sbin/sshd -D -e',
        age: 14863,
        listening: [22],
        established: 1,
      },
    ]);
  });

  it('заголовок таблицы сокетов записью не считается', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@NET', NET_HEADER, '@@STRIKE 0', '280', '@@PROCS 0', '#280 100 app')
    );

    expect((preview.targets[0] as { listening: number[] }).listening).toEqual([]);
  });

  it('адрес шестого протокола читается наравне', () => {
    const [preview] = readPreview(
      strikes,
      reply(
        '@@CLK',
        '100',
        '@@UPTIME',
        '1000 1000',
        '@@NET',
        '   0: 00000000000000000000000000000000:0948 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 16626284 1',
        '@@STRIKE 0',
        '280',
        '@@PROCS 0',
        '#280 100 app',
        '16626284'
      )
    );

    expect((preview.targets[0] as { listening: number[] }).listening).toEqual([2376]);
  });

  it('один порт дважды не перечисляется', () => {
    const [preview] = readPreview(
      strikes,
      reply(
        '@@CLK',
        '100',
        '@@NET',
        '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 111 1',
        '   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1',
        '@@STRIKE 0',
        '280',
        '@@PROCS 0',
        '#280 100 app',
        '111',
        '222'
      )
    );

    expect((preview.targets[0] as { listening: number[] }).listening).toEqual([22]);
  });

  it('без времени работы машины возраст не выдумывается', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@STRIKE 0', '280', '@@PROCS 0', '#280 37137694 app')
    );

    expect((preview.targets[0] as { age: number | null }).age).toBeNull();
  });

  it('без отметки старта возраст не выдумывается', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@UPTIME', '1000 1000', '@@STRIKE 0', '280', '@@PROCS 0', '#280  app')
    );

    expect((preview.targets[0] as { age: number | null }).age).toBeNull();
  });

  // Частота таймера у машины своя; по умолчанию берётся сотня, но сказанное машиной сильнее
  it('частота таймера берётся у машины', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '1000', '@@UPTIME', '1000 1000', '@@STRIKE 0', '280', '@@PROCS 0', '#280 100000 app')
    );

    expect((preview.targets[0] as { age: number }).age).toBe(900);
  });

  it('машина промолчала о частоте — берётся сотня', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '', '@@UPTIME', '1000 1000', '@@STRIKE 0', '280', '@@PROCS 0', '#280 10000 app')
    );

    expect((preview.targets[0] as { age: number }).age).toBe(900);
  });

  it('процесс без открытых сокетов показывается пустым, а не пропускается', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@UPTIME', '1000 1000', '@@STRIKE 0', '280', '@@PROCS 0', '#280 100 app')
    );

    expect(preview.targets).toHaveLength(1);
    expect((preview.targets[0] as { established: number }).established).toBe(0);
  });

  it('несколько процессов разделяются по своим заголовкам', () => {
    const [preview] = readPreview(
      strikes,
      reply(
        '@@CLK',
        '100',
        '@@UPTIME',
        '1000 1000',
        '@@NET',
        '   2: 050011AC:0016 0141A8C0:96CE 01 00000000:00000000 02:000AFC7C 00000000     0        0 555 4',
        '@@STRIKE 0',
        '280 400',
        '@@PROCS 0',
        '#280 100 first',
        '555',
        '#400 100 second'
      )
    );

    expect(preview.targets).toHaveLength(2);
    expect((preview.targets[0] as { established: number }).established).toBe(1);
    expect((preview.targets[1] as { established: number }).established).toBe(0);
  });
});

describe('машина отвечает не тем, чего ждали', () => {
  const strikes = strikesOf('kill $(pgrep -f app)');

  it('строка сокетов не той длины записью не считается', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@NET', '   1: 00000000:0016 0A', '@@STRIKE 0', '280', '@@PROCS 0', '#280 100 app')
    );

    expect((preview.targets[0] as { listening: number[] }).listening).toEqual([]);
  });

  it('порт, который не число, пропускается', () => {
    const [preview] = readPreview(
      strikes,
      reply(
        '@@CLK',
        '100',
        '@@NET',
        '   1: 00000000:zzzz 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 777 1',
        '@@STRIKE 0',
        '280',
        '@@PROCS 0',
        '#280 100 app',
        '777'
      )
    );

    expect((preview.targets[0] as { listening: number[] }).listening).toEqual([]);
  });

  it('сокет без своего процесса ничего не ломает', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@NET', NET_HEADER, '@@STRIKE 0', '280', '@@PROCS 0', '999999', '#280 100 app')
    );

    expect(preview.targets).toHaveLength(1);
  });

  it('незнакомый сокет процессу не приписывается', () => {
    const [preview] = readPreview(
      strikes,
      reply(
        '@@CLK',
        '100',
        '@@NET',
        '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 111 1',
        '@@STRIKE 0',
        '280',
        '@@PROCS 0',
        '#280 100 app',
        '222'
      )
    );

    expect((preview.targets[0] as { listening: number[] }).listening).toEqual([]);
  });

  it('строка без решётки заголовком процесса не становится', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@STRIKE 0', '280', '@@PROCS 0', '280 100 app')
    );

    expect(preview.targets).toEqual([]);
  });

  it('нечисловая отметка старта возраста не даёт', () => {
    const [preview] = readPreview(
      strikes,
      reply('@@CLK', '100', '@@UPTIME', 'нет', '@@STRIKE 0', '280', '@@PROCS 0', '#280 100 app')
    );

    expect((preview.targets[0] as { age: number | null }).age).toBeNull();
  });

  it('строка листинга без всех колонок контейнером не считается', () => {
    const [preview] = readPreview(
      strikesOf('docker kill $(docker ps -q)'),
      reply('@@CLK', '100', '@@CONTAINERS docker', 'abc|edge|web', '@@STRIKE 0', 'abc')
    );

    expect(preview.targets).toEqual([]);
  });
});

describe('удар, которому нечем раскрыться', () => {
  it('назван отдельно от «целей нет»', () => {
    const [preview] = readPreview(strikesOf('kill $PID'), reply('@@CLK', '100'));

    expect(preview.targets).toEqual([]);
    expect(preview.unavailable).toContain('nothing to expand');
  });

  it('разбор соседей от этого не страдает', () => {
    const strikes = strikesOf('kill $PID; pkill -f relay');
    const previews = readPreview(
      strikes,
      reply('@@CLK', '100', '@@UPTIME', '1000 1000', '@@STRIKE 1', '280', '@@PROCS 1', '#280 100 relay')
    );

    expect(previews[0].unavailable).toBeDefined();
    expect(previews[1].targets).toHaveLength(1);
  });
});
