/** Mailer interface + dev transports (TZ §6: verification, reset links, invites). */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Machine-readable kind, handy for tests and templates. */
  kind: 'email_verify' | 'password_reset' | 'invite' | 'email_code' | 'account_exists';
  link: string;
  /** v0.6.0: the 6-digit registration code (kind `email_code`); handy for tests. */
  code?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Dev transport: prints the mail to stdout (not the structured log, to keep PII out of logs). */
export class ConsoleMailer implements Mailer {
  async send(mail: Mail) {
    process.stdout.write(`\n--- mail (${mail.kind}) to ${mail.to}\nSubject: ${mail.subject}\n${mail.text}\n---\n`);
  }
}

/** Test transport: keeps an outbox. */
export class MemoryMailer implements Mailer {
  readonly outbox: Mail[] = [];
  async send(mail: Mail) {
    this.outbox.push(mail);
  }
  last(kind?: Mail['kind']): Mail | undefined {
    return [...this.outbox].reverse().find((m) => !kind || m.kind === kind);
  }
}
