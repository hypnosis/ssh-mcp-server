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
    ['sudo -u deploy reboot'],
    ['sudo --user deploy shutdown -h now'],
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

describe('снос базы против работы с таблицами', () => {
  it.each([
    ['dropdb production'],
    ['sudo -u postgres dropdb app'],
    ['psql -c "DROP DATABASE app;"'],
    ["psql -c 'drop database app;'"],
    ['mysqladmin -u root drop appdb'],
    ['redis-cli FLUSHALL'],
    ['redis-cli -h db -p 6379 FLUSHALL'],
    ['redis-cli flushdb'],
  ])('%s — отказ', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['psql -c "DROP TABLE sessions;"'],
    ['psql -c "TRUNCATE users;"'],
    ['psql -c "DELETE FROM users;"'],
    ['createdb app'],
    ['psql -l'],
    ['psql -f migrations/003.sql'],
    ['mysqladmin -u root status'],
    ['redis-cli KEYS "*"'],
    ['redis-cli INFO'],
  ])('%s — работа внутри базы, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it('запрос без клиента БД — это просто текст', () => {
    expect(blocked('echo "DROP DATABASE app;" >> /root/notes.sql')).toBe(false);
  });

  it('чтение файла с таким запросом тревоги не поднимает', () => {
    expect(blocked('cat migrations/004_drop_database.sql')).toBe(false);
  });

  it('запрос из файла разбором не виден — это признанная граница', () => {
    expect(blocked('psql -f drop.sql')).toBe(false);
    expect(blocked('psql < dump.sql')).toBe(false);
  });

  it.each([['mysql'], ['mariadb'], ['sqlite3'], ['mongo'], ['mongosh'], ['clickhouse-client']])(
    '%s — клиент из списка запрос показывает',
    (client) => {
      expect(blocked(`${client} -e "DROP DATABASE app;"`)).toBe(true);
    }
  );

  it('отказ называет, что уносится', () => {
    expect(inspectIrreversible('dropdb app').reason).toContain('database');
    expect(inspectIrreversible('psql -c "DROP DATABASE app;"').reason).toContain('DROP DATABASE');
  });

  it('запрос разбит переносами и лишними пробелами — тот же снос', () => {
    expect(blocked('psql -c "DROP   DATABASE app;"')).toBe(true);
  });

  it('клиент БД среди других команд запрос всё равно показывает', () => {
    expect(blocked('psql -c "DROP DATABASE app;" && echo done')).toBe(true);
  });

  it.each([
    ['echo drop'],
    ['echo FLUSHALL'],
    ['redis-cli GET flushall-pending'],
    ['redis-cli SET pending-flushall 1'],
  ])('%s — слово не в позиции команды, отказа нет', (command) => {
    expect(blocked(command)).toBe(false);
  });
});

describe('задания cron', () => {
  it.each([
    ['crontab -r'],
    ['sudo crontab -r'],
    ['sudo crontab -u deploy -r'],
    ['crontab -r -u deploy'],
    ['/usr/bin/crontab -r'],
  ])('%s — отказ', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['crontab -l'],
    ['crontab -e'],
    ['crontab /etc/cron.d/new'],
    ['crontab -u deploy -l'],
    ['crontab -'],
    ['echo "* * * * * echo hi" | crontab -'],
  ])('%s — работа с заданиями, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it('соседняя буква заданий не трогает', () => {
    expect(blocked('crontab -e')).toBe(false);
    expect(blocked('crontab -r')).toBe(true);
  });

  it('та же строка в тексте отказа не поднимает', () => {
    expect(blocked('grep -rn "crontab -r" /srv/scripts')).toBe(false);
  });

  it.each([
    ['cp -r /srv/app /srv/app.bak'],
    ['grep -r pattern /srv/app'],
    ['ls -r /var/log'],
    ['sort -r /tmp/list'],
  ])('%s — тот же флаг у другой команды заданий не касается', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it('отказ называет, что уносится', () => {
    expect(inspectIrreversible('crontab -r').reason).toContain('cron job');
  });
});

