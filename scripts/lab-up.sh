#!/usr/bin/env bash
#
# Лаборатория для живых тестов передачи файлов.
#
# Два контейнера с разными наборами утилит: Alpine (BusyBox, bash нет) и
# Debian (coreutils, sh это dash). Расхождения между ними ловят половину
# дефектов, которые моки не видят вовсе.
#
# Третий контейнер — mcp-router: имитация домашнего роутера/встраиваемого
# устройства. На таких sshd часто dropbear, а не OpenSSH, и subsystem sftp
# не собран вовсе — только классический scp. Профиль для него держим вне
# LAB_SERVERS (см. tests/live/lab.ts): общая сетка гоняет sftp-путь, а этот
# узел его провалит по определению.
#
# Скрипт идемпотентен: живые контейнеры не трогает, мёртвые пересоздаёт.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB_DIR="$REPO_ROOT/.lab"
KEY="$LAB_DIR/key"

ALPINE_PORT=2231
DEBIAN_PORT=2232
ROUTER_PORT=2233
DIND_PORT=2234

# Пароль лабораторного пользователя pwuser. Дублируется в tests/live/lab.ts —
# одно значение на shell и на тесты, поэтому меняется в двух местах сразу.
export LAB_PASSWORD='lab-pwd-9c4e1a'

if ! command -v docker >/dev/null 2>&1; then
  echo "docker не найден — лабораторию поднять нечем" >&2
  exit 1
fi

mkdir -p "$LAB_DIR"

if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N '' -C ssh-mcp-lab -f "$KEY" >/dev/null
  echo "ключ создан: $KEY"
fi

# Проба: ключ подходит и sshd отвечает
probe() {
  local port="$1"
  ssh -q -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=3 -i "$KEY" -p "$port" root@127.0.0.1 true 2>/dev/null
}

# Пользователь без привилегий с NOPASSWD-sudo — на нём проверяется поведение под sudo
#
# Про строку с shadow. Пользователь без пароля заводится с «!» в /etc/shadow, и это
# не пустой пароль, а запертая учётка. Alpine это уважает и не пускает даже по ключу
# («Permission denied (publickey)»), Debian — пускает. Полгода расхождение выглядело
# как «sudo проверен на обоих», хотя весь sudo-путь живьём видел только coreutils.
# «*» означает «паролем не входить», но учётку не запирает — вход по ключу работает.
ensure_deploy() {
  docker exec "$1" sh -c '
    id deploy >/dev/null 2>&1 || adduser -D deploy 2>/dev/null || useradd -m -s /bin/sh deploy
    sed -i "s/^deploy:!:/deploy:*:/" /etc/shadow
    mkdir -p /home/deploy/.ssh
    cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
    chown -R deploy:deploy /home/deploy/.ssh
    chmod 700 /home/deploy/.ssh
    chmod 600 /home/deploy/.ssh/authorized_keys
    echo "deploy ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/deploy
    chmod 440 /etc/sudoers.d/deploy
  ' >/dev/null
}

# Пользователь, который входит по паролю, а не по ключу — на нём проверяется
# доставка секрета через askpass. Ключа у него нет намеренно: с ключом ssh
# вошёл бы по нему и парольная ветка осталась бы непроверенной.
#
# Значение пароля едет в контейнер переменной окружения, а не словом в команде:
# в argv оно было бы видно всей системе через ps — ровно то, что проверяет
# живой тест. Правки sshd не нужны: PasswordAuthentication на обоих образах
# включён по умолчанию (замерено через `sshd -T`).
ensure_pwuser() {
  docker exec -e LAB_PASSWORD "$1" sh -c '
    id pwuser >/dev/null 2>&1 || adduser -D pwuser >/dev/null 2>&1 || useradd -m -s /bin/sh pwuser
    # Alpine рапортует об успехе в stderr, Debian молчит — глушим только этот шум
    echo "pwuser:$LAB_PASSWORD" | chpasswd 2>/dev/null
    # Права даются с паролем, в отличие от deploy: это единственное место, где
    # видно, доходит ли пароль профиля до sudo. Без пароля sudo ищет терминал,
    # не находит и отказывает — ровно то, на чём спотыкался агент
    echo "pwuser ALL=(ALL) ALL" > /etc/sudoers.d/pwuser
    chmod 440 /etc/sudoers.d/pwuser
  ' >/dev/null
}

# Третья группа: входит по ключу, а sudo у него спрашивает пароль. Ни deploy
# (ключ и NOPASSWD), ни pwuser (пароль на вход) этот случай не покрывают, а он и
# есть тот, где вход и повышение прав требуют разных секретов: пароля входа у
# такого профиля нет вовсе, и sudo отвечает ему только `sudoPassword`.
ensure_keyuser() {
  docker exec -e LAB_PASSWORD "$1" sh -c '
    id keyuser >/dev/null 2>&1 || adduser -D keyuser >/dev/null 2>&1 || useradd -m -s /bin/sh keyuser
    echo "keyuser:$LAB_PASSWORD" | chpasswd 2>/dev/null
    mkdir -p /home/keyuser/.ssh
    cp /root/.ssh/authorized_keys /home/keyuser/.ssh/authorized_keys
    chown -R keyuser /home/keyuser/.ssh
    chmod 700 /home/keyuser/.ssh
    chmod 600 /home/keyuser/.ssh/authorized_keys
    echo "keyuser ALL=(ALL) ALL" > /etc/sudoers.d/keyuser
    chmod 440 /etc/sudoers.d/keyuser
  ' >/dev/null
}

