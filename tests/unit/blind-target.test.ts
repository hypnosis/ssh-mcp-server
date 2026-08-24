/**
 * Unit tests: удар по названной цели и удар вслепую
 *
 * Цена ошибки несимметрична в обе стороны. Пропустить слепой удар — потерять
 * работающий сервис, о котором агент не знал. Задержать названный — сделать
 * ежедневную остановку контейнера поводом для обряда, после которого маркер
 * перестают читать.
 *
 * Поэтому у каждой пары проверяются оба конца: `docker stop web-1` молчит,
 * `docker stop $(docker ps -q)` — нет.
 */

import { describe, it, expect } from 'vitest';
import { findBlindStrikes } from '../../src/utils/blind-target.js';

/** Один удар или ничего — для случаев, где ожидается ровно один */
const one = (command: string) => {
  const strikes = findBlindStrikes(command);
  expect(strikes).toHaveLength(1);
  return strikes[0];
};

describe('названная цель проходит молча', () => {
  it.each([
    'docker kill web-1',
    'docker stop web-1 web-2',
    'docker rm -f old-worker',
    'docker restart gateway',
    'podman stop registry',
    'docker compose down',
    'docker compose stop api',
    'kill 49210',
    'kill -9 49210 49211',
    'pkill nginx',
    'killall nginx',
    'systemctl stop app.service',
    'systemctl restart app',
    'service nginx stop',
  ])('%s', (command) => {
    expect(findBlindStrikes(command)).toEqual([]);
  });
});

describe('глаголы контейнера: каждый под своим тестом', () => {
  // Список перечислен целиком: мутация «убрать один глагол» иначе проходит молча
  it.each(['kill', 'stop', 'rm', 'restart'])('docker %s вслепую', (verb) => {
    const strike = one(`docker ${verb} $(docker ps -q)`);
    expect(strike.verb).toBe(`docker ${verb}`);
    expect(strike.subject).toBe('container');
  });

  it.each(['kill', 'stop', 'rm', 'restart', 'down'])('docker compose %s вслепую', (verb) => {
    const strike = one(`docker compose ${verb} $(cat services.txt)`);
    expect(strike.verb).toBe(`docker compose ${verb}`);
  });

  it('цель проекта не первым словом находится наравне', () => {
    expect(one('docker compose stop api $(cat extra.txt)').probe).toBe('cat extra.txt');
  });

  it('названный проект проходит молча', () => {
    expect(findBlindStrikes('docker-compose down')).toEqual([]);
  });

  it('podman судится наравне с docker', () => {
    expect(one('podman kill $(podman ps -q)').verb).toBe('podman kill');
  });

  it('docker-compose отдельной программой — тот же разбор', () => {
    expect(one('docker-compose stop $(cat services.txt)').verb).toBe('docker-compose stop');
  });

  it('чтение контейнера ударом не считается', () => {
    expect(findBlindStrikes('docker logs $(docker ps -q)')).toEqual([]);
    expect(findBlindStrikes('docker inspect $(docker ps -q)')).toEqual([]);
  });
});

describe('глаголы юнита: каждый под своим тестом', () => {
  it.each(['stop', 'restart', 'kill', 'disable', 'mask'])('systemctl %s вслепую', (verb) => {
    const strike = one(`systemctl ${verb} 'worker@*'`);
    expect(strike.verb).toBe(`systemctl ${verb}`);
    expect(strike.subject).toBe('unit');
  });

  it('service называет глагол последним словом', () => {
    expect(one('service $UNIT stop').verb).toBe('service stop');
  });

  it('чтение состояния ударом не считается', () => {
    expect(findBlindStrikes('systemctl status $(cat unit.txt)')).toEqual([]);
  });
});

