/**
 * Unit tests: что читает агент вместо выполненного удара
 *
 * Отказ проверяется как текст, потому что текстом он и работает: список
 * целей с признаками жизни — это то знание, которого у вызывающего не было,
 * когда он писал команду. «Вы уверены?» такого знания не несёт, и его
 * проходят не читая.
 *
 * Подтверждение сверяется с фактом, а не с формой команды: назвать можно
 * что угодно, а под удар попадает то, что попадает.
 */

import { describe, it, expect } from 'vitest';
import { findBlindStrikes } from '../../src/utils/blind-target.js';
import {
  judgeStrikes,
  readConfirmedNames,
  shieldPattern,
  KILL_MARKER,
} from '../../src/utils/strike-refusal.js';
import type { StrikePreview } from '../../src/utils/strike-preview-parse.js';

const strike = (command: string) => findBlindStrikes(command)[0];

/** Показ с одним контейнером */
const container = (name: string, status = 'Up 34 days'): StrikePreview => ({
  strike: strike('docker kill $(docker ps -q)'),
  targets: [{ kind: 'container', name, image: 'web:latest', status, ports: '0.0.0.0:8443->8443/tcp' }],
});

/** Показ с одним процессом */
const process = (pid: number, extra: Partial<{ age: number; listening: number[]; established: number }> = {}): StrikePreview => ({
  strike: strike('kill $(cat /run/relay.pid)'),
  targets: [
    {
      kind: 'process',
      pid,
      command: '/opt/app/relay --port 8080',
      age: extra.age ?? 518400,
      listening: extra.listening ?? [8080],
      established: extra.established ?? 3,
    },
  ],
});

describe('маркер подтверждения', () => {
  it('имена читаются через запятую', () => {
    expect(readConfirmedNames(`docker kill edge ${KILL_MARKER} edge, api`)).toEqual(['edge', 'api']);
  });

  it('маркера нет — и подтверждения нет', () => {
    expect(readConfirmedNames('docker kill edge')).toBeNull();
  });

  it('маркер без имён подтверждением не считается', () => {
    expect(readConfirmedNames(`docker kill edge ${KILL_MARKER}`)).toBeNull();
    expect(readConfirmedNames(`docker kill edge ${KILL_MARKER}   `)).toBeNull();
  });

  it('лишние пробелы имена не портят', () => {
    expect(readConfirmedNames(`x ${KILL_MARKER}  edge ,  api `)).toEqual(['edge', 'api']);
  });
});

describe('отказ без подтверждения', () => {
  it('называет цель, а не только запрет', () => {
    const text = judgeStrikes([container('edge')], null) ?? '';

    expect(text).toContain('edge');
    expect(text).toContain('web:latest');
    expect(text).toContain('Up 34 days');
    expect(text).toContain('0.0.0.0:8443->8443/tcp');
  });

  it('у процесса показывает всё, что делает его живым', () => {
    const text = judgeStrikes([process(4871)], null) ?? '';

    expect(text).toContain('4871');
    expect(text).toContain('/opt/app/relay --port 8080');
    expect(text).toContain('running 6d');
    expect(text).toContain('listening on 8080');
    expect(text).toContain('3 connection(s) open');
  });

  it('дорога дальше — назвать имена, а не поставить метку', () => {
    const text = judgeStrikes([container('edge')], null) ?? '';

    expect(text).toContain(`${KILL_MARKER} edge`);
  });

  // Совет «разрежь на список» проблему не решает: массив ведёт себя так же
  it('о форме вызова отказ не рассуждает', () => {
    const text = judgeStrikes([container('edge')], null) ?? '';

    expect(text).not.toContain('array');
    expect(text).not.toContain('separate call');
  });

  it('контейнер останавливают, процессу шлют сигнал — и сказано это по-разному', () => {
    expect(judgeStrikes([container('edge')], null)).toContain('would stop');
    expect(judgeStrikes([process(4871)], null)).toContain('would signal');
  });

  it('несколько ударов перечисляются вместе', () => {
    const text = judgeStrikes([container('edge'), process(4871)], null) ?? '';

    expect(text).toContain('edge');
    expect(text).toContain('4871');
  });
});

