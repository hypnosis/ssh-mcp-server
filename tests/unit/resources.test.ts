/**
 * Ресурсы сервера: что он рассказывает о собственной настройке.
 *
 * Повод — живой случай: агент пошёл просить у человека пароль от роутера,
 * хотя вход уже лежал в профиле. Ему неоткуда было узнать ни какие машины
 * настроены, ни как устроен файл профилей.
 *
 * Отсюда два требования, и второе важнее первого: рассказать — и не проболтаться.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { reloadProfiles } from '../../src/utils/profile-resolver.js';
import { createMcpServer } from '../../src/mcp-server.js';

const CURRENT = 'ssh://profiles/current';
const EXAMPLE = 'ssh://profiles/example';

const PASSWORD = 'hunter2-not-for-sharing';
const PASSPHRASE = 'passphrase-not-for-sharing';
const KEY_PATH = '/home/nobody/.ssh/id_ed25519_secret_name';

/** Файл с профилем на ключе, профилем на пароле и одним испорченным */
const PROFILES = {
  profiles: {
    production: {
      host: 'server.example.com',
      username: 'deploy',
      port: 2222,
      privateKeyPath: KEY_PATH,
      passphrase: PASSPHRASE,
    },
    router: {
      host: '192.168.1.1',
      username: 'admin',
      password: PASSWORD,
    },
    inherited: {
      host: 'legacy.example.com',
      username: 'root',
    },
    staging: {
      host: 'staging.example.com',
      username: 'deploy',
      port: 70000,
    },
  },
};

const tempDirs: string[] = [];
let previousProfilesFile: string | undefined;
let client: Client;

async function connect(): Promise<Client> {
  const { server } = createMcpServer('test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const connected = new Client({ name: 'resources-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), connected.connect(clientTransport)]);
  return connected;
}

async function textOf(uri: string): Promise<string> {
  const { contents } = await client.readResource({ uri });
  return contents[0].text as string;
}

async function currentProfiles(): Promise<any> {
  return JSON.parse(await textOf(CURRENT));
}

beforeEach(async () => {
  previousProfilesFile = process.env.SSH_PROFILES_FILE;

  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-resources-'));
  tempDirs.push(dir);
  const path = join(dir, 'profiles.json');
  writeFileSync(path, JSON.stringify(PROFILES), 'utf8');
  process.env.SSH_PROFILES_FILE = path;
  reloadProfiles();

  client = await connect();
});