# Пользователь с вендорской оболочкой: команд POSIX она не знает и на любую
# отвечает кодом 127 со своим текстом — так ведут себя роутеры и встраиваемые
# устройства с собственным CLI. На нём проверяется состояние `limited`:
# соединение рабочее, но пробная команда `true` серверу неизвестна.
ensure_vendorcli() {
  docker exec "$1" sh -c '
    cat > /usr/local/bin/vendorsh <<"SHELL"
#!/bin/sh
echo "Command::Base error[7405600]: no such command: ${2:-login}." >&2
exit 127
SHELL
    chmod 755 /usr/local/bin/vendorsh
    id vendorcli >/dev/null 2>&1 ||
      adduser -D -s /usr/local/bin/vendorsh vendorcli 2>/dev/null ||
      useradd -m -s /usr/local/bin/vendorsh vendorcli
    # Оболочка задаётся и уже заведённому пользователю: без этого контейнер,
    # переживший правку скрипта, оставался бы с прежней оболочкой
    sed -i "s#^\(vendorcli:.*\):[^:]*\$#\1:/usr/local/bin/vendorsh#" /etc/passwd
    sed -i "s/^vendorcli:!:/vendorcli:*:/" /etc/shadow
    mkdir -p /home/vendorcli/.ssh
    cp /root/.ssh/authorized_keys /home/vendorcli/.ssh/authorized_keys
    chown -R vendorcli:vendorcli /home/vendorcli/.ssh
    chmod 700 /home/vendorcli/.ssh
    chmod 600 /home/vendorcli/.ssh/authorized_keys
  ' >/dev/null
}

# Лабораторные пользователи. Заводятся и на свежем контейнере, и на уже
# поднятом: иначе после правки скрипта пришлось бы сносить лабораторию руками.
ensure_users() {
  ensure_deploy "$1"
  ensure_pwuser "$1"
  ensure_keyuser "$1"
  ensure_vendorcli "$1"
}

start() {
  local name="$1" image="$2" port="$3" boot="$4" caps="${5:-}"

  docker rm -f "$name" >/dev/null 2>&1 || true

  # Новый контейнер — новый ключ хоста, а в known_hosts остаётся прежний.
  # Само по себе это не чинится профилем: StrictHostKeyChecking=no пропускает
  # незнакомый ключ, но не изменившийся, а отказ от ~/.ssh/config known_hosts
  # не отключает. Без этой строки живая сетка падает после каждого пересоздания
  # лаборатории с «REMOTE HOST IDENTIFICATION HAS CHANGED».
  ssh-keygen -R "[127.0.0.1]:$port" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086 — $caps раскрывается по словам намеренно
  docker run -d --name "$name" -p "$port:22" $caps \
    -v "$KEY.pub:/tmp/authkey:ro" "$image" sh -c "$boot" >/dev/null

  # sshd поднимается после установки пакетов — на Debian это десятки секунд
  local waited=0
  until probe "$port"; do
    waited=$((waited + 1))
    if [ "$waited" -gt 90 ]; then
      echo "$name не ответил за 90 секунд" >&2
      docker logs --tail 20 "$name" >&2
      exit 1
    fi
    sleep 1
  done

  ensure_users "$name"
  echo "$name готов на порту $port"
}

# Права на сеть: без них даже root не читает правила — `iptables -nL` отвечает
# «Permission denied», и ветка «прочитали под sudo» непроверяема. ufw в Alpine
# нет вовсе, и это второй нужный исход: экран не установлен.
LAB_CAPS='--cap-add=NET_ADMIN --cap-add=NET_RAW'

ALPINE_BOOT='apk add --no-cache openssh sudo iptables >/dev/null && ssh-keygen -A &&
  mkdir -p /root/.ssh && cp /tmp/authkey /root/.ssh/authorized_keys &&
  chmod 600 /root/.ssh/authorized_keys && /usr/sbin/sshd -D -e'

DEBIAN_BOOT='apt-get update -qq >/dev/null && apt-get install -y -qq openssh-server sudo ufw iptables >/dev/null &&
  mkdir -p /run/sshd /root/.ssh && cp /tmp/authkey /root/.ssh/authorized_keys &&
  chmod 600 /root/.ssh/authorized_keys && /usr/sbin/sshd -D -e'

