/**
 * Протокол фоновой задачи: сборка команд и разбор ответов.
 *
 * Формы команд здесь сверяются с тем, что замерено на серверах: `--` в `kill`
 * не пишется вовсе, позиция чтения считается от единицы, а уборка судит по
 * записанному времени старта, а не по `find -mtime`.
 */

import { describe, it, expect } from 'vitest';
import {
  assertJobId,
  buildKillCommand,
  buildListCommand,
  buildOutputCommand,
  buildStartCommand,
  buildStatusCommand,
  createJobId,
  jobPaths,
  jobsRoot,
  JOB_TTL_SEC,
  parseJobKill,
  parseJobList,
  parseJobOutput,
  parseJobStart,
  parseJobStatus,
} from '../../src/utils/job-command.js';

describe('Идентификатор задачи', () => {
  it('состоит из букв, цифр и дефиса', () => {
    expect(createJobId()).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
  });

  it('не повторяется', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createJobId()));
    expect(ids.size).toBe(50);
  });

  it('свой идентификатор проходит проверку', () => {
    const id = createJobId();
    expect(assertJobId(id)).toBe(id);
  });

  it.each([
    ['выход из каталога', '..'],
    ['разделитель пути', 'a/b'],
    ['абсолютный путь', '/etc/passwd'],
    ['пробел', 'a b'],
    ['подстановка', '$(id)'],
    ['шаблон', 'a*'],
    ['перевод строки', 'a\nb'],
    ['пустой', ''],
    ['ведущий дефис', '-rf'],
    ['точка', '.'],
  ])('отклоняет чужой идентификатор: %s', (_name, id) => {
    expect(() => assertJobId(id)).toThrow(/Invalid job id/);
  });

  it('отклоняет не строку', () => {
    expect(() => assertJobId(42)).toThrow(/Invalid job id/);
    expect(() => assertJobId(undefined)).toThrow(/Invalid job id/);
  });

  it('отклоняет слишком длинный', () => {
    expect(() => assertJobId('a'.repeat(65))).toThrow(/Invalid job id/);
    expect(assertJobId('a'.repeat(64))).toHaveLength(64);
  });
});

describe('Пути задачи', () => {
  it('лежат в .ssh-mcp/jobs внутри дома', () => {
    const { root, dir } = jobPaths('/home/deploy', 'abc-1');
    expect(root).toBe('/home/deploy/.ssh-mcp/jobs');
    expect(dir).toBe('/home/deploy/.ssh-mcp/jobs/abc-1');
  });

  it('не удваивают разделитель при доме со слэшем на конце', () => {
    expect(jobPaths('/root/', 'abc-1').dir).toBe('/root/.ssh-mcp/jobs/abc-1');
  });

  it('отказывают, когда дом неизвестен', () => {
    expect(() => jobPaths('', 'abc-1')).toThrow(/home directory/);
    expect(() => jobPaths('~', 'abc-1')).toThrow(/home directory/);
    expect(() => jobPaths('relative/path', 'abc-1')).toThrow(/home directory/);
  });

  it('проверяют идентификатор до сборки пути', () => {
    expect(() => jobPaths('/root', '../../etc')).toThrow(/Invalid job id/);
  });

  it('корень задач берётся отдельно — списку идентификатор не нужен', () => {
    expect(jobsRoot('/home/deploy')).toBe('/home/deploy/.ssh-mcp/jobs');
    expect(() => jobsRoot('')).toThrow(/home directory/);
  });
});