afterEach(async () => {
  await client.close();
  if (previousProfilesFile === undefined) delete process.env.SSH_PROFILES_FILE;
  else process.env.SSH_PROFILES_FILE = previousProfilesFile;
  try {
    reloadProfiles();
  } catch {
    /* без файла профилей перезагрузка законно отказывается */
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Ресурсы объявлены', () => {
  it('клиент видит оба, а не пустой список', async () => {
    const { resources } = await client.listResources();

    expect(resources.map((resource) => resource.uri).sort()).toEqual([CURRENT, EXAMPLE]);
  });

  it('у каждого есть имя и описание — иначе агент не поймёт, зачем открывать', async () => {
    const { resources } = await client.listResources();

    for (const resource of resources) {
      expect(resource.name, `${resource.uri}: без имени`).toBeTruthy();
      expect(resource.description, `${resource.uri}: без описания`).toBeTruthy();
    }
  });

  /**
   * Тип содержимого решает, разбирать ответ или читать глазами, и назван он
   * дважды: в списке и в самом ответе. Разойдись эти два места — клиент возьмёт
   * за JSON текст и наоборот.
   */
  it.each([
    [CURRENT, 'application/json'],
    [EXAMPLE, 'text/markdown'],
  ])('%s назван своим типом и в списке, и в ответе', async (uri, mimeType) => {
    const { resources } = await client.listResources();
    const { contents } = await client.readResource({ uri });

    expect(resources.find((resource) => resource.uri === uri)?.mimeType).toBe(mimeType);
    expect(contents[0].mimeType).toBe(mimeType);
  });

  it('незнакомый адрес получает отказ, а не пустоту', async () => {
    await expect(client.readResource({ uri: 'ssh://profiles/nope' })).rejects.toThrow(
      /Unknown resource/
    );
  });
});

describe('Настроенные профили', () => {
  it('называют машину так, как её зовут в вызовах', async () => {
    const { profiles } = await currentProfiles();

    expect(profiles.map((profile: any) => profile.name).sort()).toEqual([
      'inherited',
      'production',
      'router',
    ]);
  });

  it('адрес, порт и пользователь доезжают как есть', async () => {
    const { profiles } = await currentProfiles();

    expect(profiles.find((profile: any) => profile.name === 'production')).toMatchObject({
      host: 'server.example.com',
      port: 2222,
      username: 'deploy',
    });
  });

  it('порт по умолчанию назван числом, а не пропущен', async () => {
    const { profiles } = await currentProfiles();

    expect(profiles.find((profile: any) => profile.name === 'router').port).toBe(22);
  });

  /**
   * Способ входа — то, ради чего ресурс и заведён: агент, знающий, что вход по
   * ключу, не идёт просить пароль.
   */
  it.each([
    ['production', 'key'],
    ['router', 'password'],
    ['inherited', 'ssh-config'],
  ])('%s входит способом %s', async (name, auth) => {
    const { profiles } = await currentProfiles();

    expect(profiles.find((profile: any) => profile.name === name).auth).toBe(auth);
  });

  /**
   * Испорченный профиль есть в файле, и умолчать о нём — отправить читателя
   * искать опечатку в имени, которое на месте.
   */
  it('отвергнутый профиль назван вместе с причиной', async () => {
    const { broken } = await currentProfiles();

    expect(broken).toHaveLength(1);
    expect(broken[0].name).toBe('staging');
    expect(broken[0].problem).toContain('port');
  });
});

/**
 * Ресурс читает кто угодно, в том числе через клиента, который покажет его
 * целиком. Секрет, попавший сюда, утёк.
 */
describe('Секреты наружу не идут', () => {
  it.each([
    ['пароль', PASSWORD],
    ['фраза от ключа', PASSPHRASE],
    ['путь к ключу', KEY_PATH],
  ])('%s не появляется в списке машин', async (_what, secret) => {
    expect(await textOf(CURRENT)).not.toContain(secret);
  });

  it('слова password и passphrase не приходят полями', async () => {
    const { profiles } = await currentProfiles();

    for (const profile of profiles) {
      expect(Object.keys(profile).sort()).toEqual(['auth', 'host', 'name', 'port', 'username']);
    }
  });
});

describe('Образец файла профилей', () => {
  it.each([
    ['host'],
    ['username'],
    ['privateKeyPath'],
    ['secretsFile'],
    ['strictHostKeyChecking'],
    ['pathSecurity'],
  ])('называет поле %s, иначе агент придумает своё', async (field) => {
    expect(await textOf(EXAMPLE)).toContain(field);
  });

  /**
   * Разбор полей, а не весь образец: слово `sudoPassword` встречается и в примере
   * файла секретов ниже, поэтому поиск по всему тексту зеленел бы и без описания.
   */
  it('объясняет sudoPassword там, где разбирает поля профиля', async () => {
    const text = await textOf(EXAMPLE);
    const fields = text.slice(text.indexOf('## Fields of a profile'), text.indexOf('## Secrets file'));

    expect(fields).toContain('sudoPassword');
  });

  it('называет переменную, из которой берётся путь к файлу', async () => {
    expect(await textOf(EXAMPLE)).toContain('SSH_PROFILES_FILE');
  });

  it('отсылает секреты в отдельный файл и требует прав только владельцу', async () => {
    const text = await textOf(EXAMPLE);

    expect(text).toContain('chmod 600');
    expect(text).toContain('"passphrase"');
    // Пароль для sudo — такой же секрет: образец секретов показывает и его
    expect(text).toContain('"sudoPassword"');
  });

  it('образец не притворяется настройкой этой машины', async () => {
    expect(await textOf(EXAMPLE)).not.toContain('192.168.1.1:');
  });
});