# openssh-client — только ради бинаря scp: пакету dropbear он не нужен, сервер
# при классическом scp сам его не запускает (это делает клиент), но remote-конец
# scp-протокола запускает `scp` на сервере, и без пакета его там не будет.
# sftp-server эта установка не добавляет — он живёт в openssh-server, которого
# здесь нет и не будет: это и есть весь смысл узла.
#
# sha256sum снят намеренно: это единственный узел лаборатории, где сверку нечем
# выполнить, а «проверить было нечем» — третий исход передачи, отличный и от
# сошлось, и от не сошлось. Openssl здесь нет ни у одного образа.
ROUTER_BOOT='apk add --no-cache dropbear openssh-client >/dev/null &&
  rm -f /usr/bin/sha256sum &&
  mkdir -p /root/.ssh && cp /tmp/authkey /root/.ssh/authorized_keys &&
  chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys &&
  /usr/sbin/dropbear -F -E -R'

if probe "$ALPINE_PORT"; then
  echo "mcp-alpine уже отвечает на порту $ALPINE_PORT"
  ensure_users mcp-alpine
else
  start mcp-alpine alpine:3.20 "$ALPINE_PORT" "$ALPINE_BOOT" "$LAB_CAPS"
fi

if probe "$DEBIAN_PORT"; then
  echo "mcp-debian уже отвечает на порту $DEBIAN_PORT"
  ensure_users mcp-debian
else
  start mcp-debian debian:12 "$DEBIAN_PORT" "$DEBIAN_BOOT" "$LAB_CAPS"
fi

# Router не заводит deploy/pwuser через ensure_users (и потому не переиспользует
# start()) — на нём нет ни sudo, ни smtp пароля, только вход root по ключу. Это
# и есть весь профиль встраиваемого устройства, лишние пользователи тут не нужны.
if probe "$ROUTER_PORT"; then
  echo "mcp-router уже отвечает на порту $ROUTER_PORT"
else
  docker rm -f mcp-router >/dev/null 2>&1 || true
  ssh-keygen -R "[127.0.0.1]:$ROUTER_PORT" >/dev/null 2>&1 || true
  docker run -d --name mcp-router -p "$ROUTER_PORT:22" \
    -v "$KEY.pub:/tmp/authkey:ro" alpine:3.20 sh -c "$ROUTER_BOOT" >/dev/null

  waited=0
  until probe "$ROUTER_PORT"; do
    waited=$((waited + 1))
    if [ "$waited" -gt 90 ]; then
      echo "mcp-router не ответил за 90 секунд" >&2
      docker logs --tail 20 mcp-router >&2
      exit 1
    fi
    sleep 1
  done
  echo "mcp-router готов на порту $ROUTER_PORT"
fi

# Четвёртый узел: машина с собственным докером. Журнал контейнера лежит там,
# куда показывает `docker inspect`, и прочитать его можно только на машине, где
# этот докер и работает — проброс сокета хоста даёт путь чужой файловой системы.
#
# Ключ монтируется в корень, а не в /tmp: образ dind кладёт на /tmp свою tmpfs
# и перекрывает всё, что было смонтировано туда снаружи.
#
# sshd ставится после старта: entrypoint образа занят своим делом — поднимает
# dockerd, и второй демон в команду запуска не помещается.
if probe "$DIND_PORT"; then
  echo "mcp-dind уже отвечает на порту $DIND_PORT"
else
  docker rm -f mcp-dind >/dev/null 2>&1 || true
  ssh-keygen -R "[127.0.0.1]:$DIND_PORT" >/dev/null 2>&1 || true
  docker run -d --privileged --name mcp-dind -p "$DIND_PORT:22" \
    -v "$KEY.pub:/authkey:ro" docker:28-dind >/dev/null

  waited=0
  until docker exec mcp-dind docker info >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -gt 90 ]; then
      echo "докер внутри mcp-dind не поднялся за 90 секунд" >&2
      docker logs --tail 20 mcp-dind >&2
      exit 1
    fi
    sleep 1
  done

  docker exec mcp-dind sh -c '
    apk add --no-cache openssh >/dev/null &&
    ssh-keygen -A >/dev/null &&
    mkdir -p /root/.ssh && cp /authkey /root/.ssh/authorized_keys &&
    chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys &&
    /usr/sbin/sshd -e' >/dev/null

  waited=0
  until probe "$DIND_PORT"; do
    waited=$((waited + 1))
    if [ "$waited" -gt 60 ]; then
      echo "mcp-dind не ответил за 60 секунд" >&2
      exit 1
    fi
    sleep 1
  done
  echo "mcp-dind готов на порту $DIND_PORT"
fi

# Образ для контейнеров, которые заводит живой тест: тянется один раз при
# подъёме лаборатории, чтобы сам тест не зависел от сети.
docker exec mcp-dind docker image inspect alpine:3.20 >/dev/null 2>&1 ||
  docker exec mcp-dind docker pull -q alpine:3.20 >/dev/null

echo
echo "лаборатория поднята, ключ: $KEY"
echo "живая сетка: npm run test:live"
echo "снести: docker rm -f mcp-alpine mcp-debian mcp-router mcp-dind"
