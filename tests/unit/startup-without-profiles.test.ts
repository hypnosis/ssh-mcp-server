/**
 * Старт без файла профилей: сервер поднимается и отвечает.
 *
 * Проверка идёт настоящим процессом по stdio, а не вызовом функций: падало и в
 * точке входа, и при загрузке модуля профилей, а мок ни того ни другого не
 * воспроизводит. Каталоги MCP сканируют сервер ровно так же — запускают без
 * конфигурации и спрашивают список инструментов, поэтому отказ стартовать
 * стоит всего списка.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { join } from 'path';
import { PROFILES_EXAMPLE_URI } from '../../src/tools/resources.js';

const ROOT = join(__dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(ROOT, 'src', 'index.ts');

/** Ответы сервера, разложенные по идентификатору запроса */
type Answers = Map<number, any>;

/** Живой сервер, запущенный без единой переменной окружения о профилях */
class ServerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly answers: Answers = new Map();
  private buffer = '';
  exitCode: number | null = null;

  constructor(profilesFile?: string) {
    const env = { ...process.env };
    delete env.SSH_PROFILES_FILE;
    if (profilesFile) env.SSH_PROFILES_FILE = profilesFile;
    env.SSH_MCP_PROFILES_WATCH = 'false';

    this.child = spawn(TSX, [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('exit', (code) => {
      this.exitCode = code;
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) this.answers.set(message.id, message);
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  /** Ответ на запрос с этим номером; молчание к сроку — это провал, не пропуск */
  async answer(id: number, timeoutMs = 20_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.answers.get(id);
      if (found) return found;
      if (this.exitCode !== null) {
        throw new Error(`Сервер вышел с кодом ${this.exitCode}, не ответив на запрос ${id}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Ответа на запрос ${id} нет за ${timeoutMs} мс`);
  }

  stop(): void {
    this.child.kill('SIGKILL');
  }
}

describe('старт без SSH_PROFILES_FILE', () => {
  let server: ServerProcess | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('поднимается и перечисляет инструменты', async () => {
    server = new ServerProcess();
    server.send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '0' },
      },
    });
    await server.answer(1);
    server.send({ method: 'notifications/initialized' });

    server.send({ id: 2, method: 'tools/list', params: {} });
    const listed = await server.answer(2);

    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('ssh_exec');
    expect(names).toContain('ssh_monitor');
    expect(server.exitCode).toBeNull();
  }, 40_000);

  it('объясняет отсутствие профилей в ответе инструмента, а не падением', async () => {
    server = new ServerProcess();
    server.send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '0' },
      },
    });
    await server.answer(1);
    server.send({ method: 'notifications/initialized' });

    server.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'ssh_monitor', arguments: { action: 'list' } },
    });
    const answered = await server.answer(2);

    const text = JSON.stringify(answered.result ?? answered.error);
    expect(text).toContain('SSH_PROFILES_FILE');
    // Ссылка на ресурс — единственный адрес формата файла, который агент получает
    expect(text).toContain(PROFILES_EXAMPLE_URI);
    expect(server.exitCode).toBeNull();
  }, 40_000);

  // Заданная переменная и незаданная идут разными путями: файл читается при
  // загрузке модуля, до всякого перехвата в точке входа
  it('переживает файл профилей, который не читается', async () => {
    server = new ServerProcess(join(__dirname, 'no-such-profiles-file.json'));
    server.send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '0' },
      },
    });
    await server.answer(1);
    server.send({ method: 'notifications/initialized' });

    server.send({ id: 2, method: 'tools/list', params: {} });
    const listed = await server.answer(2);
    expect(listed.result.tools.length).toBeGreaterThan(0);

    server.send({
      id: 3,
      method: 'tools/call',
      params: { name: 'ssh_monitor', arguments: { action: 'list' } },
    });
    const answered = await server.answer(3);

    const text = JSON.stringify(answered.result ?? answered.error);
    expect(text).toContain('no-such-profiles-file.json');
    expect(server.exitCode).toBeNull();
  }, 40_000);
});