describe('Команда запуска', () => {
  const dir = '/root/.ssh-mcp/jobs/j1';

  it('передаёт каталог и команду параметрами, а не подстановкой в текст', () => {
    const command = buildStartCommand(dir, "echo 'hi there'", true);
    expect(command).toContain(`sh -c 'echo $$ > "$0/pid"; sh -c "$1"; echo $? > "$0/exit_code"'`);
    expect(command).toContain(`'echo '\\''hi there'\\'''`);
  });

  it('переживает команду с подстановкой и переводом строки', () => {
    const command = buildStartCommand(dir, 'echo $(id)\nwhoami', true);
    // Всё тело задачи внутри одинарных кавычек: сервер не раскроет его при разборе
    expect(command).toContain(`'echo $(id)\nwhoami'`);
  });

  it('отвязывает задачу через setsid, когда он есть', () => {
    expect(buildStartCommand(dir, 'sleep 1', true)).toContain('setsid sh -c');
    expect(buildStartCommand(dir, 'sleep 1', true)).not.toContain('nohup sh -c');
  });

  it('обходится nohup, когда setsid нет', () => {
    expect(buildStartCommand(dir, 'sleep 1', false)).toContain('nohup sh -c');
    expect(buildStartCommand(dir, 'sleep 1', false)).not.toContain('setsid sh -c');
  });

  it('уводит задачу от канала: свой stdin и вывод в файл', () => {
    const command = buildStartCommand(dir, 'sleep 1', true);
    expect(command).toContain('</dev/null');
    expect(command).toContain(`>> '${dir}'/output.log 2>&1 & }`);
  });

  it('в фон уходит только запуск, а не вся цепочка подготовки', () => {
    // Без скобок `&` захватывает цепочку целиком, и на dash подоболочка держит
    // канал ssh до конца задачи: запуск перестаёт быть мгновенным
    const command = buildStartCommand(dir, 'sleep 1', true);
    expect(command).toContain('&& { setsid sh -c');
    expect(command).toMatch(/2>&1 & \} ;/);
  });

  it('ждёт, пока задача назовёт свой pid', () => {
    const command = buildStartCommand(dir, 'sleep 1', true);
    expect(command).toContain(`while [ ! -s '${dir}'/pid ]`);
    expect(command).toContain('sleep 0.1 2>/dev/null || sleep 1');
  });

  it('записывает команду и время старта', () => {
    const command = buildStartCommand(dir, 'sleep 1', true);
    expect(command).toContain(`> '${dir}'/cmd`);
    expect(command).toContain(`date +%s > '${dir}'/started`);
  });
});

describe('Команда снятия', () => {
  const dir = '/root/.ssh-mcp/jobs/j1';

  it('снимает группу процессов', () => {
    expect(buildKillCommand(dir)).toContain('kill -TERM -"$pid"');
  });

  it('никогда не пишет "--": BusyBox отвечает на него отказом', () => {
    expect(buildKillCommand(dir)).not.toContain('--');
    expect(buildKillCommand(dir, 'KILL')).not.toContain('--');
  });

  it('оставляет запасной путь для задачи без своей группы', () => {
    expect(buildKillCommand(dir)).toContain('|| kill -TERM "$pid"');
  });

  it('умеет второй сигнал', () => {
    const command = buildKillCommand(dir, 'KILL');
    expect(command).toContain('kill -KILL -"$pid"');
    expect(command).toContain('|| kill -KILL "$pid"');
  });

  it('различает «нет pid» и «процесса уже нет»', () => {
    const command = buildKillCommand(dir);
    expect(command).toContain('reason=nopid');
    expect(command).toContain('reason=gone');
  });
});

describe('Команда чтения вывода', () => {
  const dir = '/root/.ssh-mcp/jobs/j1';

  it('считает позицию от единицы', () => {
    expect(buildOutputCommand(dir, 0)).toContain('tail -c +1 ');
    expect(buildOutputCommand(dir, 10)).toContain('tail -c +11 ');
  });

  it('не пускает отрицательную и дробную позицию', () => {
    expect(buildOutputCommand(dir, -5)).toContain('tail -c +1 ');
    expect(buildOutputCommand(dir, 3.7)).toContain('tail -c +4 ');
  });

  it('печатает размер до самого вывода', () => {
    const command = buildOutputCommand(dir, 0);
    expect(command.indexOf('size=%s')).toBeLessThan(command.indexOf('tail -c'));
  });
});

describe('Команда списка', () => {
  const root = '/root/.ssh-mcp/jobs';

  it('судит о возрасте по времени старта, а не по find', () => {
    const command = buildListCommand(root);
    expect(command).toContain(`$((now - started)) -gt ${JOB_TTL_SEC}`);
    expect(command).not.toContain('find ');
  });

  it('убирает только то, что уже не работает', () => {
    expect(buildListCommand(root)).toContain('if [ "$alive" = 0 ] && [ -n "$started" ]');
  });

  it('ходит только внутри своего корня', () => {
    const command = buildListCommand(root);
    expect(command).toContain(`root='${root}'`);
    expect(command).toContain('for d in "$root"/*');
    expect(command).toContain('rm -rf "$d"');
  });

  it('принимает свой срок жизни', () => {
    expect(buildListCommand(root, 60)).toContain('$((now - started)) -gt 60');
  });
});

