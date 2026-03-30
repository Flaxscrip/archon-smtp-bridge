# SMTP-to-DMail Bridge

> Receive external emails at `user@archon.social` and deliver them as encrypted DMail messages.

## Overview

This bridge allows anyone with a standard email client to send messages to Archon users. Incoming emails are:

1. Received via SMTP
2. Recipient name resolved to DID via archon.social
3. Converted to DMail format
4. Encrypted and delivered to recipient's DID

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  External Email │────▶│  SMTP Bridge Server  │────▶│  Recipient DID  │
│  sender@foo.com │     │  did:cid:bridge-did  │     │  bob@archon.social
└─────────────────┘     └──────────────────────┘     └─────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Copy and edit configuration
cp .env.example .env

# Run in development mode
npm run dev

# Test with swaks
swaks --to genitrix@archon.social --server localhost:2525 --body "Hello from email!"
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_PORT` | SMTP server port | `2525` |
| `SMTP_DOMAIN` | Domain for email addresses | `archon.social` |
| `ARCHON_SOCIAL_API` | Herald/naming service URL | `https://archon.social` |
| `GATEKEEPER_URL` | Gatekeeper API URL | `https://archon.technology/api/v1` |
| `WALLET_PATH` | Path to bridge wallet | `./data/wallet.json` |
| `ARCHON_PASSPHRASE` | Wallet passphrase | (required) |

## Trust Model

The bridge server's DID signs outgoing DMails. It attests:

> "I received this email claiming to be from `sender@example.com`"

The original sender has no DID, so there's no cryptographic proof of their identity. The DMail includes metadata about the original sender for the recipient to evaluate.

## DMail Format

```json
{
  "to": ["did:cid:recipient-did"],
  "cc": [],
  "subject": "[Email] Original Subject",
  "body": "Original message content\n\n---\n📧 Received via SMTP Bridge\nFrom: sender@example.com\nDate: 2026-03-30T12:00:00Z"
}
```

## Production Deployment

### DNS Records

```
; MX record pointing to your mail server
archon.social.        IN  MX  10  mail.archon.social.

; A record for the mail server
mail.archon.social.   IN  A   your-server-ip
```

### Systemd Service

```ini
[Unit]
Description=SMTP-DMail Bridge
After=network.target

[Service]
Type=simple
User=archon
WorkingDirectory=/opt/smtp-dmail-bridge
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/opt/smtp-dmail-bridge/.env

[Install]
WantedBy=multi-user.target
```

### Security Considerations

- Run on port 25 requires root or `setcap`
- Enable STARTTLS in production
- Implement rate limiting per sender IP
- Consider SPF/DKIM validation
- Bridge wallet keys need secure storage

## Future Enhancements

- [ ] SPF/DKIM/DMARC verification
- [ ] Rate limiting per sender
- [ ] Outbound email (DMail → SMTP replies)
- [ ] Attachment support (store on IPFS)
- [ ] Web interface for bridge status

## License

MIT
