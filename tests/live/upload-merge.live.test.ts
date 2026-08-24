/**
 * Живая проверка слияния каталога на обоих наборах утилит.
 *
 * Сборка держится на двух `cp -a`, а они и есть то место, где BusyBox и
 * coreutils расходятся молча: `cp -a -n` на BusyBox пропускает всё дерево и
 * отвечает успехом, то есть слияние выродилось бы в полную замену без единого
 * слова в ответе. Мок такого не покажет — он отвечает тем, что в нём написано.
 *
 * Отдельно проверяется путь под sudo: дерево туда едет через /tmp, и сборка
 * идёт от root, а не от пользователя профиля.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  LAB_CONTROL_DIR,
  LAB_KEY,
  LAB_REQUIRED,
  LAB_SERVERS,
  labUnavailableReason,
} from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await labUnavailableReason();

const workDir = await mkdtemp(join(tmpdir(), 'upload-merge-live-'));
const profilesPath = join(workDir, 'profiles.json');

/** Профиль сервера под root и он же под непривилегированным пользователем с sudo */
const sudoProfileName = (name: string) => `${name}-deploy`;

await writeFile(
  profilesPath,
  JSON.stringify({
    profiles: Object.fromEntries(
      LAB_SERVERS.flatMap((server) => {
        const base = {
          host: '127.0.0.1',
          port: server.port,
          privateKeyPath: LAB_KEY,
          strictHostKeyChecking: 'no',
          ignoreUserConfig: true,
        };
        return [
          [server.name, { ...base, username: 'root' }],
          [sudoProfileName(server.name), { ...base, username: 'deploy' }],
        ];
      })
    ),
  })
);

process.env.SSH_PROFILES_FILE = profilesPath;
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;

