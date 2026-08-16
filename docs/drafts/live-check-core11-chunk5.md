# Живая проверка починок чанка 5

Запускает владелец: лабораторию поднимает он. Без этой проверки Б1 не считается
сделанным — код и зелёные юниты доказательством не являются (§1 CLAUDE.md).

Проверять на обоих контейнерах: `mcp-alpine` (BusyBox, порт 2231) и `mcp-debian`
(coreutils, 2232). Наборы утилит расходятся молча, и правка Б1 опирается как раз
на расходящиеся места: `cp --`, `chown`, `mv -T --`, код сторожа времени.

## 0. Утилиты понимают то, на что теперь опирается загрузка

```bash
for P in 2231 2232; do
  ssh -i .lab/key -p $P -o ControlPath=none -o StrictHostKeyChecking=no root@127.0.0.1 \
    'cd /tmp && printf x > a && cp -- a b && printf y > c && mv -T -- c b && cat b \
     && chown root:root b && echo PROBE-OK; rm -f a b c'
done
```

Успех — `y` и `PROBE-OK` на обоих портах. Отказ BusyBox от `mv -T` или непонятый
`--` виден здесь, а не тремя шагами позже.

## 1. Существующие живые наборы

```bash
npm run lab:up
SSH_MCP_LIVE=1 npx vitest run tests/live/sudo-path.live.test.ts tests/live/transfer.live.test.ts
```

Смотреть особо: «передача под sudo ставит файл с заказанными правами и владельцем»
(проверяет `640 root:root` и содержимое отдельным входом под root) и «после
sudo-передачи в /tmp не остаётся следов». Оба должны пройти и на BusyBox, и на
coreutils.

## 2. Инвариант сохранности — то, что юниты могут только сымитировать

Прерванная привилегированная запись обязана оставить прежний файл целым.
Повторить для `P=2231` и `P=2232`.

```bash
P=2231
SSH="ssh -i .lab/key -p $P -o ControlPath=none -o StrictHostKeyChecking=no root@127.0.0.1"

$SSH "mkdir -p /opt/preserve && printf 'OLD-CONTENT\n' > /opt/preserve/app.conf \
      && chmod 600 /opt/preserve/app.conf && sha256sum /opt/preserve/app.conf"

dd if=/dev/urandom of=/tmp/big.bin bs=1m count=400
```

Затем вызвать инструмент по профилю с `username: deploy` и NOPASSWD sudo (форма
профиля — как в `tests/live/sudo-path.live.test.ts:28-46`):

```
ssh_upload { local_path: "/tmp/big.bin", remote_path: "/opt/preserve/app.conf",
             sudo: true, mode: "644", owner: "root:root", timeout: 2000 }
```

Проверка:

```bash
$SSH "cat /opt/preserve/app.conf; sha256sum /opt/preserve/app.conf; \
      ls -A /opt/preserve; ls -A /tmp | grep '^\.ssh-mcp-upload-'; echo ---"
```

Успех — все четыре сразу:

- инструмент ответил ошибкой, а не `Upload OK`;
- `app.conf` по-прежнему `OLD-CONTENT` с тем же sha256, что при подготовке;
- в `/opt/preserve` не осталось `.upload-*` (установщик выбросил временный путь);
- в `/tmp` не осталось `.ssh-mcp-upload-*`.

Ожидаемое расхождение контейнеров: в тексте ошибки код сторожа времени — **124 на
coreutils, 143 на BusyBox**. Исход один и тот же; ловушка — прочитать голый `143`
как «команда сама упала».

На старом коде этот шаг оставлял `app.conf` пустым или недописанным, а копию в
`/tmp` уже удалённой. В этом и была суть правки.

## 3. Удачный путь на той же цели

Тот же вызов без `timeout`. Ожидается `✓ Upload OK`, `atomic: true`, `sudo: true`,
`sha256 … (verified)` и:

```bash
$SSH "stat -c '%a %U:%G' /opt/preserve/app.conf; ls -A /opt/preserve; \
      ls -A /tmp | grep '^\.ssh-mcp-upload-'"
```

→ `644 root:root`, ни одного `.upload-*`, ни одного следа в `/tmp`.

Убрать за собой: `$SSH "rm -rf /opt/preserve"`, `rm -f /tmp/big.bin`.

## Что ещё стоит проверить живьём

- **В4** — правило `deniedPaths` в непричёсанном виде (`//root`, `/var/./www`)
  доезжает от файла профилей до инструмента и срабатывает.
- **М6** — загрузка файла с именем, начинающимся с дефиса.
- **М7** — если решим делать glob по-настоящему, проверять здесь же.
