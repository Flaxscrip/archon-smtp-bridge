import { SMTPServer } from 'smtp-server';
export interface EmailMessage {
    from: string;
    to: string[];
    subject: string;
    text: string;
    html?: string;
    date: Date;
    messageId?: string;
    headers: Record<string, string>;
}
export interface SMTPBridgeOptions {
    port: number;
    domain: string;
    onEmail: (email: EmailMessage) => Promise<void>;
    maxSize?: number;
}
export declare function createSMTPServer(options: SMTPBridgeOptions): SMTPServer;
export declare function startSMTPServer(server: SMTPServer, port: number): Promise<void>;
//# sourceMappingURL=smtp-server.d.ts.map