describe('снятие процесса', () => {
  it.each(['kill', 'pkill', 'killall'])('%s с подстановкой', (verb) => {
    const strike = one(`${verb} $(pgrep -f worker)`);
    expect(strike.subject).toBe('process');
  });

  it('поиск по командной строке — цель, которой ещё нет', () => {
    const strike = one('pkill -f relay');
    expect(strike.kind).toBe('pattern');
    expect(strike.probe).toBe('pgrep -a -f relay');
  });

  it('длинная форма того же флага', () => {
    expect(one('pkill --full relay').kind).toBe('pattern');
  });

  it('флаг, слитый с сигналом, читается наравне', () => {
    expect(one('pkill -9f relay').kind).toBe('pattern');
  });

  it.each(['pkill -f relay', 'pkill --full relay', 'kill $(pgrep -f relay)'])(
    'образец по всей строке совпадает с самой командой: %s',
    (command) => {
      expect(one(command).selfMatching).toBe(true);
    }
  );

  it.each(['pkill -s 100 $(cat pids)', 'kill $(pgrep relay)', 'killall -r "py.*"'])(
    'поиск по имени с командой не совпадает: %s',
    (command) => {
      expect(one(command).selfMatching).toBe(false);
    }
  );

  it('снятие по имени процесса цель называет', () => {
    expect(findBlindStrikes('pkill nginx')).toEqual([]);
  });

  it.each(['-r', '--regexp'])('killall %s — выражение, а не имя', (flag) => {
    const strike = one(`killall ${flag} "py.*"`);
    expect(strike.kind).toBe('pattern');
  });

  it('шаблон в пробе остаётся одним словом', () => {
    expect(one('killall -r "py.*"').probe).toBe("pgrep -a 'py.*'");
  });

  it('шаблон pkill сохраняет кавычки, с которыми был написан', () => {
    expect(one("pkill -f 'app/relay worker'").probe).toBe("pgrep -a -f 'app/relay worker'");
  });

  it('номер сигнала в пробу не едет', () => {
    expect(one('pkill -9 -f relay').probe).toBe('pgrep -a -f relay');
  });

  it('сигнал по имени уезжает вместе со своим значением', () => {
    expect(one('pkill --signal TERM -f relay').probe).toBe('pgrep -a -f relay');
  });

  // `-s` у pkill выбирает сессию, а не сигнал: выбросить его — расширить поиск
  it('селектор сессии в пробе остаётся', () => {
    expect(one('pkill -s 100 -f relay').probe).toBe('pgrep -a -s 100 -f relay');
  });

  it('подстановка внутри образца доезжает до пробы целой', () => {
    expect(one('pkill -f "$(cat pattern.txt)"').probe).toBe('pgrep -a -f "$(cat pattern.txt)"');
  });

  it('скобка внутри образца подстановкой не становится', () => {
    expect(one("pkill -f 'app(worker)'").probe).toBe("pgrep -a -f 'app(worker)'");
  });

  it('выражение без образца раскрывать нечем', () => {
    expect(one('killall -r').probe).toBeNull();
  });

  it('флаг выражения принадлежит killall, а не pkill', () => {
    expect(findBlindStrikes('pkill -s 100 worker')).toEqual([]);
  });

  // Длинный флаг несёт те же буквы, что короткий: `--force` не делает поиск полным
  it('буква внутри длинного флага коротким флагом не становится', () => {
    expect(findBlindStrikes('pkill --force worker')).toEqual([]);
  });

  it('слово без дефиса флагом не считается', () => {
    expect(findBlindStrikes('pkill f')).toEqual([]);
  });
});

describe('чем цель раскрывается', () => {
  it('подстановка становится пробой как есть', () => {
    expect(one('docker kill $(docker ps -q --filter ancestor=app)').probe).toBe(
      'docker ps -q --filter ancestor=app'
    );
  });

  it('обратные кавычки — та же подстановка', () => {
    const strike = one('docker kill `docker ps -q`');
    expect(strike.kind).toBe('expansion');
    expect(strike.probe).toBe('docker ps -q');
  });

  it('разделитель внутри подстановки её не разрезает', () => {
    expect(one('kill $(pgrep -f app | head -1)').probe).toBe('pgrep -f app | head -1');
  });

  it('вложенная скобка не обрывает подстановку', () => {
    expect(one('kill $(pgrep -f $(cat name.txt))').probe).toBe('pgrep -f $(cat name.txt)');
  });

  it('переменной раскрыться нечем — это отказ, а не проба', () => {
    const strike = one('kill $PID');
    expect(strike.kind).toBe('expansion');
    expect(strike.probe).toBeNull();
  });

  it('незакрытая подстановка названной цели не даёт — раскрывать нечем', () => {
    expect(one('docker kill $(docker ps -q').probe).toBeNull();
  });

  it('шаблону имени юнита раскрыться нечем', () => {
    expect(one("systemctl stop 'worker@*'").probe).toBeNull();
  });
});

describe('кавычки решают, раскроется ли цель', () => {
  it('двойные кавычки подстановку не прячут', () => {
    expect(one('docker kill "$(docker ps -q)"').probe).toBe('docker ps -q');
  });

  it('одинарная кавычка внутри двойных кавычкой не работает', () => {
    const strikes = findBlindStrikes(`echo "it's fine"; docker kill $(docker ps -q)`);
    expect(strikes).toHaveLength(1);
  });

  it('закрытая одинарная кавычка разбор дальше не глушит', () => {
    const strikes = findBlindStrikes("echo 'ready'; pkill -f relay");
    expect(strikes).toHaveLength(1);
  });

  it('двойная кавычка внутри одинарных кавычкой не работает', () => {
    const strikes = findBlindStrikes(`echo 'say "no"'; docker kill $(docker ps -q)`);
    expect(strikes).toHaveLength(1);
  });

  it('обратные кавычки внутри одинарных остаются текстом', () => {
    expect(findBlindStrikes("echo '`docker ps -q`'")).toEqual([]);
  });

  // Ответ подстановки — не цель целиком: к нему приклеен текст, и что выйдет
  // после склейки, знает только сервер
  it('подстановка, склеенная с текстом, раскрытию не поддаётся', () => {
    const strike = one('docker kill "prefix-$(cat name.txt)"');
    expect(strike.kind).toBe('expansion');
    expect(strike.probe).toBeNull();
  });
});