const { createMcpServer } = await import('../../src/mcp-server.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живое слияние каталога', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живое слияние каталога — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущено', () => undefined);
  });
} else {
  let client: Client;

  beforeAll(async () => {
    const { server } = createMcpServer('test');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'upload-merge-live', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.listTools();
  });

  afterAll(async () => {
    await client.close();
    await closeAllRunners();
    await rm(workDir, { recursive: true, force: true });
  });

  const callTool = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

  const textOf = (result: CallToolResult): string =>
    (result.content as Array<{ text: string }>)[0].text;

  const exec = async (profile: string, command: string, sudo = false): Promise<string> =>
    textOf(await callTool('ssh_exec', { profile, command, sudo }));

  /** Новая сборка на этой машине: одноимённый файл и файл, которого в цели нет */
  async function newBuild(name: string): Promise<string> {
    const dir = join(workDir, name);
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'app.js'), 'build=2\n');
    await writeFile(join(dir, 'assets', 'main.css'), 'body{}\n');
    return dir;
  }

  /** Живой каталог на сервере: сборка и то, чего сборка про себя не знает */
  async function liveTarget(profile: string, path: string, sudo = false): Promise<void> {
    await exec(
      profile,
      `rm -rf ${path} && mkdir -p ${path}/uploads && printf 'build=1\\n' > ${path}/app.js && ` +
        `printf 'SECRET=1\\n' > ${path}/.env && printf 'bytes\\n' > ${path}/uploads/pic.bin`,
      sudo
    );
  }

  for (const server of LAB_SERVERS) {
    const profile = server.name;

    describe(`Слияние каталога: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      it('чужое в цели остаётся, одноимённое обновляется, новое приезжает', async () => {
        const target = `/tmp/merge-keep-${server.port}`;
        await liveTarget(profile, target);
        const local = await newBuild(`keep-${server.port}`);

        const answer = textOf(
          await callTool('ssh_upload', {
            profile,
            local_path: local,
            remote_path: target,
            merge: true,
          })
        );

        expect(answer).toContain('Upload OK');
        expect(answer).toContain('merged: true');
        expect(await exec(profile, `cat ${target}/.env`)).toContain('SECRET=1');
        expect(await exec(profile, `cat ${target}/uploads/pic.bin`)).toContain('bytes');
        expect(await exec(profile, `cat ${target}/app.js`)).toContain('build=2');
        expect(await exec(profile, `cat ${target}/assets/main.css`)).toContain('body{}');

        await exec(profile, `rm -rf ${target}`);
      });

      it('без merge то же самое исчезает — разница именно в параметре', async () => {
        const target = `/tmp/merge-off-${server.port}`;
        await liveTarget(profile, target);
        const local = await newBuild(`off-${server.port}`);

        await callTool('ssh_upload', {
          profile,
          local_path: local,
          remote_path: target,
        });

        expect(await exec(profile, `test -e ${target}/.env && echo YES || echo NO`)).toContain('NO');
        expect(await exec(profile, `cat ${target}/app.js`)).toContain('build=2');

        await exec(profile, `rm -rf ${target}`);
      });

      it('рядом с целью не остаётся ни временной копии, ни отложенной прежней', async () => {
        const target = `/tmp/merge-clean-${server.port}`;
        await liveTarget(profile, target);
        const local = await newBuild(`clean-${server.port}`);

        await callTool('ssh_upload', {
          profile,
          local_path: local,
          remote_path: target,
          merge: true,
        });

        const leftovers = await exec(
          profile,
          `ls -a /tmp | grep -e '^\\.upload-' -e '^\\.bak-' || echo NONE`
        );
        expect(leftovers).toContain('NONE');

        await exec(profile, `rm -rf ${target}`);
      });

      it('на пустом месте сливать не с чем: обычная установка, и ответ этого не выдумывает', async () => {
        const target = `/tmp/merge-empty-${server.port}`;
        await exec(profile, `rm -rf ${target}`);
        const local = await newBuild(`empty-${server.port}`);

        const answer = textOf(
          await callTool('ssh_upload', {
            profile,
            local_path: local,
            remote_path: target,
            merge: true,
          })
        );

        expect(answer).toContain('Upload OK');
        expect(answer).not.toContain('merged');
        expect(await exec(profile, `cat ${target}/app.js`)).toContain('build=2');

        await exec(profile, `rm -rf ${target}`);
      });

      it('под sudo слияние идёт в закрытый для пользователя каталог', async () => {
        const sudoProfile = sudoProfileName(server.name);
        const target = `/opt/merge-sudo-${server.port}`;
        await liveTarget(profile, target);
        const local = await newBuild(`sudo-${server.port}`);

        const answer = textOf(
          await callTool('ssh_upload', {
            profile: sudoProfile,
            local_path: local,
            remote_path: target,
            merge: true,
            sudo: true,
            owner: 'root:root',
          })
        );

        expect(answer).toContain('merged: true');
        expect(await exec(profile, `cat ${target}/.env`)).toContain('SECRET=1');
        expect(await exec(profile, `cat ${target}/app.js`)).toContain('build=2');
        // Владелец назван для всего, что оказалось в цели, — включая сохранённое
        expect(
          await exec(profile, `stat -c '%U' ${target}/.env 2>/dev/null || stat -f '%Su' ${target}/.env`)
        ).toContain('root');
        // Временная копия создаётся рядом с целью от root, и убрать её пользователь
        // профиля не может: уборка без sudo проваливается молча и оставляет след
        expect(
          await exec(profile, `ls -a /opt | grep -e '^\\.upload-' -e '^\\.bak-' || echo NONE`)
        ).toContain('NONE');

        await exec(profile, `rm -rf ${target}`);
      });

      it('merge и overwrite:false просят противоположного — отказ, цель не тронута', async () => {
        const target = `/tmp/merge-clash-${server.port}`;
        await liveTarget(profile, target);
        const local = await newBuild(`clash-${server.port}`);

        const answer = textOf(
          await callTool('ssh_upload', {
            profile,
            local_path: local,
            remote_path: target,
            merge: true,
            overwrite: false,
          })
        );

        expect(answer).toContain('overwrite: false');
        expect(await exec(profile, `cat ${target}/app.js`)).toContain('build=1');

        await exec(profile, `rm -rf ${target}`);
      });
    });
  }
}