describe('диски и тома', () => {
  it.each([
    ['mkfs.ext4 /dev/sdb1'],
    ['mkfs.xfs /dev/sdb1'],
    ['mkfs -t ext4 /dev/sdb1'],
    ['sudo mkfs.btrfs /dev/sdb1'],
    ['wipefs -a /dev/sdb'],
    ['wipefs --all /dev/sdb'],
    ['lvremove /dev/vg0/data'],
    ['vgremove vg0'],
    ['pvremove /dev/sdb1'],
    ['zfs destroy tank/db'],
    ['btrfs subvolume delete /mnt/snap'],
    ['btrfs sub del /mnt/snap'],
  ])('%s — отказ', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['wipefs /dev/sdb'],
    ['lvs'],
    ['vgs'],
    ['pvs'],
    ['lvdisplay /dev/vg0/data'],
    ['zfs list'],
    ['zfs get all tank/db'],
    ['btrfs subvolume list /'],
    ['btrfs filesystem df /'],
    ['blkid /dev/sdb'],
    ['lsblk'],
  ])('%s — осмотр носителя, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it('имя команды должно совпасть целиком', () => {
    expect(blocked('mkfstest /dev/sdb1')).toBe(false);
    expect(blocked('lvremove-helper --dry-run')).toBe(false);
    expect(blocked('premkfs.ext4 /dev/sdb1')).toBe(false);
  });

  it.each([
    ['echo destroy tank/db'],
    ['echo sub del /mnt/snap'],
    ['grep destroy /srv/scripts/zfs.sh'],
  ])('%s — слово не в позиции команды, отказа нет', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it.each([['btrfs'], ['btrfs subvolume'], ['zfs'], ['btrfs delete subvolume']])(
    '%s — команда неполная, отказа нет',
    (command) => {
      expect(blocked(command)).toBe(false);
    }
  );

  it('флаг перед подкомандой её не прячет', () => {
    expect(blocked('btrfs -v subvolume delete /mnt/snap')).toBe(true);
    expect(blocked('zfs -n destroy tank/db')).toBe(true);
  });

  it('подкоманда в кавычках читается так же', () => {
    expect(blocked('zfs "destroy" tank/db')).toBe(true);
  });

  it('пустой аргумент сокращением не считается', () => {
    expect(blocked('btrfs "" ""')).toBe(false);
    expect(blocked('btrfs "" delete /mnt/snap')).toBe(false);
  });
});

describe('dd: опасен приёмник, а не команда', () => {
  it.each([
    ['dd if=/dev/zero of=/dev/sda'],
    ['dd if=/dev/zero of=/dev/sda1 bs=1M count=100'],
    ['dd of=/dev/disk/by-id/wwn-0x5000 if=/dev/zero'],
  ])('%s — отказ: пишет поверх устройства', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['dd if=/dev/zero of=/swapfile bs=1M count=2048'],
    ['dd if=/dev/sda of=/backup/disk.img'],
    ['dd if=/dev/zero of=/dev/null'],
    ['dd if=/dev/urandom of=/dev/zero count=1'],
    ['dd if=/dev/sda | gzip > /backup/disk.gz'],
    ['dd if=/etc/hosts of=/tmp/hosts.copy'],
  ])('%s — штатная работа, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it.each([['/dev/null'], ['/dev/zero'], ['/dev/random'], ['/dev/urandom'], ['/dev/stdout'], ['/dev/stderr'], ['/dev/tty']])(
    'запись в %s ничего не портит',
    (device) => {
      expect(blocked(`dd if=/dev/zero of=${device}`)).toBe(false);
    }
  );

  it.each([
    ['dd if=/dev/zero of="$DISK"'],
    ['dd if=/dev/zero of=$(cat /tmp/target)'],
    ['dd if=/dev/zero of=/dev/sd*'],
  ])('%s — раскрывает сервер, проверить нечем', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['dd if=/dev/zero of="/dev/sda"'],
    ["dd if=/dev/zero of='/dev/sda'"],
    ['dd if=/dev/zero of="$DISK"'],
  ])('%s — кавычки вокруг значения приёмник не прячут', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it('отказ называет устройство, которое пострадает', () => {
    expect(inspectIrreversible('dd if=/dev/zero of=/dev/sda').reason).toContain('/dev/sda');
  });

  it('в отказе имя приёмника читается без лишних кавычек', () => {
    expect(inspectIrreversible('dd if=/dev/zero of="$DISK"').reason).toContain('"$DISK"');
  });
});