describe('Разбор состояния', () => {
  it('работает, пока процесс жив и кода нет', () => {
    const status = parseJobStatus(
      'SSH_MCP_JOB alive=1 pid=42 code= started=1700000000 size=17\nSSH_MCP_JOB_CMD\nsleep 100'
    );
    expect(status).toMatchObject({
      state: 'running',
      pid: 42,
      exitCode: undefined,
      startedAt: 1700000000,
      outputSize: 17,
      command: 'sleep 100',
    });
  });

  it('завершилась, когда код появился', () => {
    const status = parseJobStatus('SSH_MCP_JOB alive=0 pid=42 code=7 started=1 size=0\nSSH_MCP_JOB_CMD\nfalse');
    expect(status.state).toBe('finished');
    expect(status.exitCode).toBe(7);
  });

  it('код возврата главнее живости', () => {
    // Задача успевает завершиться между чтением файла и проверкой процесса
    expect(parseJobStatus('SSH_MCP_JOB alive=1 pid=42 code=0 started=1 size=0').state).toBe('finished');
  });

  it('потеряна, когда ни кода, ни процесса', () => {
    expect(parseJobStatus('SSH_MCP_JOB alive=0 pid=42 code= started=1 size=0').state).toBe('lost');
  });

  it('нет каталога — нет задачи', () => {
    expect(parseJobStatus('SSH_MCP_JOB state=missing').state).toBe('missing');
    expect(parseJobStatus('банер сервера, ни слова о задаче').state).toBe('missing');
  });

  it('находит ответ среди постороннего вывода', () => {
    const status = parseJobStatus(
      'Welcome to Ubuntu\nLast login: never\nSSH_MCP_JOB alive=1 pid=9 code= started=5 size=1\nSSH_MCP_JOB_CMD\ntop'
    );
    expect(status.state).toBe('running');
    expect(status.pid).toBe(9);
  });

  it('возвращает многострочную команду целиком', () => {
    const status = parseJobStatus(
      'SSH_MCP_JOB alive=1 pid=9 code= started=5 size=1\nSSH_MCP_JOB_CMD\nline one\nline two'
    );
    expect(status.command).toBe('line one\nline two');
  });

  it('нечисловые поля читаются как «сервер не сказал»', () => {
    const status = parseJobStatus('SSH_MCP_JOB alive=1 pid=abc code= started= size=');
    expect(status.pid).toBeUndefined();
    expect(status.startedAt).toBeUndefined();
    expect(status.outputSize).toBeUndefined();
  });
});

describe('Разбор списка', () => {
  it('читает задачи и убранные каталоги', () => {
    const listing = parseJobList(
      [
        'SSH_MCP_JOB id=a1 alive=1 code= started=100 size=5',
        'SSH_MCP_JOB_REMOVED id=old-1',
        'SSH_MCP_JOB id=b2 alive=0 code=0 started=200 size=9',
      ].join('\n')
    );

    expect(listing.jobs).toEqual([
      { id: 'a1', state: 'running', exitCode: undefined, startedAt: 100, outputSize: 5 },
      { id: 'b2', state: 'finished', exitCode: 0, startedAt: 200, outputSize: 9 },
    ]);
    expect(listing.removed).toEqual(['old-1']);
  });

  it('пустой список — не ошибка', () => {
    expect(parseJobList('')).toEqual({ jobs: [], removed: [] });
  });

  it('строку без идентификатора пропускает', () => {
    expect(parseJobList('SSH_MCP_JOB alive=1 code= started=1 size=0').jobs).toEqual([]);
  });
});

describe('Разбор вывода', () => {
  it('отделяет размер от самого вывода', () => {
    expect(parseJobOutput('SSH_MCP_JOB size=12\nhello\nworld')).toEqual({
      size: 12,
      text: 'hello\nworld',
    });
  });

  it('пустой вывод при известном размере', () => {
    expect(parseJobOutput('SSH_MCP_JOB size=0\n')).toEqual({ size: 0, text: '' });
  });

  it('ответ без маркера отдаёт как есть', () => {
    expect(parseJobOutput('что-то пошло не так')).toEqual({ size: 0, text: 'что-то пошло не так' });
  });
});

describe('Разбор снятия', () => {
  it('снята', () => {
    expect(parseJobKill('SSH_MCP_JOB killed=1')).toEqual({ killed: true, reason: undefined });
  });

  it('уже не работала', () => {
    expect(parseJobKill('SSH_MCP_JOB killed=0 reason=gone')).toEqual({
      killed: false,
      reason: 'gone',
    });
  });

  it('pid не записан', () => {
    expect(parseJobKill('SSH_MCP_JOB killed=0 reason=nopid').reason).toBe('nopid');
  });

  it('сервер промолчал', () => {
    expect(parseJobKill('')).toEqual({ killed: false, reason: 'no answer' });
  });
});

describe('Разбор запуска', () => {
  it('читает pid, названный задачей', () => {
    expect(parseJobStart('SSH_MCP_JOB pid=1234')).toBe(1234);
  });

  it('пустой pid — задача себя не назвала', () => {
    expect(parseJobStart('SSH_MCP_JOB pid=')).toBeUndefined();
    expect(parseJobStart('')).toBeUndefined();
  });
});
