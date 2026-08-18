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

  it.each(Object.entries(EXPECTED))('%s объявлен целиком', (name, expected) => {
    const annotations = byName.get(name)!.annotations!;
    expect(annotations.readOnlyHint).toBe(expected.readOnly);
    expect(annotations.openWorldHint).toBe(expected.openWorld);
    if (expected.destructive !== undefined) {
      expect(annotations.destructiveHint).toBe(expected.destructive);
    }
    if (expected.idempotent !== undefined) {
      expect(annotations.idempotentHint).toBe(expected.idempotent);
    }
  });
});

describe('пишущий инструмент не выдаётся за читающий', () => {
  it.each(writingNames)('%s не помечен только чтением', (name) => {
    expect(byName.get(name)!.annotations!.readOnlyHint).toBe(false);
  });

  it.each(writingNames)('%s помечен как разрушающий', (name) => {
    expect(byName.get(name)!.annotations!.destructiveHint).toBe(true);
  });

  it('произвольная команда не обещает повтора без последствий', () => {
    expect(byName.get('ssh_exec')!.annotations!.idempotentHint).toBe(false);
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
