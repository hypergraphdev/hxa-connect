#!/usr/bin/env bash
# HXA Connect — Install & Upgrade Script
# Fresh install:  curl -sSL https://github.com/coco-xyz/hxa-connect/releases/latest/download/install.sh | bash
# Upgrade:        cd ~/hxa-connect && bash install.sh
#   or:           bash install.sh [--dir /path/to/install] [--port 4800] [--no-interactive]
set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────
INSTALL_DIR="${INSTALL_DIR:-$HOME/hxa-connect}"
HXA_CONNECT_PORT="${HXA_CONNECT_PORT:-4800}"
HXA_CONNECT_ADMIN_SECRET="${HXA_CONNECT_ADMIN_SECRET:-}"
REPO_URL="https://github.com/coco-xyz/hxa-connect.git"
BRANCH="main"
INTERACTIVE=true
PM2_NAME="hxa-connect"
IS_UPGRADE=false

# ─── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
fatal() { error "$@"; exit 1; }

# ─── Parse Args ───────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)          INSTALL_DIR="$2"; shift 2 ;;
    --port)         HXA_CONNECT_PORT="$2"; shift 2 ;;
    --secret)       HXA_CONNECT_ADMIN_SECRET="$2"; shift 2 ;;
    --branch)       BRANCH="$2"; shift 2 ;;
    --name)         PM2_NAME="$2"; shift 2 ;;
    --no-interactive) INTERACTIVE=false; shift ;;
    -h|--help)
      echo "Usage: install.sh [OPTIONS]"
      echo ""
      echo "  Fresh install: clones repo, configures, builds, and starts PM2"
      echo "  Upgrade:       pulls latest code, rebuilds, and restarts PM2"
      echo ""
      echo "  Automatically detects whether to install or upgrade based on"
      echo "  whether the install directory already contains a git repo."
      echo ""
      echo "Options:"
      echo "  --dir DIR          Install directory (default: ~/hxa-connect)"
      echo "  --port PORT        Server port (default: 4800)"
      echo "  --secret SECRET    Admin secret (prompted if not set)"
      echo "  --branch BRANCH    Git branch (default: main)"
      echo "  --name NAME        PM2 process name (default: hxa-connect)"
      echo "  --no-interactive   Skip prompts, use defaults/env vars"
      echo "  -h, --help         Show this help"
      exit 0
      ;;
    *) fatal "Unknown option: $1" ;;
  esac
done

# ─── Detect Mode ─────────────────────────────────────────────
# Also detect if running from inside an existing installation
if [[ -d "$INSTALL_DIR/.git" ]]; then
  IS_UPGRADE=true
elif [[ -d "./.git" ]] && [[ -f "./package.json" ]] && grep -qE '"name"\s*:\s*"hxa-connect"' "./package.json" 2>/dev/null; then
  IS_UPGRADE=true
  INSTALL_DIR="$(pwd)"
fi

# ─── Banner ───────────────────────────────────────────────────
echo ""
if [[ "$IS_UPGRADE" == true ]]; then
  echo -e "${CYAN}  ╔═══════════════════════════════════════╗${NC}"
  echo -e "${CYAN}  ║        🐾 HXA Connect Upgrade          ║${NC}"
  echo -e "${CYAN}  ║   Bot-to-Bot Communication Hub    ║${NC}"
  echo -e "${CYAN}  ╚═══════════════════════════════════════╝${NC}"
else
  echo -e "${CYAN}  ╔═══════════════════════════════════════╗${NC}"
  echo -e "${CYAN}  ║       🐾 HXA Connect Installer         ║${NC}"
  echo -e "${CYAN}  ║   Bot-to-Bot Communication Hub    ║${NC}"
  echo -e "${CYAN}  ╚═══════════════════════════════════════╝${NC}"
fi
echo ""

# ─── Step 1: Check Node.js ────────────────────────────────────
info "Checking Node.js..."
if ! command -v node &>/dev/null; then
  fatal "Node.js not found. Please install Node.js 22+ first:
    https://nodejs.org/en/download
    or: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi

NODE_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  fatal "Node.js 22+ required (found: $(node -v)). Please upgrade."
fi
ok "Node.js $(node -v)"

# ─── Step 2: Check/Install PM2 ────────────────────────────────
info "Checking PM2..."
if ! command -v pm2 &>/dev/null; then
  warn "PM2 not found. Installing..."
  npm install -g pm2
fi
ok "PM2 $(pm2 -v)"

# ─── Step 3: Interactive Config (fresh install only) ──────────
if [[ "$IS_UPGRADE" == false && "$INTERACTIVE" == true ]]; then
  echo ""
  info "Configuration (press Enter for defaults):"
  echo ""

  read -rp "  Install directory [$INSTALL_DIR]: " input
  INSTALL_DIR="${input:-$INSTALL_DIR}"

  read -rp "  Server port [$HXA_CONNECT_PORT]: " input
  HXA_CONNECT_PORT="${input:-$HXA_CONNECT_PORT}"

  if [[ -z "$HXA_CONNECT_ADMIN_SECRET" ]]; then
    echo ""
    info "Admin secret is required for production deployments."
    info "It protects org management APIs (create/list/modify orgs)."
    echo ""
    read -rp "  Admin secret (leave empty for dev mode): " HXA_CONNECT_ADMIN_SECRET
  fi

  read -rp "  PM2 process name [$PM2_NAME]: " input
  PM2_NAME="${input:-$PM2_NAME}"

  echo ""
fi

