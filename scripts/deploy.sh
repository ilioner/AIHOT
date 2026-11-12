#!/usr/bin/env bash
# 一键部署 / 更新：把本仓库推到服务器，用 systemd 跑 api + worker + web，nginx 的 80 端口跳到 WEB_PORT。
#
#   用法：
#     DEPLOY_HOST=39.108.97.75 SSH_KEY=~/.ssh/id_ed25519 ./scripts/deploy.sh
#
#   可选项（都可用同名环境变量覆盖）：
#     DEPLOY_USER=root        SSH 登录用户（需要有 root 权限）
#     SSH_PORT=22             SSH 端口
#     REMOTE_DIR=/var/www/aihot
#     APP_USER=aihot          跑服务用的系统用户，脚本会按需创建
#     WEB_PORT=13000          对外页面端口
#     API_PORT=3001           api 端口（只监听 127.0.0.1）
#     NODE_VERSION=24.22.3   装到 NODE_DIR（默认 /opt/node24），不碰系统 node
#     NPM_REGISTRY=https://registry.npmmirror.com
#     SERVER_NAME=39.108.97.75   nginx server_name，默认取 DEPLOY_HOST
#     SKIP_NGINX=1            不改 nginx
#     FORCE_ENV=1             用本地 .env 覆盖服务器上的 .env（会先备份）
#
# 第一次执行：建用户、装 Node、生成 .env、跑迁移和种子、写 systemd 与 nginx 配置、启动服务。
# 以后再执行：更新代码、补依赖、跑迁移、重建前端、重启服务。服务器上的 .env 和 .data 不会被覆盖。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEPLOY_HOST="${DEPLOY_HOST:-${1:-}}"
DEPLOY_USER="${DEPLOY_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=accept-new -o ConnectTimeout=15}"

REMOTE_DIR="${REMOTE_DIR:-/var/www/aihot}"
APP_USER="${APP_USER:-aihot}"
NODE_VERSION="${NODE_VERSION:-24.22.3}"
NODE_DIR="${NODE_DIR:-/opt/node24}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NODE_MIRROR="${NODE_MIRROR:-https://cdn.npmmirror.com/binaries/node}"
WEB_PORT="${WEB_PORT:-13000}"
API_PORT="${API_PORT:-3001}"
SERVER_NAME="${SERVER_NAME:-$DEPLOY_HOST}"
SKIP_NGINX="${SKIP_NGINX:-0}"
FORCE_ENV="${FORCE_ENV:-0}"
ENV_SOURCE="${ENV_SOURCE:-$REPO_ROOT/.env}"
DRY_RUN="${DRY_RUN:-0}"

if [ -z "$DEPLOY_HOST" ]; then
  echo "用法：DEPLOY_HOST=<服务器地址> [SSH_KEY=私钥路径] $0" >&2
  exit 1
fi
if [ -n "$SSH_KEY" ]; then
  SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

TARGET="$DEPLOY_USER@$DEPLOY_HOST"
RSYNC_SSH="ssh -p $SSH_PORT $SSH_OPTS"
SITE_URL="http://$DEPLOY_HOST:$WEB_PORT"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "   [dry-run] $*"; else "$@"; fi; }

# ---------------------------------------------------------------- 1. 连通性
say "检查 SSH 连接 $TARGET:$SSH_PORT"
ssh -p "$SSH_PORT" $SSH_OPTS "$TARGET" 'echo ok' >/dev/null || die "连不上 ${TARGET}，检查地址、SSH_KEY 和防火墙"
remote_kernel="$(ssh -p "$SSH_PORT" $SSH_OPTS "$TARGET" 'uname -sr')"
info "$remote_kernel"

# ---------------------------------------------------------------- 2. 服务器上的 .env
# 只有第一次部署（或 FORCE_ENV=1）才生成；之后的更新一律保留服务器上那份。
env_exists="$(ssh -p "$SSH_PORT" $SSH_OPTS "$TARGET" "test -f '$REMOTE_DIR/.env' && echo yes || echo no")"

