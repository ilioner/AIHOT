#!/usr/bin/env bash
# 服务器端的部署步骤，由 scripts/deploy.sh 通过 ssh 调用（在服务器上以 root 执行）。
# 也可以直接在服务器上单独跑：bash /var/www/aihot/scripts/deploy-server.sh
#
# 幂等：重复执行只会更新依赖、跑迁移、重建前端、重启服务。
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:-/var/www/aihot}"
APP_USER="${APP_USER:-aihot}"
NODE_VERSION="${NODE_VERSION:-24.22.3}"
NODE_DIR="${NODE_DIR:-/opt/node24}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NODE_MIRROR="${NODE_MIRROR:-https://cdn.npmmirror.com/binaries/node}"
WEB_PORT="${WEB_PORT:-13000}"
API_PORT="${API_PORT:-3001}"
SERVER_NAME="${SERVER_NAME:-_}"
SITE_URL="${SITE_URL:-http://localhost:$WEB_PORT}"
SKIP_NGINX="${SKIP_NGINX:-0}"
DRY_RUN="${DRY_RUN:-0}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "   [dry-run] $*"; else "$@"; fi; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行（或 sudo bash $0）"

# ---------------------------------------------------------------- 1. 系统用户
say "系统用户 $APP_USER"
if ! id "$APP_USER" >/dev/null 2>&1; then
  run useradd --system --home-dir "$REMOTE_DIR" --shell /usr/sbin/nologin "$APP_USER"
  info "已创建"
else
  info "已存在"
fi

# ---------------------------------------------------------------- 2. Node
say "Node.js $NODE_VERSION → $NODE_DIR"
if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" -v 2>/dev/null)" = "v$NODE_VERSION" ]; then
  info "已安装 $("$NODE_DIR/bin/node" -v)"
else
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "不支持的系统架构 $(uname -m)" ;;
  esac
  tarball="node-v$NODE_VERSION-linux-$arch.tar.xz"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  say "下载 $tarball"
  # 官方源支持 -sSf；镜像源不一定，所以失败就报错退出
  run curl -fsSL "$NODE_MIRROR/v$NODE_VERSION/$tarball" -o "$work/$tarball" ||
    run curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$work/$tarball"
  run tar -xJf "$work/$tarball" -C "$work"
  run rm -rf "$NODE_DIR"
  run mv "$work/node-v$NODE_VERSION-linux-$arch" "$NODE_DIR"
  info "装到 ${NODE_DIR}（没动系统 node）"
fi
NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"
# su 进入的会话不会带上 /opt/node24/bin，显式给上；npm 的 shebang 是 /usr/bin/env node
as_app() { # 以 APP_USER 身份在项目目录里执行一段 shell
  run su -s /bin/bash "$APP_USER" -c "cd '$REMOTE_DIR' && export PATH='$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin' && $*"
}

# ---------------------------------------------------------------- 3. 目录与权限
say "目录 $REMOTE_DIR"
run mkdir -p "$REMOTE_DIR/.data"
run chown -R "$APP_USER:$APP_USER" "$REMOTE_DIR"
[ -f "$REMOTE_DIR/.env" ] || die "缺少 $REMOTE_DIR/.env，先跑 scripts/deploy.sh 生成"
run chmod 600 "$REMOTE_DIR/.env"
run chown "$APP_USER:$APP_USER" "$REMOTE_DIR/.env"

# ---------------------------------------------------------------- 4. 依赖
say "安装依赖（registry=${NPM_REGISTRY}）"
cd "$REMOTE_DIR"
# 用 aihot 身份装，避免 node_modules 归 root 后 worker 读不了
as_app "$NPM_BIN config set registry '$NPM_REGISTRY' --location=user"
as_app "$NPM_BIN ci --registry='$NPM_REGISTRY' --no-audit --no-fund"

# ---------------------------------------------------------------- 5. 数据库
say "迁移与种子数据"
as_app "$NODE_BIN --env-file=.env scripts/migrate.ts"
as_app "$NODE_BIN --env-file=.env scripts/seed.ts"

