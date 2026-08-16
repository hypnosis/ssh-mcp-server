/**
 * Unit tests: что считается сносом системы, а что обычной уборкой
 *
 * Цена ошибки несимметрична, поэтому проверяются обе стороны каждой пары:
 * пропустить снос корня нельзя, но и мешать удалять `/tmp/build` — значит
 * сделать инструмент бесполезным, а агента — изобретательным в обходах.
 *
 * Разделение «слэш на конце опасен, без слэша — нет» взято не из головы:
 * замерено на лаборатории, где `rm -rf link/` на coreutils опустошает цель
 * ссылки, а на BusyBox удаляет саму ссылку.
 */

import { describe, it, expect } from 'vitest';
import {
  blockedMessage,
  CONFIRMATION_MARKER,
  classifyTarget,
  findRemovalTargets,
  inspectCommand,
  isConfirmed,
} from '../../src/utils/destructive-command.js';

const HOME = '/home/deploy';

/** Заблокирована ли команда и по какой причине */
const check = (command: string, home = HOME) => inspectCommand(command, home);

describe('classifyTarget: что означает путь', () => {
  it('корень — это корень', () => {
    expect(classifyTarget('/')).toBe('root');
  });

  it('каталог внутри корня корнем не считается', () => {
    expect(classifyTarget('/srv/app')).toBe('safe');
  });

  it('тильда — дом', () => {
    expect(classifyTarget('~')).toBe('home');
  });

  it('домашний каталог узнаётся и по пути из паспорта', () => {
    expect(classifyTarget('/home/deploy', HOME)).toBe('home');
  });

  it('подкаталог дома — обычный путь', () => {
    expect(classifyTarget('/home/deploy/build', HOME)).toBe('safe');
  });

  // Список перечислен целиком нарочно: мутация «убрать один каталог» иначе
  // проходит молча — ровно то, что правило «пара в коде = тест на оба» и ловит
  it.each([
    '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
    '/boot', '/var', '/home', '/root', '/opt', '/srv',
  ])('системное дерево защищено: %s', (dir) => {
    expect(classifyTarget(dir)).toBe('system');
  });

  it('дом узнаётся во всех трёх написаниях', () => {
    expect(classifyTarget('~')).toBe('home');
    expect(classifyTarget('$HOME')).toBe('home');
    expect(classifyTarget('${HOME}')).toBe('home');
  });

  it('путь внутри системного дерева не блокируется целиком', () => {
    expect(classifyTarget('/var/log/app')).toBe('safe');
  });

  it('хвостовые слэши не превращают системный каталог в безопасный', () => {
    expect(classifyTarget('/etc//')).toBe('system');
  });

  it('без паспорта дом узнаётся только по написанию', () => {
    expect(classifyTarget('/home/deploy', '')).toBe('safe');
    expect(classifyTarget('~', '')).toBe('home');
  });
});