describe('три исхода не смешиваются', () => {
  it('спросить было нечем — так и сказано', () => {
    const text =
      judgeStrikes(
        [{ strike: strike('docker kill $(docker ps -q)'), targets: [], unavailable: 'docker is not on the machine' }],
        null
      ) ?? '';

    expect(text).toContain('cannot be established');
    expect(text).toContain('docker is not on the machine');
  });

  it('раскрытие не нашло ничего — это тоже отказ, но другой', () => {
    const text = judgeStrikes([{ strike: strike('docker kill $(docker ps -q)'), targets: [] }], null) ?? '';

    expect(text).toContain('reaches nothing');
    expect(text).not.toContain('cannot be established');
  });

  // Пустое раскрытие — ровно то, что спасло цель случайно: маска не совпала,
  // команда упала, а следующая в строке отработала
  it('пустое раскрытие подтверждением не открывается', () => {
    const previews = [{ strike: strike('docker kill $(docker ps -q)'), targets: [] }];

    expect(judgeStrikes(previews, ['edge'])).not.toBeNull();
  });
});

describe('подтверждение сверяется с фактом', () => {
  it('назвал всех — удар проходит', () => {
    expect(judgeStrikes([container('edge')], ['edge'])).toBeNull();
  });

  it('под удар попал не названный — отказ', () => {
    const text = judgeStrikes([container('edge')], ['api']) ?? '';

    expect(text).toContain('not named: edge');
  });

  it('назвал того, кого удар не достаёт — тоже отказ', () => {
    const text = judgeStrikes([container('edge')], ['edge', 'api']) ?? '';

    expect(text).toContain('not reached: api');
  });

  // Расхождение бывает односторонним: сказать надо ровно про ту сторону, что разошлась
  it('лишнее имя о непоименованных не выдумывает', () => {
    expect(judgeStrikes([container('edge')], ['edge', 'api'])).not.toContain('not named');
  });

  it('непоименованный о лишних не выдумывает', () => {
    expect(judgeStrikes([container('edge')], ['api'])).not.toContain('not reached: edge');
  });

  it('расхождение показывает список целей заново', () => {
    expect(judgeStrikes([container('edge')], ['api'])).toContain('web:latest');
  });

  it('порядок имён значения не имеет', () => {
    const previews = [container('edge'), process(4871)];

    expect(judgeStrikes(previews, ['4871', 'edge'])).toBeNull();
  });

  it('процесс называется своим номером', () => {
    expect(judgeStrikes([process(4871)], ['4871'])).toBeNull();
    expect(judgeStrikes([process(4871)], ['relay'])).not.toBeNull();
  });
});

describe('образец, который совпадает с самой командой', () => {
  /** Показ для удара по строке: такой образец написан внутри команды, что его несёт */
  const byPattern = (pid: number): StrikePreview => ({
    strike: strike('pkill -f relay'),
    targets: [
      { kind: 'process', pid, command: '/opt/app/relay', age: 100, listening: [], established: 0 },
    ],
  });

  it('маркером не открывается — оболочка умрёт раньше цели', () => {
    expect(judgeStrikes([byPattern(4871)], ['4871'])).not.toBeNull();
  });

  it('дорог две: номера и образец, который себя не задевает', () => {
    const text = judgeStrikes([byPattern(4871)], null) ?? '';

    expect(text).toContain('kill 4871');
    expect(text).toContain("pkill -f '[r]elay'");
    expect(text).toContain(`${KILL_MARKER} 4871`);
  });

  it('причина названа, а не только запрет', () => {
    expect(judgeStrikes([byPattern(4871)], null)).toContain('matches the command that carries it');
  });

  it('цели показываются и здесь', () => {
    expect(judgeStrikes([byPattern(4871)], null)).toContain('/opt/app/relay');
  });

  it('поиск по строке через подстановку — то же самое', () => {
    const preview: StrikePreview = {
      strike: strike('kill $(pgrep -f relay)'),
      targets: [{ kind: 'process', pid: 700, command: 'relay', age: 10, listening: [], established: 0 }],
    };

    expect(judgeStrikes([preview], ['700'])).toContain('matches the command');
  });

  // Один знак в классе рвёт совпадение с собственной командой, но не с целью
  it('прикрытый образец подтверждением открывается', () => {
    const preview: StrikePreview = {
      strike: strike("pkill -f '[r]elay'"),
      targets: [{ kind: 'process', pid: 4871, command: '/opt/app/relay', age: 10, listening: [], established: 0 }],
    };

    expect(judgeStrikes([preview], ['4871'])).toBeNull();
  });

  it('поиск по имени процесса командой не прикрывается', () => {
    const preview: StrikePreview = {
      strike: strike('kill $(pgrep relay)'),
      targets: [{ kind: 'process', pid: 700, command: 'relay', age: 10, listening: [], established: 0 }],
    };

    expect(judgeStrikes([preview], ['700'])).toBeNull();
  });
});

