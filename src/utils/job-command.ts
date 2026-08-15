/**
 * Протокол фоновой задачи: команды к серверу и разбор их ответов.
 *
 * Состояние задачи целиком лежит на удалённом диске, поэтому MCP-сервер ничего
 * не помнит между вызовами и переживает собственный перезапуск.
 *
 * Формы команд взяты из замеров на BusyBox и coreutils, а не из общих правил:
 * `--` в `kill` на BusyBox отказ, `$!` называет обёртку вместо самой задачи, а
 * `ps -o` есть не везде. Сборка и разбор лежат рядом, потому что меняются вместе.
 */

import { randomBytes } from 'crypto';
import { shellQuote } from './shell-arg.js';

/** Каталог задач относительно дома пользователя */
const JOBS_ROOT = '.ssh-mcp/jobs';

/** Маркер, по которому ответ находится среди баннера и motd */
const MARKER = 'SSH_MCP_JOB';
const CMD_MARKER = 'SSH_MCP_JOB_CMD';
const REMOVED_MARKER = 'SSH_MCP_JOB_REMOVED';

/** Сколько живёт каталог завершённой задачи, секунды */
export const JOB_TTL_SEC = 7 * 24 * 60 * 60;

/** Сколько запуск ждёт, пока задача запишет свой pid */
const PID_WAIT_ATTEMPTS = 20;

/**
 * Чем кончилась задача.
 *
 * Три исхода не смешиваются: `lost` — это «проверить нечем», а не провал.
 * Снятая сигналом задача кода возврата не оставляет (замерено), и выдать её
 * за успешную или за упавшую было бы неправдой.
 */
export type JobState = 'running' | 'finished' | 'lost' | 'missing';

export interface JobStatus {
  state: JobState;
  pid?: number;
  exitCode?: number;
  /** Время старта, секунды эпохи */
  startedAt?: number;
  /** Размер накопленного вывода в байтах — он же курсор для чтения */
  outputSize?: number;
  /** Команда, как её задали */
  command?: string;
}

export interface JobSummary {
  id: string;
  state: JobState;
  exitCode?: number;
  startedAt?: number;
  outputSize?: number;
}

export interface JobListing {
  jobs: JobSummary[];
  /** Задачи, каталоги которых убраны по сроку */
  removed: string[];
}

export interface JobOutput {
  /** Полный размер вывода на сервере: следующее чтение начинается отсюда */
  size: number;
  text: string;
}

/**
 * Идентификатор задачи: время старта и случайный хвост.
 *
 * Время впереди делает список читаемым по порядку, случайный хвост исключает
 * совпадение двух задач, запущенных в одну миллисекунду.
 */
export function createJobId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Идентификатор уезжает в путь на сервере, поэтому чужой проверяется до отправки.
 *
 * Разрешены только буквы, цифры и дефис: этого хватает нашим же идентификаторам,
 * а `..`, разделитель пути, пробел и подстановка отсекаются одним правилом.
 */
export function assertJobId(id: unknown): string {
  const text = typeof id === 'string' ? id : '';

  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(text)) {
    throw new Error(
      `Invalid job id ${JSON.stringify(String(id))}: expected letters, digits and dashes`
    );
  }

  return text;
}

/** Корень задач на сервере. Пустой дом — отказ: угадывать путь записи нельзя. */
export function jobsRoot(home: string): string {
  if (!home.startsWith('/')) {
    throw new Error(
      'Cannot locate the jobs directory: the server did not report a home directory'
    );
  }

  return `${home.replace(/\/$/, '')}/${JOBS_ROOT}`;
}

/** Пути одной задачи: её каталог лежит в общем корне */
export function jobPaths(home: string, id: string): { root: string; dir: string } {
  const root = jobsRoot(home);
  return { root, dir: `${root}/${assertJobId(id)}` };
}

/**
 * Команда запуска фоновой задачи.
 *
 * Каталог и команда уезжают параметрами `$0` и `$1`, а не подстановкой в текст:
 * так кавычки накладываются один раз, и команда с пробелом, апострофом или
 * `$(…)` доезжает целой.
 *
 * Pid пишет сама задача: `$!` в фоновом запуске называет обёртку, а не тот
 * процесс, который исполняет команду (замерено на обоих наборах утилит).
 * Она же становится лидером группы и сессии — это и позволяет снять её целиком.
 *
 * Фон ограничен фигурными скобками, иначе `&` относится ко всей цепочке
 * подготовки: dash оставляет на неё подоболочку, та держит канал ssh открытым
 * до конца задачи, и запуск перестаёт быть мгновенным. BusyBox так себя не
 * ведёт — дефект виден только на половине серверов (замерено: 15 с против 0).
 */