describe('findRemovalTargets: где в команде удаление', () => {
  it('простое рекурсивное удаление находится', () => {
    expect(findRemovalTargets('rm -rf /tmp/build').map((t) => t.path)).toEqual(['/tmp/build']);
  });

  it('удаление без рекурсии не считается', () => {
    expect(findRemovalTargets('rm -f /tmp/file')).toEqual([]);
  });

  it('длинная форма флага тоже рекурсия', () => {
    expect(findRemovalTargets('rm --recursive --force /tmp/x')).toHaveLength(1);
  });

  it('флаги врозь читаются так же, как слитые', () => {
    expect(findRemovalTargets('rm -r -f /tmp/x')).toHaveLength(1);
  });

  it('sudo и полный путь до бинарника не прячут команду', () => {
    expect(findRemovalTargets('sudo /bin/rm -rf /tmp/x')).toHaveLength(1);
  });

  it('слово rm внутри текста командой не является', () => {
    expect(findRemovalTargets('echo "rm -rf /" > /tmp/note')).toEqual([]);
  });

  it('команда, чьё имя лишь начинается на rm, за rm не принимается', () => {
    expect(findRemovalTargets('rmdir -r /etc')).toEqual([]);
    expect(findRemovalTargets('rmtool -rf /etc')).toEqual([]);
  });

  it('удаление в цепочке находится наравне с одиночным', () => {
    const targets = findRemovalTargets('cd /tmp && rm -rf /tmp/a; rm -rf /tmp/b');
    expect(targets.map((t) => t.path)).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('несколько целей в одной команде разбираются все', () => {
    expect(findRemovalTargets('rm -rf /tmp/a /tmp/b').map((t) => t.path)).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('кавычки снимаются, путь остаётся путём', () => {
    expect(findRemovalTargets("rm -rf '/tmp/с пробелом'")[0].path).toBe('/tmp/с пробелом');
  });

  it('двойные кавычки читаются наравне с одинарными', () => {
    expect(findRemovalTargets('rm -rf "/tmp/с пробелом"')[0].path).toBe('/tmp/с пробелом');
    expect(findRemovalTargets('rm -rf "/etc"')[0].path).toBe('/etc');
  });

  // Буква «r» в пути или в длинной опции не делает команду рекурсивной:
  // иначе штатное `rm -f /var/run/app.pid` попадало бы под отказ
  it('буква r в пути рекурсией не является', () => {
    expect(findRemovalTargets('rm -f /var/run/app.pid')).toEqual([]);
  });

  it('длинная опция без рекурсии рекурсией не становится', () => {
    expect(findRemovalTargets('rm --force /etc/motd')).toEqual([]);
  });

  it('слэш на конце помечает работу с содержимым', () => {
    expect(findRemovalTargets('rm -rf /tmp/link/')[0].followsLink).toBe(true);
  });

  it('без слэша содержимое не затрагивается', () => {
    expect(findRemovalTargets('rm -rf /tmp/link')[0].followsLink).toBe(false);
  });

  it('звёздочка в хвосте — то же, что слэш', () => {
    const target = findRemovalTargets('rm -rf /tmp/link/*')[0];
    expect(target.followsLink).toBe(true);
    expect(target.path).toBe('/tmp/link');
  });

  it('переменная помечается как раскрываемая сервером', () => {
    expect(findRemovalTargets('rm -rf "$DIR"')[0].expandable).toBe(true);
  });

  it('литеральный путь раскрываемым не считается', () => {
    expect(findRemovalTargets('rm -rf /tmp/build')[0].expandable).toBe(false);
  });

  it('разделитель `--` за цель не принимается', () => {
    expect(findRemovalTargets('rm -rf -- /tmp/x').map((t) => t.path)).toEqual(['/tmp/x']);
  });
});

describe('inspectCommand: отказ или проход', () => {
  it('снос корня останавливается', () => {
    const verdict = check('rm -rf /');
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('filesystem root');
  });

  it('снос содержимого корня останавливается тоже', () => {
    expect(check('rm -rf /*').blocked).toBe(true);
  });

  it('снос дома по тильде останавливается', () => {
    expect(check('rm -rf ~').blocked).toBe(true);
  });

  it('снос дома по настоящему пути останавливается', () => {
    expect(check('rm -rf /home/deploy').blocked).toBe(true);
  });

  it('снос системного дерева останавливается', () => {
    const verdict = check('rm -rf /etc');
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('a system directory');
  });

  it('снос дома называет причину домом, а не общими словами', () => {
    expect(check('rm -rf ~').reason).toContain('the home directory');
  });

  it('закавыченный системный путь останавливается так же, как голый', () => {
    expect(check('rm -rf "/etc"').blocked).toBe(true);
  });

  // Рекурсивный chown или chmod по системному дереву — не наше дело:
  // проверка обязана срабатывать на rm, а не на любой команде с флагом -R
  it('другая команда с рекурсивным флагом не задерживается', () => {
    expect(check('chown -R deploy /etc').blocked).toBe(false);
    expect(check('chmod -R 755 /var').blocked).toBe(false);
  });

  it('обычная уборка проходит', () => {
    const verdict = check('rm -rf /tmp/build');
    expect(verdict.blocked).toBe(false);
    expect(verdict.needsResolution).toEqual([]);
  });

  it('путь со слэшем уходит на проверку резолвом, а не пропускается', () => {
    const verdict = check('rm -rf /srv/app/data/');
    expect(verdict.blocked).toBe(false);
    expect(verdict.needsResolution.map((t) => t.path)).toEqual(['/srv/app/data']);
  });

  it('путь без слэша проверять на сервере незачем', () => {
    expect(check('rm -rf /srv/app/data').needsResolution).toEqual([]);
  });

  it('раскрываемая сервером цель — это «проверить нечем», а не «можно»', () => {
    const verdict = check('rm -rf "$DIR"/*');
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('expanded by the server');
    // Причина обязана объяснять, ПОЧЕМУ отказ, иначе агент читает её как каприз
    expect(verdict.reason).toContain('cannot be checked before the command runs');
  });

  it('без паспорта дом узнаётся только по тильде', () => {
    // Вызов без второго аргумента — путь, на котором дом неизвестен. Тильда
    // говорит сама за себя, а `/home/deploy` от обычного каталога неотличим
    expect(inspectCommand('rm -rf ~').blocked).toBe(true);
    expect(inspectCommand('rm -rf /home/deploy').blocked).toBe(false);
  });

  it('опасная команда в середине батча не теряется', () => {
    expect(check('cd /srv && rm -rf /etc && echo done').blocked).toBe(true);
  });

  it('маркер снимает отказ', () => {
    expect(check(`rm -rf / ${CONFIRMATION_MARKER}`).blocked).toBe(false);
  });

  it('без маркера та же команда отклоняется', () => {
    expect(check('rm -rf /').blocked).toBe(true);
  });

  it('команда без удаления вообще не задерживается', () => {
    const verdict = check('systemctl restart nginx');
    expect(verdict.blocked).toBe(false);
    expect(verdict.needsResolution).toEqual([]);
  });
});

describe('blockedMessage: что агент прочитает в отказе', () => {
  const message = blockedMessage('  rm -rf /etc  ', '"/etc" is a system directory');

  it('сказано, что команда не выполнена', () => {
    expect(message).toContain('NOT executed');
  });

  it('названа причина', () => {
    expect(message).toContain('a system directory');
  });

  it('показан готовый способ подтвердить: команда и маркер', () => {
    expect(message).toContain(`rm -rf /etc ${CONFIRMATION_MARKER}`);
  });
});

describe('isConfirmed: маркер подтверждения', () => {
  it('маркер узнаётся', () => {
    expect(isConfirmed(`rm -rf /var ${CONFIRMATION_MARKER}`)).toBe(true);
  });

  it('похожий текст маркером не является', () => {
    expect(isConfirmed('rm -rf /var # confirmed')).toBe(false);
  });
});