describe('прикрытие образца', () => {
  it.each([
    ['relay', '[r]elay'],
    ['/opt/app/relay', '[/]opt/app/relay'],
    ['9worker', '[9]worker'],
    ['.hidden', '[.]hidden'],
  ])('%s прикрывается как %s', (pattern, shielded) => {
    expect(shieldPattern(pattern)).toBe(shielded);
  });

  it.each([null, '', '^relay', '(relay)'])('прикрыть нечем: %s', (pattern) => {
    expect(shieldPattern(pattern)).toBeNull();
  });

  it('прикрытый образец с самой командой уже не совпадает', () => {
    const shielded = shieldPattern('relay') ?? '';
    const command = `pkill -f '${shielded}'`;

    expect(new RegExp(shielded).test(command)).toBe(false);
    expect(new RegExp(shielded).test('/opt/app/relay --port 8080')).toBe(true);
  });
});

describe('признаки, которых нет, не выдумываются', () => {
  it('контейнер без опубликованных портов так и назван', () => {
    const preview: StrikePreview = {
      strike: strike('docker kill $(docker ps -q)'),
      targets: [{ kind: 'container', name: 'job', image: 'batch:1', status: 'Up 2 hours', ports: '' }],
    };

    expect(judgeStrikes([preview], null)).toContain('no published ports');
  });

  it('процесс без соединений о соединениях не докладывает', () => {
    const text = judgeStrikes([process(700, { established: 0, listening: [] })], null) ?? '';

    expect(text).not.toContain('connection(s) open');
    expect(text).not.toContain('listening on');
  });

  it('возраст, которого машина не сказала, не показывается', () => {
    const preview: StrikePreview = {
      strike: strike('kill $(cat /run/relay.pid)'),
      targets: [{ kind: 'process', pid: 700, command: 'relay', age: null, listening: [], established: 0 }],
    };

    expect(judgeStrikes([preview], null)).not.toContain('running 0s');
  });

  it('командной строки нет — так и сказано, а не пусто', () => {
    const preview: StrikePreview = {
      strike: strike('kill $(cat /run/relay.pid)'),
      targets: [{ kind: 'process', pid: 700, command: '', age: null, listening: [], established: 0 }],
    };

    expect(judgeStrikes([preview], null)).toContain('command line unavailable');
  });

  // Границы проверяются с обеих сторон: мутация «сдвинуть порог» иначе выживает
  it.each([
    [0, '0s'],
    [30, '30s'],
    [59, '59s'],
    [60, '1m'],
    [90, '1m'],
    [3599, '59m'],
    [3600, '1h'],
    [7200, '2h'],
    [86399, '23h'],
    [86400, '1d'],
    [518400, '6d'],
  ])('возраст %s секунд читается как %s', (age, said) => {
    expect(judgeStrikes([process(700, { age })], null)).toContain(`running ${said}`);
  });
});
