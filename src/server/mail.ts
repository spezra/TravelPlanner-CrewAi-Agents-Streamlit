/**
 * Outbound email. SMTP in production (any provider); in development and tests
 * messages are captured in memory and logged so sign-in links are usable.
 * Everything the system sends is labeled as coming from the agency's system.
 */
import { config } from "./config";
import { log } from "./log";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface Mailer {
  send(msg: OutboundEmail): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly sent: OutboundEmail[] = [];
  async send(msg: OutboundEmail): Promise<void> {
    this.sent.push(msg);
    const sink = config().E2E_MAIL_FILE;
    if (sink && config().NODE_ENV !== "production") await (await import("node:fs/promises")).appendFile(sink, JSON.stringify(msg) + "\n");
    log.info({ subject: msg.subject }, "email captured (dev mailer)");
    if (config().NODE_ENV === "development") console.log(`\n--- email to ${msg.to} ---\n${msg.subject}\n\n${msg.text}\n---\n`);
  }
}

class SmtpMailer implements Mailer {
  private transport: Promise<import("nodemailer").Transporter>;
  constructor(url: string, private readonly from: string) {
    this.transport = import("nodemailer").then((m) => m.createTransport(url));
  }
  async send(msg: OutboundEmail): Promise<void> {
    await (await this.transport).sendMail({ from: this.from, ...msg });
  }
}

const g = globalThis as unknown as { __mailer?: Mailer };

export function mailer(): Mailer {
  if (!g.__mailer) {
    const c = config();
    g.__mailer = c.SMTP_URL ? new SmtpMailer(c.SMTP_URL, c.EMAIL_FROM) : new MemoryMailer();
  }
  return g.__mailer;
}

export function setMailer(m: Mailer): void {
  g.__mailer = m;
}

/** Footer on every system-sent message: automation is always disclosed. */
export const SYSTEM_FOOTER = "\n\n—\nSent automatically by the agency's booking system. Reply to reach your advisor.";