describe('чтение после уничтожения', () => {
  it.each([
    ['rm -rf /srv/app && cp -r /srv/app /backup'],
    ['rm -rf /srv/app; tar czf /backup/app.tgz /srv/app'],
    ['rm -rf /srv/app && rsync -a /srv/app/ /backup/'],
    ['rm -rf /srv/app && cp -r /srv/app/data /backup'],
    ['rm -rf /srv/app && cp -t /backup /srv/app'],
    ['rm -rf /srv/app && dd of=/backup/app.img if=/srv/app'],
    ['dropdb app && pg_dump app > /backup/app.sql'],
    ['mv /srv/app /srv/app2 && cp -r /srv/app /backup'],
    ['rm -rf /srv/app && tar -czf /backup/app.tgz /srv/app'],
  ])('%s — отказ', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['cp -r /srv/app /backup && rm -rf /srv/app'],
    ['rm -rf /srv/app && cp -r ./build /srv/app'],
    ['rm -rf /srv/app && rsync -a ./build/ /srv/app/'],
    ['rm -rf /srv/app && mkdir -p /srv/app'],
    ['rm -rf /srv/app && git clone https://example.com/app /srv/app'],
    ['rm -rf /srv/app && cp -r /srv/other /backup'],
    ['rm -rf /srv/app/build && tar czf /backup/app.tgz /srv/app'],
    ['rm -rf /srv/app && ls /srv/app'],
    ['rm -rf /srv/app && test -d /srv/app'],
    ['rm -rf /srv/app && stat /srv/app'],
    ['rm -rf /srv/app && rm -rf /srv/app/logs'],
    ['tar czf /backup/app.tgz /srv/app && rm -rf /srv/app'],
    ['rm -rf /srv/app && touch /srv/app'],
    ['rm -rf /srv/cache && mkdir /srv/cache'],
  ])('%s — правильный порядок или другой объект, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it('хвостовой слэш и «./» тем же объектом быть не перестают', () => {
    expect(blocked('rm -rf /srv/app/ && cp -r /srv/app /backup')).toBe(true);
    expect(blocked('rm -rf /srv/app// && cp -r /srv/app /backup')).toBe(true);
    expect(blocked('rm -rf ./app && cp -r app /backup')).toBe(true);
  });

  it('дефис в конце имени флагом путь не делает', () => {
    expect(blocked('rm -rf /srv/app- && cp -r /srv/app- /backup')).toBe(true);
  });

  it('ключ архиватора читается целым словом, а не куском', () => {
    expect(blocked('rm -rf /srv/app && tar --xf /backup/app.tgz /srv/app')).toBe(false);
  });

  it('«./» посреди пути частью имени и остаётся', () => {
    expect(blocked('rm -rf /srv/./app && cp -r /srv/app /backup')).toBe(false);
  });

  it('вложенность считается только вниз', () => {
    expect(blocked('rm -rf /srv/app && cp -r /srv/app/data /backup')).toBe(true);
    expect(blocked('rm -rf /srv/app/data && cp -r /srv/app /backup')).toBe(false);
  });

  it('сосед по имени за вложенность не принимается', () => {
    expect(blocked('rm -rf /srv/app && cp -r /srv/app-old /backup')).toBe(false);
  });

  it('перенос уносит источник, а приёмник, наоборот, появляется', () => {
    expect(blocked('mv /srv/app /srv/new && cp -r /srv/new /backup')).toBe(false);
    expect(blocked('mv /srv/app /srv/new && cp -r /srv/app /backup')).toBe(true);
  });

  it('у переноса приёмник тоже бывает назван флагом', () => {
    expect(blocked('mv -t /srv/new /srv/app && cp -r /srv/app /backup')).toBe(true);
    expect(blocked('mv -t /srv/new /srv/app && cp -r /srv/new /backup')).toBe(false);
  });

  it.each([
    ['rm -rf /srv/app && cp -rf /srv/app /backup', 'ключ f у копии — «не спрашивай», не архив'],
    ['rm -rf /srv/a /srv/b && cp -r /srv/b /backup', 'уничтожено несколько объектов'],
    ['mv /srv/a /srv/b /dest && cp -r /srv/b /backup', 'у переноса источников несколько'],
    ['rm -rf -- /srv/app && cp -r /srv/app /backup', 'разделитель аргументов'],
    ['rm -rf "/srv/app" && cp -r /srv/app /backup', 'кавычки вокруг пути'],
  ])('%s — отказ (%s)', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    ['tar czf /backup/app.tgz /srv/app && rm -rf /srv/app'],
    ['zip -r /backup/app.zip /srv/app && rm -rf /srv/app'],
    ['rm -rf /backup/app.tgz && tar czf /backup/app.tgz /srv/app'],
    ['rm -rf /backup/app.zip && zip -r /backup/app.zip /srv/app'],
    ['rm -rf /srv/app && cp -r /srv/other /srv/app'],
  ])('%s — приёмник пересоздаётся, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it.each([
    ['rm -rf /srv/app && tar czf'],
    ['rm -rf /srv/app && cp -t'],
    ['rm -rf /srv/app && zip -r'],
  ])('%s — команда оборвана, отказа нет и разбор не падает', (command) => {
    expect(blocked(command)).toBe(false);
  });

  // Приёмник ищется в одной позиции — последней либо названной флагом. Утилита,
  // у которой он стоит посередине и флагом не помечен, не разбирается вовсе
  // На одном аргументе осмотр и так молчит — его единственный путь считается
  // приёмником. Список нужен там, где путей несколько
  it.each([
    ['rm -rf /srv/app && ls /srv/app /srv/other'],
    ['rm -rf /srv/app && stat /srv/app /srv/other'],
    ['rm -rf /srv/app && test -d /srv/app -a -d /srv/other'],
    ['rm -rf /srv/app && rm -rf /srv/app/logs /srv/app/tmp'],
    ['rm -rf /srv/app /srv/cache; mkdir -p /srv/app /srv/cache'],
    ['rm -rf /srv/app /srv/cache && touch /srv/app /srv/cache'],
    ['rm -rf /srv/app /srv/cache && mkfifo /srv/app /srv/cache'],
  ])('%s — данных не читает, команда проходит', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it('команда не из списка уничтожителей объектов не лишает', () => {
    expect(blocked('cp -r /srv/app /backup && cp -r /srv/app /other')).toBe(false);
    expect(blocked('tar czf /backup/app.tgz /srv/app && cp -r /srv/app /other')).toBe(false);
  });

  it.each([
    ['rm -rf /srv/app && cp --target-directory /backup /srv/app'],
    ['rm -rf /srv/app && rsync --target-dir /backup /srv/app'],
  ])('%s — приёмник назван флагом, источник остаётся источником', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it('приёмник у dd назван присваиванием, а не позицией', () => {
    expect(blocked('rm -rf /backup/app.img && dd of=/backup/app.img if=/srv/app')).toBe(false);
    expect(blocked('rm -rf /srv/app && dd of=/backup/app.img if=/srv/app')).toBe(true);
  });

  it('у zip приёмник первый: и потеря видна, и пересоздание архива молчит', () => {
    expect(blocked('rm -rf /srv/app && zip -r /backup/app.zip /srv/app')).toBe(true);
    expect(blocked('rm -rf /backup/app.zip && zip -r /backup/app.zip /srv/app')).toBe(false);
  });

  // Приёмник ищется в одной позиции — последней либо названной флагом. Утилита,
  // у которой он стоит посередине и флагом не помечен, не разбирается вовсе
  it.each([
    ['rm -rf /srv/db && pg_restore /srv/db/dump.sql', 'единственный аргумент сочтён приёмником'],
    ['rm -rf /srv/app && tar --file /backup/app.tgz -c /srv/app', 'длинная форма ключа'],
  ])('%s — граница разбора, команда проходит (%s)', (command) => {
    expect(blocked(command)).toBe(false);
  });

  it('отказ называет объект и виновника', () => {
    const reason = inspectIrreversible('rm -rf /srv/app && cp -r /srv/app /backup').reason;

    expect(reason).toContain('/srv/app');
    expect(reason).toContain('destroyed');
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
