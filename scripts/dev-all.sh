#!/usr/bin/env bash
# 本机一键启动：数据库 → 迁移 → api(3001) / web(3000) / worker；Ctrl-C 一次全停。
# 用 bash 执行，不要 source：它会改当前目录、装信号处理并一直 wait，source 会把这些留在你的 shell 里。
set -euo pipefail
set -m                                 # 下面每个后台任务自成进程组，收尾时能整组停（见 cleanup）
cd "$(dirname "$0")/.."
REPO=$(pwd -P)        # 物理路径：lsof 报的是解析过的路径，比对时不能用可能带符号链接的 $PWD

usage() { echo "用法: bash scripts/dev-all.sh [--seed] [--restart]"; }
one_line() { paste -sd' ' -; }        # 把多行 PID 折成一行，给提示信息用

SEED=0
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;                                  # 先跑一次 seed：导入 industry/sources.json 的新信源（不覆盖已有行）
    --restart) RESTART=1 ;;                            # 先停掉上一次实例（含端口已释放、还在收尾的 worker）
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

# Node：仓库要求 >=24.22.1，nvm 默认的 v22 跑不动仓库脚本（npm test 会报 bad option: --test-global-setup）。
# libpq 提供 psql / pg_dump，本机只有它这一份。
PATH="/opt/homebrew/opt/libpq/bin:/opt/homebrew/bin:$PATH"
export PATH
echo "node $(node -v) ($(command -v node))"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=22)?0:1)'; then
  echo "Node 版本太低：仓库要求 >= 24.22.1（本机可用 /opt/homebrew/bin/node）。" >&2
  exit 1
fi

[ -f .env ] || { echo "缺少 .env：先照 .env.example 建一个（别提交它，密钥只在后端）。" >&2; exit 1; }

# 本机代理是 fake-IP DNS：不打开这个开关，guardedFetch 一律拒绝，采集会全部失败。
# Node 的 --env-file 不覆盖已存在的环境变量，所以这里导出就生效（.env 里写的是 false）。
if ! grep -qE '^ALLOW_PRIVATE_NETWORK_FETCH=true$' .env; then
  export ALLOW_PRIVATE_NETWORK_FETCH=true
  echo "已临时打开 ALLOW_PRIVATE_NETWORK_FETCH（本机 fake-IP DNS 需要；.env 里是 false，只在本次启动生效）"
fi

# 数据库：主机和端口从 DATABASE_URL 读，连不上就启动容器。
DB_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)
[ -n "$DB_URL" ] || { echo "缺少 DATABASE_URL：.env 里没有这一项，照 .env.example 补上。" >&2; exit 1; }
# 解析结果不打印（连接串里可能带密码），只打印主机和端口。
DB_HOSTPORT=$(node -e 'try{const u=new URL(process.argv[1]);console.log(u.hostname+" "+String(u.port||5432))}catch{process.exit(3)}' "$DB_URL") || {
  echo "DATABASE_URL 解析不了一个合法的连接串（形如 postgres://用户@主机:端口/库名）。" >&2; exit 1; }
read -r DB_HOST DB_PORT <<<"$DB_HOSTPORT"
[ -n "$DB_HOST" ] || { echo "DATABASE_URL 里没有主机名。" >&2; exit 1; }
if ! nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
  echo "$DB_HOST:$DB_PORT 没响应，尝试启动容器 aihot-test-pg ..."
  docker start aihot-test-pg >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null && break; sleep 1; done
fi
if ! nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
  # 变量名后面直接跟中文（全角冒号等）时，本机的 bash 会把那几个字节也算进变量名，
  # 于是报 unbound variable、这句话根本打不出来——变量一律用 ${} 包起来再跟中文。
  echo "数据库连不上 ${DB_HOST}:${DB_PORT}：本机容器叫 aihot-test-pg，换了名字就自己启动它。" >&2
  exit 1
fi
echo "数据库就绪 $DB_HOST:$DB_PORT"

