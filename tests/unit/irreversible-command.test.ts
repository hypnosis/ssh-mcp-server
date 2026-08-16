/**
 * Unit tests: разбор команд, уносящих данные навсегда
 *
 * У каждого имени проверяются обе стороны: вызов обязан получить отказ,
 * упоминание того же слова — пройти молча. Сторож, отказывающий всегда,
 * бесполезен ровно так же, как молчащий.
 */

import { describe, it, expect } from 'vitest';
import { inspectIrreversible } from '../../src/utils/irreversible-command.js';
import { CONFIRMATION_MARKER } from '../../src/utils/destructive-command.js';

const blocked = (command: string): boolean => inspectIrreversible(command).blocked;

describe('остановка машины', () => {
  it.each([['reboot'], ['shutdown'], ['halt'], ['poweroff']])(
    '%s — отказ',
    (command) => {
      expect(blocked(command)).toBe(true);
    }
  );

  it.each([
    ['sudo shutdown -r +1'],
    ['timeout 5 poweroff'],
    ['/sbin/halt'],
    ['nice -n 10 reboot'],
    ['env DEBUG=1 poweroff'],
    ['uptime && reboot'],
    ['uptime; reboot'],
  ])('%s — обёртка и цепочка отказ не отменяют', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['test -f /var/run/reboot-required'],
    ['grep reboot /var/log/syslog'],
    ['cat /var/log/shutdown.log'],
    ['ls -la /etc/init.d/halt'],
    ['systemctl status poweroff.target'],
    ['echo halt'],
    ['git commit -m "fix; reboot handler"'],
  ])('%s — упоминание, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it('отказ называет команду, из-за которой остановлен', () => {
    expect(inspectIrreversible('sudo shutdown -h now').reason).toContain('"shutdown"');
  });
});

describe('docker: тома против контейнеров', () => {
  it.each([
    ['docker compose down -v'],
    ['docker compose down --volumes'],
    ['docker-compose down -v'],
    ['docker volume rm pgdata'],
    ['docker volume prune -f'],
    ['docker system prune -a'],
    ['docker system prune --volumes'],
  ])('%s — отказ', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['docker compose down'],
    ['docker-compose down'],
    ['docker compose up -d'],
    ['docker compose restart'],
    ['docker image prune -a'],
    ['docker volume ls'],
    ['docker volume inspect pgdata'],
    ['docker ps -a'],
    ['docker rm -f old-app'],
    ['docker system df'],
    ['docker system prune'],
  ])('%s — штатная работа, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it.each([
    ['docker -H unix:///var/run/docker.sock compose down -v'],
    ['docker --context remote volume rm pgdata'],
    ['docker compose -f prod.yml down -v'],
    ['docker compose -p app -f prod.yml down --volumes'],
  ])('%s — глобальные флаги подкоманду не прячут', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it('значение флага за подкоманду не принимается', () => {
    expect(blocked('docker --context volume ps')).toBe(false);
  });

  it('флаг без значения подкоманду не съедает', () => {
    expect(blocked('docker --debug volume rm pgdata')).toBe(true);
  });

  // Каждый флаг списка проверяется отдельно: пропущенный уводит подкоманду
  // в значение, и снос тома проезжает молча
  it.each([
    ['-H tcp://node:2375'],
    ['--host tcp://node:2375'],
    ['-c remote'],
    ['--context remote'],
    ['--config /etc/docker'],
    ['-l debug'],
    ['--log-level debug'],
    ['-f prod.yml'],
    ['--file prod.yml'],
    ['-p app'],
    ['--project-name app'],
    ['--project-directory /srv/app'],
    ['--env-file .env.prod'],
    ['--profile worker'],
  ])('docker %s volume rm pgdata — значение флага подкоманду не прячет', (flag) => {
    expect(blocked(`docker ${flag} volume rm pgdata`)).toBe(true);
  });

  it('«не спрашивай» и «всё сразу» рядом — тот же снос', () => {
    expect(blocked('docker system prune -f -a')).toBe(true);
  });

  it.each([
    ['docker compose run -v /data:/data app', 'том монтируется, а не сносится'],
    ['docker stack down -v', 'правило написано про compose'],
    ['docker container rm old-app', 'контейнер, а не том'],
    ['docker system df -a', 'осмотр места, а не уборка'],
  ])('%s — %s', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it.each([['docker system prune -af'], ['docker system prune -fa']])(
    '%s — слитные флаги читаются',
    (command) => {
      expect(blocked(command)).toBe(true);
    }
  );

  it('другой движок контейнеров под правило не подпадает', () => {
    expect(blocked('podman volume rm pgdata')).toBe(false);
  });

  it('та же строка в тексте команду не блокирует', () => {
    expect(blocked('echo "docker volume rm pgdata" >> /root/notes.txt')).toBe(false);
  });

  it('отказ называет, что именно уносится', () => {
    expect(inspectIrreversible('docker compose down -v').reason).toContain('volumes');
  });
});

describe('маркер подтверждения', () => {
  it.each([['reboot'], ['shutdown'], ['halt'], ['poweroff']])(
    '%s с маркером проходит',
    (command) => {
      expect(blocked(`${command} ${CONFIRMATION_MARKER}`)).toBe(false);
    }
  );

  it('чужой текст маркером не считается', () => {
    expect(blocked('reboot # confirmed')).toBe(true);
  });
});