export function buildStartCommand(dir: string, command: string, useSetsid: boolean): string {
  const dirQ = shellQuote(dir);
  const commandQ = shellQuote(command);
  const detach = useSetsid ? 'setsid' : 'nohup';

  const body =
    `echo $$ > "$0/pid"; ` +
    `sh -c "$1"; ` +
    `echo $? > "$0/exit_code"`;

  return (
    `mkdir -p ${dirQ} && ` +
    `printf '%s' ${commandQ} > ${dirQ}/cmd && ` +
    `date +%s > ${dirQ}/started && ` +
    `: > ${dirQ}/output.log && ` +
    `{ ${detach} sh -c ${shellQuote(body)} ${dirQ} ${commandQ} ` +
    `</dev/null >> ${dirQ}/output.log 2>&1 & } ; ` +
    // Ждём, пока задача назовёт себя: без pid следующий же вызов состояния
    // счёл бы её потерянной
    `i=0; while [ ! -s ${dirQ}/pid ] && [ $i -lt ${PID_WAIT_ATTEMPTS} ]; do ` +
    `i=$((i+1)); sleep 0.1 2>/dev/null || sleep 1; done; ` +
    `printf '${MARKER} pid=%s\\n' "$(cat ${dirQ}/pid 2>/dev/null)"`
  );
}

/** Команда состояния: поля одной строкой, команда задачи — хвостом после маркера */
export function buildStatusCommand(dir: string): string {
  const dirQ = shellQuote(dir);

  return (
    `d=${dirQ}; ` +
    `if [ ! -d "$d" ]; then printf '${MARKER} state=missing\\n'; exit 0; fi; ` +
    `pid=$(cat "$d/pid" 2>/dev/null); ` +
    `code=$(cat "$d/exit_code" 2>/dev/null); ` +
    `started=$(cat "$d/started" 2>/dev/null); ` +
    `size=$(wc -c < "$d/output.log" 2>/dev/null); ` +
    `alive=0; if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi; ` +
    `printf '${MARKER} alive=%s pid=%s code=%s started=%s size=%s\\n' ` +
    `"$alive" "$pid" "$code" "$started" "$size"; ` +
    `printf '${CMD_MARKER}\\n'; cat "$d/cmd" 2>/dev/null`
  );
}

/**
 * Команда чтения вывода с позиции.
 *
 * `tail -c +N` считает от единицы, поэтому позиция сдвигается на один: ноль
 * читает файл целиком. Размер печатается первым — он же курсор следующего чтения.
 */
export function buildOutputCommand(dir: string, offset: number): string {
  const dirQ = shellQuote(dir);
  const from = Math.max(0, Math.floor(offset)) + 1;

  return (
    `d=${dirQ}; ` +
    `if [ ! -f "$d/output.log" ]; then printf '${MARKER} size=0\\n'; exit 0; fi; ` +
    `printf '${MARKER} size=%s\\n' "$(wc -c < "$d/output.log" 2>/dev/null)"; ` +
    `tail -c +${from} "$d/output.log" 2>/dev/null`
  );
}

/**
 * Команда снятия задачи.
 *
 * Минус перед номером означает группу процессов — снимается и сама задача, и её
 * потомки. `--` не пишем: BusyBox отвечает на него `invalid number` и не делает
 * ничего (замерено). Одиночный процесс остаётся запасным путём для задачи,
 * запущенной без отдельной сессии.
 */
export function buildKillCommand(dir: string, signal: 'TERM' | 'KILL' = 'TERM'): string {
  const dirQ = shellQuote(dir);

  return (
    `d=${dirQ}; ` +
    `pid=$(cat "$d/pid" 2>/dev/null); ` +
    `if [ -z "$pid" ]; then printf '${MARKER} killed=0 reason=nopid\\n'; exit 0; fi; ` +
    `if ! kill -0 "$pid" 2>/dev/null; then printf '${MARKER} killed=0 reason=gone\\n'; exit 0; fi; ` +
    `kill -${signal} -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null; ` +
    `printf '${MARKER} killed=1\\n'`
  );
}

/**
 * Команда списка с попутной уборкой.
 *
 * Возраст считается по записанному нами времени старта, а не `find -mtime`:
 * диалекты `find` расходятся, а число секунд одинаково везде. Убираются только
 * каталоги внутри нашего корня и только у задач, которые уже не работают.
 */