describe('одинарные кавычки — единственное, что прячет подстановку', () => {
  // Набор форм разом: любая поломка разбора кавычек гасит хотя бы одну из них
  // Проверяется проба, а не факт удара: сломанный разбор кавычек оставляет
  // удар на месте, но лишает его раскрытия — и слабое ожидание этого не видит
  it.each([
    ['docker kill $(docker ps -q)', 'docker ps -q'],
    ['docker kill "$(docker ps -q)"', 'docker ps -q'],
    ['echo "a"; docker kill $(docker ps -q)', 'docker ps -q'],
    ["echo 'a'; docker kill $(docker ps -q)", 'docker ps -q'],
    ['echo ""; docker kill $(docker ps -q)', 'docker ps -q'],
    ["echo ''; docker kill $(docker ps -q)", 'docker ps -q'],
    [`echo "it's"; docker kill $(docker ps -q)`, 'docker ps -q'],
    [`echo 'say "no"'; docker kill $(docker ps -q)`, 'docker ps -q'],
    ['kill $(pgrep -f "my app")', 'pgrep -f "my app"'],
    ["kill $(pgrep -f 'my app')", "pgrep -f 'my app'"],
    ['docker kill `docker ps -q`', 'docker ps -q'],
    ['echo "a" && docker kill `docker ps -q`', 'docker ps -q'],
  ])('%s', (command, probe) => {
    expect(one(command).probe).toBe(probe);
  });

  it.each([
    "echo '$(docker ps -q)'",
    "echo '`docker ps -q`'",
    "git commit -m 'docker kill $(docker ps -q)'",
  ])('спрятано: %s', (command) => {
    expect(findBlindStrikes(command)).toEqual([]);
  });
});

describe('где удара нет вовсе', () => {
  it('одинарные кавычки подстановку не раскрывают', () => {
    expect(findBlindStrikes("echo '$(docker ps -q)'")).toEqual([]);
  });

  it('слово в тексте сообщения глаголом не становится', () => {
    expect(findBlindStrikes('git commit -m "kill $(date)"')).toEqual([]);
  });
});

describe('комментарий разбору не мешает', () => {
  it('подтверждение в аргументы цели не попадает', () => {
    expect(one('pkill -f relay # CONFIRMED-KILL: 4871').probe).toBe('pgrep -a -f relay');
  });

  it('решётка внутри слова комментария не открывает', () => {
    expect(one('pkill -f app#1').probe).toBe('pgrep -a -f app#1');
  });

  it('решётка в кавычках остаётся частью образца', () => {
    expect(one("pkill -f 'app #1'").probe).toBe("pgrep -a -f 'app #1'");
  });

  it('комментарий гасит только свою строку', () => {
    const strikes = findBlindStrikes('echo start # note\npkill -f relay');

    expect(strikes).toHaveLength(1);
    expect(strikes[0].probe).toBe('pgrep -a -f relay');
  });

  it('команда целиком в комментарии ударом не считается', () => {
    expect(findBlindStrikes('# pkill -f relay')).toEqual([]);
  });
});

describe('обёртки и склейка', () => {
  it.each(['sudo', 'env', 'nohup', 'time'])('%s глагол не прячет', (wrapper) => {
    expect(one(`${wrapper} docker kill $(docker ps -q)`).verb).toBe('docker kill');
  });

  // Правило «пара в коде — тест на оба элемента»: удар может стоять не первым
  it('оба удара в склеенной строке находятся, а не только первый', () => {
    const strikes = findBlindStrikes(
      "docker kill $(docker ps -q --filter ancestor=app) 2>/dev/null; " +
        "kill $(pgrep -f 'app/relay') 2>/dev/null; sleep 1; ss -lntp || echo done"
    );

    expect(strikes.map((strike) => strike.verb)).toEqual(['docker kill', 'kill']);
    expect(strikes[1].probe).toBe("pgrep -f 'app/relay'");
  });

  it('удар после диагностики находится наравне с первым', () => {
    const strikes = findBlindStrikes('ss -lntp && pkill -f relay');
    expect(strikes).toHaveLength(1);
  });

  it('подстановка вторым аргументом находится наравне с первым', () => {
    expect(one('docker stop web-1 $(docker ps -q)').probe).toBe('docker ps -q');
  });

  // Плейсхолдер подстановки не должен совпадать с обычным словом команды
  it('число аргументом подстановкой не притворяется', () => {
    const strikes = findBlindStrikes('kill 0; docker stop $(docker ps -q)');
    expect(strikes.map((strike) => strike.verb)).toEqual(['docker stop']);
  });

  it('команда показывается такой, какой её написали', () => {
    expect(one('docker kill $(docker ps -q)').written).toBe('docker kill $(docker ps -q)');
  });
});
