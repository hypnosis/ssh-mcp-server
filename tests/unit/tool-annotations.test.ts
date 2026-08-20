/**
 * Подсказки о поведении инструментов: по ним клиент решает, спрашивать ли
 * человека перед вызовом.
 *
 * Таблица заведена поимённо и отдельно от кода: она читается как обещание
 * пакета, а не как пересказ реализации. Инструмент, который пишет на сервер,
 * но помечен только чтением, — это молчаливое разрешение делать что угодно,
 * поэтому чтение и запись проверяются каждое своим ожиданием.
 */

import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../../src/mcp-server.js';

type Expected = {
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld: boolean;
};

/** Что каждый инструмент обещает клиенту */
const EXPECTED: Record<string, Expected> = {
  ssh_audit_baseline: { readOnly: true, openWorld: true },
  ssh_disk_breakdown: { readOnly: true, openWorld: true },
  ssh_file_list: { readOnly: true, openWorld: true },
  ssh_file_read: { readOnly: true, openWorld: true },
  ssh_job_list: { readOnly: true, openWorld: true },
  ssh_job_output: { readOnly: true, openWorld: true },
  ssh_job_status: { readOnly: true, openWorld: true },
  ssh_log_search: { readOnly: true, openWorld: true },
  ssh_log_tail: { readOnly: true, openWorld: true },
  ssh_service_status: { readOnly: true, openWorld: true },
  ssh_snapshot: { readOnly: true, openWorld: true },
  ssh_tls_check: { readOnly: true, openWorld: true },

  ssh_download: { readOnly: false, destructive: true, idempotent: true, openWorld: true },
  ssh_file_write: { readOnly: false, destructive: true, idempotent: true, openWorld: true },
  ssh_job_kill: { readOnly: false, destructive: true, idempotent: true, openWorld: true },
  ssh_upload: { readOnly: false, destructive: true, idempotent: true, openWorld: true },

  ssh_exec: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
  ssh_monitor: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
};

/**
 * Подсказка, которой нет в записи, читается клиентом по спецификации.
 * Каждое из этих значений — осторожное чтение: не только чтение, разрушает,
 * повтор не бесплатен, мир открыт.
 */
const SPEC_DEFAULTS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Что клиент увидит: записанное значение или умолчание спецификации */
function effective(name: string, hint: keyof typeof SPEC_DEFAULTS): boolean {
  const annotations = byName.get(name)!.annotations ?? {};
  return (annotations[hint] as boolean | undefined) ?? SPEC_DEFAULTS[hint];
}

const TOOLS = createMcpServer('test').tools;
const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

const readOnlyNames = Object.entries(EXPECTED)
  .filter(([, e]) => e.readOnly)
  .map(([name]) => name);
const writingNames = Object.entries(EXPECTED)
  .filter(([, e]) => !e.readOnly && e.destructive)
  .map(([name]) => name);

describe('каждый инструмент объявляет своё поведение', () => {
  it('таблица покрывает ровно тот список, который отдаёт сервер', () => {
    expect([...byName.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.keys(EXPECTED))('%s несёт аннотации', (name) => {
    expect(byName.get(name)?.annotations).toBeDefined();
  });

  it.each(Object.entries(EXPECTED))('%s читается клиентом целиком', (name, expected) => {
    expect(effective(name, 'readOnlyHint')).toBe(expected.readOnly);
    expect(effective(name, 'openWorldHint')).toBe(expected.openWorld);
    if (expected.destructive !== undefined) {
      expect(effective(name, 'destructiveHint')).toBe(expected.destructive);
    }
    if (expected.idempotent !== undefined) {
      expect(effective(name, 'idempotentHint')).toBe(expected.idempotent);
    }
  });

  /*
   * Подсказка со значением умолчания едет по проводу в каждой сессии и не
   * говорит клиенту ничего нового. Исключение одно: запись пишущему
   * инструменту, что он разрушает, — клиент, не знающий умолчаний, не должен
   * принять запись за добавление.
   */
  it.each(Object.keys(EXPECTED))('%s не повторяет умолчания спецификации', (name) => {
    const annotations = byName.get(name)!.annotations ?? {};
    const repeated = Object.entries(SPEC_DEFAULTS)
      .filter(([hint, value]) => hint !== 'destructiveHint')
      .filter(([hint, value]) => annotations[hint as keyof typeof SPEC_DEFAULTS] === value)
      .map(([hint]) => hint);

    expect(repeated).toEqual([]);
  });
});

describe('пишущий инструмент не выдаётся за читающий', () => {
  it.each(writingNames)('%s не читается как только чтение', (name) => {
    expect(effective(name, 'readOnlyHint')).toBe(false);
  });

  it.each(writingNames)('%s помечен как разрушающий прямо в записи', (name) => {
    expect(byName.get(name)!.annotations!.destructiveHint).toBe(true);
  });

  it('произвольная команда не обещает повтора без последствий', () => {
    expect(effective('ssh_exec', 'idempotentHint')).toBe(false);
  });
});

describe('читающий инструмент не пугает клиента лишним', () => {
  it.each(readOnlyNames)('%s не объявляет разрушения', (name) => {
    expect(byName.get(name)!.annotations!.destructiveHint).toBeUndefined();
  });
});

describe('название инструмента понятно человеку', () => {
  it.each(Object.keys(EXPECTED))('%s имеет заголовок, а не повтор имени', (name) => {
    const title = byName.get(name)!.annotations!.title;
    expect(title).toBeTruthy();
    expect(title).not.toBe(name);
  });
});