export function buildListCommand(root: string, ttlSec: number = JOB_TTL_SEC): string {
  const rootQ = shellQuote(root);

  return (
    `root=${rootQ}; ` +
    `[ -d "$root" ] || exit 0; ` +
    `now=$(date +%s); ` +
    `for d in "$root"/*; do ` +
    `[ -d "$d" ] || continue; ` +
    `id=$(basename "$d"); ` +
    `pid=$(cat "$d/pid" 2>/dev/null); ` +
    `code=$(cat "$d/exit_code" 2>/dev/null); ` +
    `started=$(cat "$d/started" 2>/dev/null); ` +
    `size=$(wc -c < "$d/output.log" 2>/dev/null); ` +
    `alive=0; if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi; ` +
    `if [ "$alive" = 0 ] && [ -n "$started" ] && [ $((now - started)) -gt ${ttlSec} ]; then ` +
    `rm -rf "$d"; printf '${REMOVED_MARKER} id=%s\\n' "$id"; continue; fi; ` +
    `printf '${MARKER} id=%s alive=%s code=%s started=%s size=%s\\n' ` +
    `"$id" "$alive" "$code" "$started" "$size"; ` +
    `done`
  );
}

/** Поля вида `ключ=значение` из строки с маркером */
function fieldsOf(line: string, marker: string): Map<string, string> {
  const body = line.slice(line.indexOf(marker) + marker.length).trim();
  const fields = new Map<string, string>();

  for (const token of body.split(/\s+/)) {
    const separator = token.indexOf('=');
    if (separator > 0) fields.set(token.slice(0, separator), token.slice(separator + 1));
  }

  return fields;
}

/** Число или undefined: пустое поле означает «сервер об этом не сказал» */
function numberOf(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/**
 * Исход задачи по тому, что вернул сервер.
 *
 * Код возврата главнее живости: задача успевает завершиться между чтением
 * файла и проверкой процесса, и тогда «код есть» — это уже ответ.
 */
function stateOf(alive: boolean, exitCode: number | undefined): JobState {
  if (exitCode !== undefined) return 'finished';
  return alive ? 'running' : 'lost';
}

/** Разобрать ответ команды состояния */
export function parseJobStatus(stdout: string): JobStatus {
  const lines = stdout.split('\n');
  const head = lines.find((line) => line.includes(MARKER));
  if (!head) return { state: 'missing' };

  const fields = fieldsOf(head, MARKER);
  if (fields.get('state') === 'missing') return { state: 'missing' };

  const cmdAt = lines.findIndex((line) => line.includes(CMD_MARKER));
  const command = cmdAt >= 0 ? lines.slice(cmdAt + 1).join('\n') : undefined;
  const exitCode = numberOf(fields.get('code'));

  return {
    state: stateOf(fields.get('alive') === '1', exitCode),
    pid: numberOf(fields.get('pid')),
    exitCode,
    startedAt: numberOf(fields.get('started')),
    outputSize: numberOf(fields.get('size')),
    command,
  };
}

/** Разобрать ответ команды списка */
export function parseJobList(stdout: string): JobListing {
  const jobs: JobSummary[] = [];
  const removed: string[] = [];

  for (const line of stdout.split('\n')) {
    if (line.includes(REMOVED_MARKER)) {
      const id = fieldsOf(line, REMOVED_MARKER).get('id');
      if (id) removed.push(id);
      continue;
    }

    if (!line.includes(MARKER)) continue;

    const fields = fieldsOf(line, MARKER);
    const id = fields.get('id');
    if (!id) continue;

    const exitCode = numberOf(fields.get('code'));
    jobs.push({
      id,
      state: stateOf(fields.get('alive') === '1', exitCode),
      exitCode,
      startedAt: numberOf(fields.get('started')),
      outputSize: numberOf(fields.get('size')),
    });
  }

  return { jobs, removed };
}

/**
 * Разобрать ответ чтения вывода.
 *
 * Размер приходит первой строкой и из текста вырезается: он служебный, а
 * выдать его за часть вывода задачи значит соврать о её выводе.
 */
export function parseJobOutput(stdout: string): JobOutput {
  const newline = stdout.indexOf('\n');
  const head = newline >= 0 ? stdout.slice(0, newline) : stdout;

  if (!head.includes(MARKER)) return { size: 0, text: stdout };

  return {
    size: numberOf(fieldsOf(head, MARKER).get('size')) ?? 0,
    text: newline >= 0 ? stdout.slice(newline + 1) : '',
  };
}

/** Разобрать ответ снятия: снята ли задача и почему нет */
export function parseJobKill(stdout: string): { killed: boolean; reason?: string } {
  const line = stdout.split('\n').find((candidate) => candidate.includes(MARKER));
  if (!line) return { killed: false, reason: 'no answer' };

  const fields = fieldsOf(line, MARKER);
  return { killed: fields.get('killed') === '1', reason: fields.get('reason') };
}

/** Pid, названный запущенной задачей */
export function parseJobStart(stdout: string): number | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.includes(MARKER));
  return line ? numberOf(fieldsOf(line, MARKER).get('pid')) : undefined;
}