gen_env_file() {
  local src="$1" out="$2"
  [ -f "$src" ] || die "找不到 ${src}；请先从 .env.example 复制一份并填好 LLM_API_KEY 等值"

  # 这几项由部署脚本接管，其余（DATABASE_URL、LLM_*、模型 key 等）沿用来源文件。
  local managed='^(SITE_URL|API_BASE_URL|AIHOT_DATA_DIR|NODE_ENV|HOST|PORT|WEB_HOST|WEB_PORT|API_HOST|API_PORT|TRUST_PROXY)='
  # 上一轮部署追加的“受管段”标题也一起去掉，免得反复部署攒出一堆重复标题
  grep -vE "$managed|^# ---- 由 scripts/deploy.sh 接管" "$src" > "$out" || true

  ensure_secret() { # key, generator-command
    if ! grep -qE "^$1=.+" "$out"; then
      printf '%s=%s\n' "$1" "$($2)" >> "$out"
    fi
  }
  ensure_secret ADMIN_PASSWORD "openssl rand -base64 18 | tr -d '/+=' | cut -c1-20"
  ensure_secret SESSION_SECRET "openssl rand -hex 32"
  ensure_secret IMG_PROXY_SIGN_SECRET "openssl rand -hex 32"
  ensure_secret POSTGRES_PASSWORD "openssl rand -hex 18"

  cat >> "$out" <<EOF

# ---- 由 scripts/deploy.sh 接管，重新部署时会重写这一段 ----
NODE_ENV=production
SITE_URL=$SITE_URL
API_BASE_URL=http://127.0.0.1:$API_PORT
AIHOT_DATA_DIR=$REMOTE_DIR/.data
API_HOST=127.0.0.1
API_PORT=$API_PORT
WEB_HOST=0.0.0.0
WEB_PORT=$WEB_PORT
TRUST_PROXY=$([ "$SKIP_NGINX" = 1 ] && echo false || echo true)
EOF
}

run ssh -p "$SSH_PORT" $SSH_OPTS "$TARGET" "mkdir -p '$REMOTE_DIR'"

if [ "$DRY_RUN" != 1 ] && { [ "$env_exists" = no ] || [ "$FORCE_ENV" = 1 ]; }; then
  say "生成服务器 .env"
  tmp_env="$(mktemp)"
  trap 'rm -f "$tmp_env"' EXIT
  gen_env_file "$ENV_SOURCE" "$tmp_env"
  if [ "$env_exists" = yes ]; then
    ssh -p "$SSH_PORT" $SSH_OPTS "$TARGET" "cp '$REMOTE_DIR/.env' '$REMOTE_DIR/.env.bak.$(date +%Y%m%d%H%M%S)'"
    info "已备份旧 .env"
  fi
  scp -P "$SSH_PORT" $SSH_OPTS "$tmp_env" "$TARGET:$REMOTE_DIR/.env.new" >/dev/null
  ssh -p "$SSH_PORT" $SSH_OPTS "$TARGET" "mv '$REMOTE_DIR/.env.new' '$REMOTE_DIR/.env' && chown '$APP_USER:$APP_USER' '$REMOTE_DIR/.env' && chmod 600 '$REMOTE_DIR/.env'"
  info "写入 $REMOTE_DIR/.env（SITE_URL=${SITE_URL}）"
elif [ "$env_exists" = yes ]; then
  say "沿用服务器上已有的 .env"
  info "想用本地 .env 重新生成：FORCE_ENV=1 $0"
else
  say "跳过 .env 生成（dry-run）"
fi

# ---------------------------------------------------------------- 3. 同步代码
say "同步代码到 $REMOTE_DIR"
run rsync -a --delete \
  -e "$RSYNC_SSH" \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.data/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'apps/web/build/' \
  --exclude '.npm/' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  "$REPO_ROOT/" "$TARGET:$REMOTE_DIR/"
info "代码已同步（排除 node_modules、.data、.env、构建产物）"

# ---------------------------------------------------------------- 4. 服务器端安装
say "在服务器上安装并启动"
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] 跳过远程安装步骤"
else
ssh -p "$SSH_PORT" $SSH_OPTS "$TARGET" \
  "REMOTE_DIR='$REMOTE_DIR' APP_USER='$APP_USER' NODE_VERSION='$NODE_VERSION' NODE_DIR='$NODE_DIR' \
   NPM_REGISTRY='$NPM_REGISTRY' NODE_MIRROR='$NODE_MIRROR' WEB_PORT='$WEB_PORT' API_PORT='$API_PORT' \
   SERVER_NAME='$SERVER_NAME' SITE_URL='$SITE_URL' SKIP_NGINX='$SKIP_NGINX' DRY_RUN='$DRY_RUN' \
   bash '$REMOTE_DIR/scripts/deploy-server.sh'"
fi

# ---------------------------------------------------------------- 5. 结果
say "部署完成"
admin_pw="$(ssh -p "$SSH_PORT" $SSH_OPTS "$TARGET" "grep -E '^ADMIN_PASSWORD=' '$REMOTE_DIR/.env' | cut -d= -f2-")"
cat <<EOF
   站点   $SITE_URL
   后台   $SITE_URL/admin
   账号   admin
   密码   $admin_pw

   日志   journalctl -u aihot-api -u aihot-worker -u aihot-web -f
   状态   systemctl status aihot-api aihot-worker aihot-web
EOF