# 上一次的实例：占着 3000/3001 的，和本仓库里还在跑的 dev 进程（端口已经放掉、但 worker 还在收尾的也算）。
# 认「是不是本仓库的」看进程的工作目录：命令里往往只有相对路径，而端口可能被别人的程序占着，别乱杀。
# GROUP 只用来在下面挑上一次实例的进程组时，把脚本自己所在的那组排除掉。
GROUP=$(ps -o pgid= -p $$ | tr -d ' ')
in_repo() {         # 进程的工作目录在本仓库里吗（根目录本身也算：手动从根目录起 worker 就是这种）
  cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  case "$cwd" in "$REPO"|"$REPO"/*) return 0 ;; *) return 1 ;; esac
}
dev_pids() {        # 本仓库里还在跑 api/web/worker 的进程
  ps -Ao pid,command | awk 'NR>1 && /node --watch|react-router dev|npm run dev/ {print $1}' |
    while read -r p; do if in_repo "$p"; then echo "$p"; fi; done | sort -u
}
# lsof 找不到时退出码是 1，配着 set -o pipefail 会把这个赋值判成失败，所以后面要 || true，
# 否则脚本会在真正打印「上一次的实例还在跑」之前就静静退出。
ports_busy() { lsof -nP -iTCP:3000 -iTCP:3001 -sTCP:LISTEN -t 2>/dev/null | sort -u || true; }
PORTS=$(ports_busy)
OUR_PORTS=$(echo "$PORTS" | while read -r p; do if in_repo "$p"; then echo "$p"; fi; done)
MINE=$( { if [ -n "$OUR_PORTS" ]; then echo "$OUR_PORTS"; fi; dev_pids; } | sort -u )
FOREIGN=$(comm -23 <(echo "$PORTS" | sort -u) <(echo "$MINE" | sort -u) | grep -v '^$' || true)
if [ -n "$FOREIGN" ]; then
  echo "3000/3001 被这个仓库之外的进程占着（PID $(echo "$FOREIGN" | one_line)），先自己腾出来。" >&2
  exit 1
fi
if [ -n "$MINE" ]; then
  if [ "$RESTART" != 1 ]; then
    echo "上一次的实例还在跑（PID $(echo "$MINE" | one_line)）：要重启就 bash scripts/dev-all.sh --restart，要自己停就 kill 这些 PID。" >&2
    exit 1
  fi
  OLD_GROUPS=$(for p in $MINE; do ps -o pgid= -p "$p" 2>/dev/null | tr -d ' '; done | sort -u | grep -v "^$GROUP$" || true)
  echo "停掉上一次的实例（进程组 $(echo "$OLD_GROUPS" | one_line)）..."
  for g in $OLD_GROUPS; do kill -TERM -- -"$g" 2>/dev/null || true; done
  # 等它把端口让出来：worker 会做完手上的任务再退，可能要一分钟。
  for _ in $(seq 1 20); do
    [ -z "$(ports_busy)" ] && break
    sleep 1
  done
  STILL=$(ports_busy)
  if [ -n "$STILL" ]; then
    echo "3000/3001 还被上一次的实例占着（PID $(echo "$STILL" | one_line)）：它可能正在把一条任务做完，等它退干净再跑一次。" >&2
    exit 1
  fi
fi

echo "迁移 ..."
npm run db:migrate
if [ "$SEED" = 1 ]; then
  echo "seed ..."
  node --env-file=.env scripts/seed.ts
fi

mkdir -p .data/logs
: > .data/logs/api.log; : > .data/logs/web.log; : > .data/logs/worker.log
# 每个任务自成一组（set -m）：报「谁还没退」时按组看，不用去数脚本自己那一组里的进程——那样会把
# 判断用的 sleep/ps 当成没退干净的进程，白等一轮还误报。stdin 接 /dev/null：后台进程读终端会被停住。
npm run dev:api    >.data/logs/api.log    2>&1 </dev/null &
API_JOB=$!
npm run dev:web    >.data/logs/web.log    2>&1 </dev/null &
WEB_JOB=$!
npm run dev:worker >.data/logs/worker.log 2>&1 </dev/null &
WORKER_JOB=$!
TAIL_JOB=
JOBS="$API_JOB $WEB_JOB $WORKER_JOB"

job_name() {
  case "$1" in
    "$API_JOB") echo api ;;
    "$WEB_JOB") echo web ;;
    "$WORKER_JOB") echo worker ;;
    "$TAIL_JOB") echo "日志 tail" ;;
    *) echo "PID $1" ;;
  esac
}
jobs_left() {   # 还没退的任务组（kill -0 问整组；组里还剩谁就说明这个任务没退干净）
  for p in $JOBS $TAIL_JOB; do kill -0 -- -"$p" 2>/dev/null && echo "$p"; done
  return 0      # 最后一个都退干净时上面的 kill -0 会失败；不能把这当成函数失败，
                # 否则 left=$(jobs_left) 在 set -e 下会把脚本从 trap 里直接带走（不打印、退出码 1）
}
# 收尾：信号发给每个任务组，不发给自己那一组（发给自己会把脚本连同你的 shell 一起带走）。
# 用 SIGTERM 而不是 SIGINT：本机的 tail 收 SIGINT 不退（实测），只发给脚本时它会留下来。
# worker 收到信号后会把手上这条任务做完再退（日志里能看到 worker stopping / worker stopped），
# 所以收尾要等一会儿，不能用 SIGKILL 打断它（会留下做了一半的任务）。
cleanup() {
  code=$?                            # 别把真正的错误码盖成 0（Ctrl-C 时是 130）
  trap - INT TERM EXIT               # 再按一次 Ctrl-C 就是立即结束，不走收尾
  left=$(jobs_left)
  for p in $left; do kill -TERM -- -"$p" 2>/dev/null || true; done
  for _ in $(seq 1 20); do
    [ -z "$(jobs_left)" ] && break
    sleep 1
  done
  left=$(jobs_left)
  if [ -n "$left" ]; then
    names=""
    for p in $left; do names="$names $(job_name "$p")"; done
    echo "已停止，但这些还没退干净：${names}。worker 收尾慢，做完手上的任务会自己退；若一直不退，kill -9 上面这些进程。" >&2
  else
    echo "已停止。"
  fi
  exit "$code"
}
trap cleanup INT TERM EXIT

for _ in $(seq 1 90); do
  curl -fsS -o /dev/null http://127.0.0.1:3001/api/health 2>/dev/null &&
    curl -fsS -o /dev/null http://127.0.0.1:3000/api/health 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null http://127.0.0.1:3000/api/health 2>/dev/null ||
  echo "90 秒还没就绪，看 .data/logs/ 下的日志。" >&2

echo
echo "站点 http://localhost:3000   API http://127.0.0.1:3001   日志 .data/logs/{api,web,worker}.log"
echo "Ctrl-C 一次停掉全部。"
# 三个日志用一个 tail 跟（多文件时它自己打 ==> 文件 <== 的表头）：单个进程，好收尾。
tail -n +1 -f .data/logs/api.log .data/logs/web.log .data/logs/worker.log &
TAIL_JOB=$!
# 只等三个开发任务，不等日志 tail：tail 是跟着脚本活的，脚本的命该由 api/web/worker 决定。
# 等 tail 的话，--restart 停掉上一份的三个任务后，上一份的脚本会一直卡在这里陪 tail（tail 只有它自己收尾时才停）。
wait $API_JOB $WEB_JOB $WORKER_JOB