# ---------------------------------------------------------------- 6. 前端构建
say "构建前端"
as_app "$NPM_BIN run build -w @aihot/web"
run chown -R "$APP_USER:$APP_USER" "$REMOTE_DIR/apps/web/build" 2>/dev/null || true

# ---------------------------------------------------------------- 7. systemd
say "systemd 单元"
write_unit() { # name, description, workdir, exec, extra
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$3
Environment=NODE_ENV=production
Environment=PATH=$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=$REMOTE_DIR/.env
$5
ExecStart=$4
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$1

[Install]
WantedBy=multi-user.target
EOF
}
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] 写 aihot-api / aihot-worker / aihot-web 三个单元"
else
  write_unit aihot-api "AIHOT api (HTTP + MCP)" "$REMOTE_DIR" \
    "$NODE_BIN --env-file=$REMOTE_DIR/.env apps/api/src/main.ts" \
    "Environment=API_HOST=127.0.0.1
Environment=API_PORT=$API_PORT"
  write_unit aihot-worker "AIHOT worker (collection, model calls, digests)" "$REMOTE_DIR" \
    "$NODE_BIN --env-file=$REMOTE_DIR/.env apps/worker/src/main.ts" \
    "# 支付调用与备份收尾最多要 470s，留够再停
TimeoutStopSec=515
KillMode=mixed"
  write_unit aihot-web "AIHOT web (public site, SSR)" "$REMOTE_DIR/apps/web" \
    "$NODE_BIN --env-file=$REMOTE_DIR/.env server.ts" \
    "Environment=WEB_HOST=0.0.0.0
Environment=WEB_PORT=$WEB_PORT"
fi
run systemctl daemon-reload
run systemctl enable aihot-api aihot-worker aihot-web

# ---------------------------------------------------------------- 8. nginx
if [ "$SKIP_NGINX" = 1 ]; then
  say "跳过 nginx（SKIP_NGINX=1）"
elif ! command -v nginx >/dev/null 2>&1; then
  say "服务器没有 nginx，跳过；用 $SITE_URL 直接访问"
else
  say "nginx：80 → $WEB_PORT"
  conf="/etc/nginx/conf.d/aihot.conf"
  new_conf=$(cat <<EOF
# 由 scripts/deploy-server.sh 生成。独立 server 块，只处理 SERVER_NAME，不改动其他站点。
server {
    listen 80;
    server_name $SERVER_NAME;
    return 301 http://$SERVER_NAME:$WEB_PORT\$request_uri;
}
EOF
)
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] 写 $conf"
  else
    [ -f "$conf" ] && cp "$conf" "$conf.bak.$(date +%Y%m%d%H%M%S)"
    printf '%s\n' "$new_conf" > "$conf"
    if nginx -t 2>/dev/null; then
      systemctl reload nginx
      info "已重载 nginx"
    else
      die "nginx 配置检查失败，已保留 ${conf}（旧配置在同目录 .bak.*）"
    fi
  fi
fi

# ---------------------------------------------------------------- 9. 启动
say "启动服务"
run systemctl restart aihot-api aihot-worker aihot-web
if [ "$DRY_RUN" != 1 ]; then
  sleep 4
  for unit in aihot-api aihot-worker aihot-web; do
    if systemctl is-active --quiet "$unit"; then
      info "$unit active"
    else
      systemctl status "$unit" --no-pager --lines=15 || true
      die "$unit 启动失败"
    fi
  done
fi

# ---------------------------------------------------------------- 10. 自检
say "自检"
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] 跳过"
else
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$WEB_PORT/" || echo 000)"
  [ "$code" = 200 ] || die "首页返回 $code"
  info "首页 200"
  health="$(curl -s --max-time 15 "http://127.0.0.1:$WEB_PORT/api/health" || true)"
  case "$health" in
    *'"ok":true'*) info "健康检查 $health" ;;
    *) info "健康检查未就绪：$health" ;;
  esac
fi
