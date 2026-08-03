#!/usr/bin/env bash
#
# Лаборатория для живых тестов передачи файлов.
#
# Два контейнера с разными наборами утилит: Alpine (BusyBox, bash нет) и
# Debian (coreutils, sh это dash). Расхождения между ними ловят половину
# дефектов, которые моки не видят вовсе.
#
# Скрипт идемпотентен: живые контейнеры не трогает, мёртвые пересоздаёт.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB_DIR="$REPO_ROOT/.lab"
KEY="$LAB_DIR/key"

ALPINE_PORT=2231
DEBIAN_PORT=2232

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
ensure_deploy() {
  docker exec "$1" sh -c '
    id deploy >/dev/null 2>&1 || adduser -D deploy 2>/dev/null || useradd -m -s /bin/sh deploy
    mkdir -p /home/deploy/.ssh
    cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
    chown -R deploy:deploy /home/deploy/.ssh
    chmod 700 /home/deploy/.ssh
    chmod 600 /home/deploy/.ssh/authorized_keys
    echo "deploy ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/deploy
    chmod 440 /etc/sudoers.d/deploy
  ' >/dev/null
}

start() {
  local name="$1" image="$2" port="$3" boot="$4"

  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "$port:22" \
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

  ensure_deploy "$name"
  echo "$name готов на порту $port"
}

ALPINE_BOOT='apk add --no-cache openssh sudo >/dev/null && ssh-keygen -A &&
  mkdir -p /root/.ssh && cp /tmp/authkey /root/.ssh/authorized_keys &&
  chmod 600 /root/.ssh/authorized_keys && /usr/sbin/sshd -D -e'

DEBIAN_BOOT='apt-get update -qq >/dev/null && apt-get install -y -qq openssh-server sudo >/dev/null &&
  mkdir -p /run/sshd /root/.ssh && cp /tmp/authkey /root/.ssh/authorized_keys &&
  chmod 600 /root/.ssh/authorized_keys && /usr/sbin/sshd -D -e'

if probe "$ALPINE_PORT"; then
  echo "mcp-alpine уже отвечает на порту $ALPINE_PORT"
  ensure_deploy mcp-alpine
else
  start mcp-alpine alpine:3.20 "$ALPINE_PORT" "$ALPINE_BOOT"
fi

if probe "$DEBIAN_PORT"; then
  echo "mcp-debian уже отвечает на порту $DEBIAN_PORT"
  ensure_deploy mcp-debian
else
  start mcp-debian debian:12 "$DEBIAN_PORT" "$DEBIAN_BOOT"
fi

echo
echo "лаборатория поднята, ключ: $KEY"
echo "живая сетка: npm run test:live"
echo "снести: docker rm -f mcp-alpine mcp-debian"
