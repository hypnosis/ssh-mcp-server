/**
 * Признак провала в ответе живого сервера.
 *
 * Три исхода не смешиваются: инструмент не сделал работу — флаг стоит;
 * работа сделана — флага нет, даже если команда вернула ненулевой код;
 * проверить было нечем — флага тоже нет, это успех с пометкой внутри текста.
 *
 * Наборы утилит расходятся текстами отказов, поэтому проверка идёт на обоих.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason, type LabServer } from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;

/** Свой каталог управления: соседние наборы держат сокеты в общем */
const CONTROL_DIR = '/tmp/mcp-lab-errflag';

const unavailable = await labUnavailableReason();

const localDir = mkdtempSync(join(tmpdir(), 'mcp-lab-errflag-'));
const profilesFile = join(localDir, 'profiles.json');
const previousProfilesFile = process.env.SSH_PROFILES_FILE;

process.env.SSH_MCP_CONTROL_DIR = CONTROL_DIR;
process.env.SSH_PROFILES_FILE = profilesFile;
process.env.SSH_MCP_PROFILES_WATCH = 'false';

writeFileSync(
  profilesFile,
  JSON.stringify({
    default: LAB_SERVERS[0].container,
    profiles: Object.fromEntries(
      LAB_SERVERS.map((server: LabServer) => [
        server.container,
        {
          host: '127.0.0.1',
          port: server.port,
          username: 'root',
          privateKeyPath: LAB_KEY,
          strictHostKeyChecking: 'no',
          ignoreUserConfig: true,
        },
      ])
    ),
  })
);

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { FileTools } = await import('../../src/tools/file-tools.js');
const { LogTools } = await import('../../src/tools/log-tools.js');
const { SnapshotTool } = await import('../../src/tools/snapshot-tool.js');
const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { AuditTool } = await import('../../src/tools/audit-tool.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

const execTool = new ExecTool();
const fileTools = new FileTools();
const logTools = new LogTools();
const snapshotTool = new SnapshotTool();
const transferTool = new TransferTool();
const auditTool = new AuditTool();

type Handler = { handleCall(request: never): Promise<{ content: Array<{ text: string }>; isError?: boolean }> };

/** Ответ инструмента целиком: текст и признак провала */
async function respond(
  handler: Handler,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> {
  const response = await handler.handleCall({ params: { name, arguments: args } } as never);
  return { text: response.content[0].text, isError: response.isError };
}

afterAll(async () => {
  await closeAllRunners();
  rmSync(localDir, { recursive: true, force: true });
  await new Promise((resolve) => execFile('rm', ['-rf', CONTROL_DIR], () => resolve(undefined)));
  if (previousProfilesFile === undefined) delete process.env.SSH_PROFILES_FILE;
  else process.env.SSH_PROFILES_FILE = previousProfilesFile;
});

if (unavailable && LAB_REQUIRED) {
  describe('признак провала живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`признак провала — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущен', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Признак провала: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const profile = server.container;

      it('неизвестный профиль — провал у каждого класса инструментов', async () => {
        const calls: Array<[Handler, string, Record<string, unknown>]> = [
          [execTool, 'ssh_exec', { profile: 'nosuch', command: 'echo hi' }],
          [fileTools, 'ssh_file_read', { profile: 'nosuch', path: '/etc/hostname' }],
          [logTools, 'ssh_log_tail', { profile: 'nosuch', path: '/var/log/messages' }],
          [snapshotTool, 'ssh_snapshot', { profile: 'nosuch' }],
          [transferTool, 'ssh_download', { profile: 'nosuch', remote_path: '/etc/hostname', local_path: join(localDir, 'x') }],
          [auditTool, 'ssh_audit_baseline', { profile: 'nosuch' }],
        ];

        for (const [handler, name, args] of calls) {
          const answer = await respond(handler, name, args);
          expect(answer.isError, `${name}: отказ пришёл без признака провала`).toBe(true);
        }
      });

      it('сервер отказал в работе — провал', async () => {
        expect((await respond(fileTools, 'ssh_file_read', { profile, path: '/nope/missing.txt' })).isError).toBe(true);
        expect((await respond(fileTools, 'ssh_file_list', { profile, path: '/nope-missing-dir' })).isError).toBe(true);
        expect((await respond(logTools, 'ssh_log_tail', { profile, path: '/nope/app.log' })).isError).toBe(true);
      });

      it('команда убита по времени — провал', async () => {
        const answer = await respond(execTool, 'ssh_exec', {
          profile,
          command: 'sleep 5',
          timeout: 1500,
        });

        expect(answer.isError).toBe(true);
        expect(answer.text).toContain('timed out');
      });

      it('напечатанное до убийства доходит до ответа', async () => {
        const answer = await respond(execTool, 'ssh_exec', {
          profile,
          command: 'echo started; echo warming >&2; sleep 5; echo never',
          timeout: 1500,
        });

        expect(answer.isError).toBe(true);
        expect(answer.text).toContain('STDOUT:\nstarted');
        expect(answer.text).toContain('STDERR:\nwarming');
        expect(answer.text).not.toContain('never');
      });

      it('форма аргумента не та — провал до первой команды', async () => {
        expect((await respond(execTool, 'ssh_exec', { profile, command: 42 })).isError).toBe(true);
        expect((await respond(fileTools, 'ssh_file_write', { profile })).isError).toBe(true);
      });

      it('работа сделана — признака провала нет', async () => {
        expect((await respond(execTool, 'ssh_exec', { profile, command: 'echo hi' })).isError).toBeUndefined();
        expect((await respond(fileTools, 'ssh_file_read', { profile, path: '/etc/hostname' })).isError).toBeUndefined();
        expect((await respond(snapshotTool, 'ssh_snapshot', { profile })).isError).toBeUndefined();
      });

      it('ненулевой код выполненной команды провалом не считается', async () => {
        const answer = await respond(execTool, 'ssh_exec', { profile, command: 'exit 7' });

        expect(answer.text).toContain('Exit code: 7');
        expect(answer.isError).toBeUndefined();
      });

      it('проверить было нечем — это успех с пометкой, а не провал', async () => {
        const tls = await respond(auditTool, 'ssh_tls_check', { profile, domain: 'nosuch.invalid' });
        expect(tls.text).toContain('UNKNOWN');
        expect(tls.isError).toBeUndefined();

        const unit = await respond(auditTool, 'ssh_service_status', { profile, unit: 'nosuch-unit' });
        expect(unit.text).toContain('NOT CHECKED');
        expect(unit.isError).toBeUndefined();
      });
    });
  }
}