# ─── Step 4: Clone or Update ──────────────────────────────────
if [[ "$IS_UPGRADE" == true ]]; then
  cd "$INSTALL_DIR"
  OLD_HEAD=$(git rev-parse --short HEAD)
  info "Pulling latest from $BRANCH..."
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
  NEW_HEAD=$(git rev-parse --short HEAD)
  if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
    ok "Already up to date ($NEW_HEAD)"
  else
    ok "Updated $OLD_HEAD → $NEW_HEAD"
  fi
else
  info "Cloning hxa-connect..."
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ─── Step 5: Install Dependencies & Build ─────────────────────
info "Installing dependencies..."
npm install --loglevel=warn
ok "Dependencies installed"

info "Building..."
npm run build
ok "Build complete"

# ─── Step 6: Generate .env (fresh install only) ───────────────
if [[ "$IS_UPGRADE" == false ]]; then
  ENV_FILE="$INSTALL_DIR/.env"
  if [[ -f "$ENV_FILE" ]]; then
    info "Existing .env found — preserving. New config written to .env.new"
    ENV_FILE="$INSTALL_DIR/.env.new"
  fi

  cat > "$ENV_FILE" <<ENVEOF
# HXA Connect Configuration
# Generated by install.sh on $(date -u '+%Y-%m-%d %H:%M:%S UTC')

HXA_CONNECT_PORT=$HXA_CONNECT_PORT
HXA_CONNECT_PERSIST=true
HXA_CONNECT_DATA_DIR=./data
ENVEOF

  if [[ -n "$HXA_CONNECT_ADMIN_SECRET" ]]; then
    echo "HXA_CONNECT_ADMIN_SECRET=$HXA_CONNECT_ADMIN_SECRET" >> "$ENV_FILE"
  else
    echo "# HXA_CONNECT_ADMIN_SECRET=  # Set this for production!" >> "$ENV_FILE"
    echo "DEV_MODE=true" >> "$ENV_FILE"
    warn "No admin secret set — running in dev mode (DEV_MODE=true)"
  fi

  cat >> "$ENV_FILE" <<ENVEOF

# Optional:
# HXA_CONNECT_CORS_ORIGINS=https://your-domain.com
# HXA_CONNECT_LOG_LEVEL=info
# HXA_CONNECT_MAX_FILE_SIZE_MB=50
ENVEOF

  ok "Config written to $ENV_FILE"
fi

# ─── Step 7: Create data directory ────────────────────────────
mkdir -p "$INSTALL_DIR/data"

# ─── Step 8: PM2 Setup ────────────────────────────────────────
if [[ "$IS_UPGRADE" == true ]]; then
  info "Restarting PM2 process..."
  if pm2 describe "$PM2_NAME" &>/dev/null; then
    pm2 restart "$PM2_NAME"
    ok "PM2 process '$PM2_NAME' restarted"
  else
    warn "PM2 process '$PM2_NAME' not found — starting fresh"
    pm2 start dist/index.js \
      --name "$PM2_NAME" \
      --cwd "$INSTALL_DIR" \
      --node-args="--env-file=.env" \
      --max-memory-restart 512M
    pm2 save
    ok "PM2 process '$PM2_NAME' started"
  fi
else
  info "Setting up PM2..."

  # Stop existing instance if running
  pm2 delete "$PM2_NAME" 2>/dev/null || true

  # Start with dotenv support
  pm2 start dist/index.js \
    --name "$PM2_NAME" \
    --cwd "$INSTALL_DIR" \
    --node-args="--env-file=.env" \
    --max-memory-restart 512M

  # Save PM2 process list
  pm2 save

  # Setup startup script (non-fatal if it fails — might need sudo)
  if pm2 startup 2>/dev/null | grep -q "sudo"; then
    echo ""
    warn "To enable auto-start on boot, run the command above with sudo"
  else
    ok "PM2 startup configured"
  fi

  ok "PM2 process '$PM2_NAME' started"
fi

# ─── Done ─────────────────────────────────────────────────────
echo ""
if [[ "$IS_UPGRADE" == true ]]; then
  echo -e "${GREEN}  ╔═══════════════════════════════════════╗${NC}"
  echo -e "${GREEN}  ║     ✅ HXA Connect upgraded!           ║${NC}"
  echo -e "${GREEN}  ╚═══════════════════════════════════════╝${NC}"
  echo ""
  echo "  Directory:  $INSTALL_DIR"
  echo "  Version:    $(git rev-parse --short HEAD)"
  echo "  PM2:        pm2 logs $PM2_NAME"
else
  echo -e "${GREEN}  ╔═══════════════════════════════════════╗${NC}"
  echo -e "${GREEN}  ║     ✅ HXA Connect installed!          ║${NC}"
  echo -e "${GREEN}  ╚═══════════════════════════════════════╝${NC}"
  echo ""
  echo "  Directory:  $INSTALL_DIR"
  echo "  HTTP:       http://localhost:$HXA_CONNECT_PORT"
  echo "  WebSocket:  ws://localhost:$HXA_CONNECT_PORT/ws"
  echo "  Web UI:     http://localhost:$HXA_CONNECT_PORT"
  echo "  PM2:        pm2 logs $PM2_NAME"
  echo ""
  echo "  Useful commands:"
  echo "    pm2 logs $PM2_NAME      # View logs"
  echo "    pm2 restart $PM2_NAME   # Restart"
  echo "    pm2 stop $PM2_NAME      # Stop"
  echo "    pm2 monit                # Monitor all"
  if [[ -z "$HXA_CONNECT_ADMIN_SECRET" ]]; then
    echo ""
    echo -e "  ${YELLOW}⚠  Running in dev mode (DEV_MODE=true). Set HXA_CONNECT_ADMIN_SECRET and remove DEV_MODE for production.${NC}"
  fi
fi
echo ""
