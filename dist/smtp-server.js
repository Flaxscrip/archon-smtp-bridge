import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
export function createSMTPServer(options) {
    const { port, domain, onEmail, maxSize = 10 * 1024 * 1024 } = options;
    const server = new SMTPServer({
        // No authentication required for receiving
        authOptional: true,
        // Disable STARTTLS for PoC (enable in production)
        disabledCommands: ['STARTTLS'],
        // Size limit
        size: maxSize,
        // Banner
        banner: `SMTP-DMail Bridge for ${domain}`,
        // Validate recipient - only accept for our domain
        onRcptTo(address, session, callback) {
            const recipient = address.address.toLowerCase();
            if (!recipient.endsWith(`@${domain}`)) {
                return callback(new Error(`Only accepting mail for @${domain}`));
            }
            console.log(`[SMTP] Accepting mail for: ${recipient}`);
            callback();
        },
        // Handle incoming email data
        onData(stream, session, callback) {
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', async () => {
                try {
                    const rawEmail = Buffer.concat(chunks);
                    const parsed = await simpleParser(rawEmail);
                    // Extract recipients from session envelope
                    const recipients = session.envelope.rcptTo.map(r => r.address.toLowerCase());
                    // Get sender
                    const mailFrom = session.envelope.mailFrom;
                    const sender = parsed.from?.value[0]?.address ||
                        (mailFrom && typeof mailFrom !== 'boolean' ? mailFrom.address : null) ||
                        'unknown@unknown';
                    // Build email message
                    const email = {
                        from: sender,
                        to: recipients,
                        subject: parsed.subject || '(no subject)',
                        text: parsed.text || '',
                        html: parsed.html || undefined,
                        date: parsed.date || new Date(),
                        messageId: parsed.messageId,
                        headers: {}
                    };
                    // Extract relevant headers
                    if (parsed.headers) {
                        for (const [key, value] of parsed.headers) {
                            if (typeof value === 'string') {
                                email.headers[key] = value;
                            }
                        }
                    }
                    console.log(`[SMTP] Received email from ${email.from} to ${email.to.join(', ')}`);
                    console.log(`[SMTP] Subject: ${email.subject}`);
                    // Process the email
                    await onEmail(email);
                    callback();
                }
                catch (error) {
                    console.error('[SMTP] Error processing email:', error);
                    callback(error instanceof Error ? error : new Error(String(error)));
                }
            });
            stream.on('error', (err) => {
                console.error('[SMTP] Stream error:', err);
                callback(err);
            });
        },
        // Log connections
        onConnect(session, callback) {
            console.log(`[SMTP] Connection from ${session.remoteAddress}`);
            callback();
        },
        onClose(session) {
            console.log(`[SMTP] Connection closed from ${session.remoteAddress}`);
        }
    });
    return server;
}
export function startSMTPServer(server, port) {
    return new Promise((resolve, reject) => {
        server.listen(port, () => {
            console.log(`[SMTP] Server listening on port ${port}`);
            resolve();
        });
        server.on('error', (err) => {
            console.error('[SMTP] Server error:', err);
            reject(err);
        });
    });
}
//# sourceMappingURL=smtp-server.js.map