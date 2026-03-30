# SMTP-to-DMail Bridge

> Bidirectional email bridge: receive emails as encrypted DMail, send replies back via SMTP.

## Overview

This bridge allows standard email users to communicate with Archon DID holders:

**Inbound (SMTP → DMail):**
1. Email arrives at `user@archon.social`
2. Recipient name resolved to DID
3. Encrypted DMail created with reply token
4. Delivered to recipient's DID

**Outbound (DMail → SMTP):**
1. Recipient sends DMail reply to bridge DID with `[REPLY:token]`
2. Bridge matches reply to original sender
3. Sends email back via SMTP

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  External Email │◀───▶│  SMTP Bridge Server  │◀───▶│  Archon User    │
│  sender@foo.com │     │  archon-social DID   │     │  @archon.social │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
        SMTP                                              DMail
```

## Quick Start

```bash
# Install dependencies
npm install

# Copy and edit configuration
cp .env.example .env
# Edit .env with your wallet path and passphrase

# Build
npm run build

# Run
npm start

# Test locally
swaks --to genitrix@archon.social --server localhost:2525 --body "Hello!"
```

## Configuration

See `.env.example` for all options. Key settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_PORT` | Inbound SMTP port | `2525` |
| `SMTP_DOMAIN` | Email domain | `archon.social` |
| `GATEKEEPER_URL` | Archon Gatekeeper | `https://archon.technology/api/v1` |
| `WALLET_PATH` | Bridge wallet file | `wallet.json` |
| `WALLET_DIR` | Wallet directory | `./data` |
| `ARCHON_PASSPHRASE` | Wallet passphrase | (required) |
| `SMTP_OUT_HOST` | Outbound SMTP server | `localhost` |
| `REPLY_POLL_INTERVAL_MS` | Reply check interval | `60000` |

---

## Production Deployment (Ubuntu/Debian)

### 1. DNS Records

```dns
; A record for mail server
mail.archon.social.   IN  A      YOUR_SERVER_IP

; MX record
archon.social.        IN  MX  10 mail.archon.social.

; SPF (authorize this server to send email)
archon.social.        IN  TXT    "v=spf1 a mx -all"

; DMARC
_dmarc.archon.social. IN  TXT    "v=DMARC1; p=quarantine"
```

**Verify DNS:**
```bash
dig +short archon.social MX
dig +short mail.archon.social A
dig +short archon.social TXT | grep spf
dig +short -x YOUR_SERVER_IP  # Should return your domain
```

### 2. Firewall & Port Redirect

Ports below 1024 require root. **Best practice:** run the bridge unprivileged on 2525 and redirect port 25.

```bash
# Allow port 25 through firewall
sudo ufw allow 25/tcp

# Redirect port 25 → 2525 (so bridge runs unprivileged)
sudo iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525

# Rate limit: max 10 new connections per minute per IP (spam protection)
sudo iptables -A INPUT -p tcp --dport 25 -m state --state NEW -m recent --set --name SMTP
sudo iptables -A INPUT -p tcp --dport 25 -m state --state NEW -m recent --update --seconds 60 --hitcount 10 --name SMTP -j DROP

# Save iptables rules (persist across reboots)
sudo apt install iptables-persistent
sudo netfilter-persistent save
```

**Verify iptables:**
```bash
sudo iptables -t nat -L PREROUTING -n -v
sudo iptables -L INPUT -n -v | grep SMTP
```

### 3. Install Bridge

```bash
# Create directory
sudo mkdir -p /opt/archon-smtp-bridge
sudo chown $USER:$USER /opt/archon-smtp-bridge

# Clone or copy code
cd /opt/archon-smtp-bridge
git clone https://github.com/flaxscrip/archon-smtp-bridge.git .

# Install dependencies
npm install

# Build
npm run build

# Configure
cp .env.example .env
nano .env  # Edit with your settings
```

### 4. Wallet Setup

The bridge needs an Archon identity to sign DMails:

```bash
# Option A: Copy existing wallet
cp /path/to/existing/wallet.json /opt/archon-smtp-bridge/data/

# Option B: Create new identity
cd /opt/archon-smtp-bridge/data
npx keymaster create-id smtp-bridge
```

### 5. Systemd Service

```bash
sudo nano /etc/systemd/system/smtp-dmail-bridge.service
```

```ini
[Unit]
Description=SMTP-DMail Bridge
After=network.target

[Service]
Type=simple
User=archon
Group=archon
WorkingDirectory=/opt/archon-smtp-bridge
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/archon-smtp-bridge/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/archon-smtp-bridge/data

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable smtp-dmail-bridge
sudo systemctl start smtp-dmail-bridge

# Check status
sudo systemctl status smtp-dmail-bridge
journalctl -u smtp-dmail-bridge -f
```

### 6. Test

```bash
# From another machine
swaks --to yourname@archon.social --server archon.social:25 \
      --from test@example.com --body "Hello from the outside!"

# Check logs
journalctl -u smtp-dmail-bridge -n 50
```

---

## SQLite Database

The bridge tracks all messages in `./data/bridge.db`:

```bash
# View stats
sqlite3 data/bridge.db "SELECT direction, status, COUNT(*) FROM messages GROUP BY direction, status;"

# Recent messages
sqlite3 data/bridge.db "SELECT id, direction, external_email, archon_name, status, received_at FROM messages ORDER BY received_at DESC LIMIT 10;"

# Threads
sqlite3 data/bridge.db "SELECT * FROM threads ORDER BY last_activity DESC LIMIT 10;"
```

---

## Reply Routing

When the bridge delivers a DMail, it includes reply routing info:

**Method 1: DID Properties** (if enabled)
```
bridge:reply-token     = "abc123"
bridge:original-sender = "sender@example.com"
```

**Method 2: Body Fallback**
```
💬 To reply: Send DMail to "archon-social" with [REPLY:abc123] in subject
```

The reply poller checks the bridge's inbox every 60 seconds and routes replies back via SMTP.

---

## Trust Model

The bridge DID signs outgoing DMails, attesting:

> "I received this email claiming to be from `sender@example.com`"

The original sender has no DID — there's no cryptographic proof of their identity. Recipients should evaluate based on context.

---

## Troubleshooting

**Port 25 connection refused:**
```bash
# Check iptables redirect
sudo iptables -t nat -L PREROUTING -n
# Check bridge is running on 2525
ss -tlnp | grep 2525
```

**Name resolution failing:**
```bash
# Test API
curl https://archon.social/api/name/genitrix
```

**Wallet passphrase error:**
```bash
# Verify passphrase works
cd /opt/archon-smtp-bridge
ARCHON_PASSPHRASE='your-pass' npx keymaster list-ids
```

**Check logs:**
```bash
journalctl -u smtp-dmail-bridge -f --no-pager
```

---

## License

MIT
