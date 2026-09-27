import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { ConnectorError, type Verifier, type VerificationResult } from "../types.js";

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** Sender: an E.164 number, or a Messaging Service SID (MG…). */
  from: string;
}

/** Finds the phone number already registered on the user's account (never one the requester supplies). */
export type PhoneLookup = (userEmail: string) => Promise<string | null>;

const CODE_TTL_MS = 10 * 60_000;
const MAX_GUESSES = 5;
const hash = (code: string) => createHash("sha256").update(code).digest();

/** Sends an SMS through Twilio's Messages API. */
export async function sendSms(creds: TwilioCredentials, to: string, body: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const form = new URLSearchParams({ To: to, Body: body });
  if (creds.from.startsWith("MG")) form.set("MessagingServiceSid", creds.from);
  else form.set("From", creds.from);
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok) throw new ConnectorError(`Twilio rejected the message: ${data.message ?? res.statusText}${data.code ? ` (${data.code})` : ""}`, res.status);
  return data.sid ?? "";
}

/**
 * Verification by one-time code to the phone number on the user's directory account (Microsoft 365
 * authentication phone or Google recovery phone). Works for any client, with no MFA vendor required.
 */
/** E.164 from directory formats like "+1 555-0142" or "+1 5550142". */
export const toE164 = (phone: string) => {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
};

/** Where the sandbox "sends" its texts: the ticket timeline, so a tester can read the code back. */
export type SandboxOutbox = (userEmail: string, phone: string, body: string) => void;

export class SmsCodeVerifier implements Verifier {
  readonly method = "SMS code";
  readonly kind = "code" as const;
  private readonly codes = new Map<string, { hash: Buffer; expires: number; guesses: number }>();

  constructor(
    /** null: sandbox mode, texts go to the outbox instead of Twilio. */
    private readonly creds: TwilioCredentials | null,
    private readonly lookupPhone: PhoneLookup,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly outbox: SandboxOutbox | null = null,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async verify(userEmail: string, context: { reason: string; ticketNumber: number | null }): Promise<VerificationResult> {
    const found = await this.lookupPhone(userEmail);
    if (!found) return { outcome: "unavailable", detail: "No phone number is registered on this user's account." };
    const phone = toE164(found);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const body = `Your IT verification code${context.ticketNumber ? ` for ticket #${context.ticketNumber}` : ""} is ${code}. It expires in 10 minutes. Only share it in your support conversation, never on a phone call.`;
    if (this.creds) await sendSms(this.creds, phone, body, this.fetchImpl);
    else this.outbox?.(userEmail, phone, body);
    this.codes.set(userEmail.toLowerCase(), { hash: hash(code), expires: this.nowMs() + CODE_TTL_MS, guesses: 0 });
    return { outcome: "code_sent", detail: `Code sent by SMS to the number ending ${phone.replace(/\D/g, "").slice(-2)} on the user's account.` };
  }

  async checkCode(userEmail: string, code: string): Promise<VerificationResult> {
    const key = userEmail.toLowerCase();
    const entry = this.codes.get(key);
    if (!entry || entry.expires < this.nowMs()) {
      this.codes.delete(key);
      return { outcome: "timeout", detail: "No active code: it expired or was never sent." };
    }
    entry.guesses++;
    const given = hash(code.replace(/\D/g, ""));
    if (timingSafeEqual(given, entry.hash)) {
      this.codes.delete(key);
      return { outcome: "approved", detail: "The code sent to the phone on file was confirmed." };
    }
    if (entry.guesses >= MAX_GUESSES) {
      this.codes.delete(key);
      return { outcome: "denied", detail: `Wrong code ${MAX_GUESSES} times; the code was cancelled.` };
    }
    return { outcome: "wrong_code", detail: `That code doesn't match (${MAX_GUESSES - entry.guesses} tries left).` };
  }
}
