import type { MessageOutbox } from '@prisma/client';
import { logger } from '../lib/misc';

/**
 * Messaging provider interface (spec §20: no WhatsApp vendor assumed).
 * A real WhatsApp Business Platform adapter implements this and is selected by `whatsapp.provider`.
 */
export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  response?: Record<string, unknown>;
  /** transient → retry with backoff; permanent → terminal failure immediately */
  errorClass?: 'transient' | 'permanent';
  error?: string;
}

export interface SendContext {
  /** Clinic sender number (setting `whatsapp.senderNumber`). */
  senderNumber: string;
  /** Approved provider template name mapped from the internal template (setting `whatsapp.templates`). */
  providerTemplate: string | undefined;
  /** Template parameters in order (see services/messageTemplates.ts). */
  variables: string[];
  /** Readable text (console / logs only; real providers send the approved template). */
  text: string | null;
}

/**
 * A real adapter (WhatsApp Business Platform vendor) implements this, registers itself with `registerProvider`,
 * and reports delivery receipts to POST /api/webhooks/whatsapp/status. `requiresTemplates` adapters only send
 * approved templates: messages whose internal template is not mapped fail permanently (Manager alerted).
 */
export interface MessageProvider {
  readonly id: string;
  readonly requiresTemplates: boolean;
  send(msg: MessageOutbox, ctx: SendContext): Promise<SendResult>;
}

/** Default: logs the message and reports success. Delivery receipts are simulated as immediate. */
export class ConsoleProvider implements MessageProvider {
  readonly id = 'console';
  readonly requiresTemplates = false;
  async send(msg: MessageOutbox, ctx: SendContext): Promise<SendResult> {
    logger.info({ to: msg.toPhone, template: msg.template, providerTemplate: ctx.providerTemplate, text: ctx.text }, '[console-provider] message');
    return { ok: true, providerMessageId: `console_${msg.id}`, response: { simulated: true } };
  }
}

/** Test double: fails according to a script so retry/terminal paths can be exercised. */
export class ScriptedProvider implements MessageProvider {
  readonly id = 'scripted';
  calls: string[] = [];
  contexts: SendContext[] = [];
  constructor(
    private readonly script: SendResult[],
    readonly requiresTemplates = false,
  ) {}
  async send(msg: MessageOutbox, ctx: SendContext): Promise<SendResult> {
    this.calls.push(msg.id);
    this.contexts.push(ctx);
    return this.script.shift() ?? { ok: true, providerMessageId: `scripted_${msg.id}_${this.calls.length}` };
  }
}

const registry = new Map<string, MessageProvider>([['console', new ConsoleProvider()]]);

export function registerProvider(p: MessageProvider): void {
  registry.set(p.id, p);
}

/** Unknown ids return undefined: a typo in `whatsapp.provider` must fail loudly, never fall back to the console mock. */
export function getProvider(id: string): MessageProvider | undefined {
  return registry.get(id);
}

export function providerIds(): string[] {
  return [...registry.keys()];
}
