import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { OutboundAttachmentInput } from '$lib/types';
import { base64ByteLength } from './attachments';
import { checkRateLimit, getUserById } from './auth';
import { getEmailProviderForEnv } from './context';
import { getAddressForUser } from './domains';
import { buildForwardedMessages } from './forward';
import { readForwardedAttachments } from './forward-mail';
import { getEmailForUser } from './mail-store';
import { resolveReplyFromAddress, sendAndStore } from './outbox';
import type { CloudflareSendEmailBinding } from './providers/cloudflare-provider';
import {
	AUTO_FORWARD_RATE_LIMIT_MAX,
	AUTO_FORWARD_RATE_LIMIT_WINDOW_SECONDS,
	MAX_TOTAL_ATTACHMENT_BYTES
} from './constants';

/**
 * Auto-forwarding.
 *
 * An address with a `forward_to` target re-sends every new inbound message to
 * it, in the same shape as the manual forward. The one difference from the
 * manual flow is who is watching: nobody. So every outcome is recorded in
 * `auto_forwards` for the thread view to show, and the guards below keep a
 * misconfigured pair of addresses from mailing each other forever.
 */

/** Set on every auto-forward we send; cleared never. Receiving it back means a loop. */
export const AUTO_FORWARD_HEADER = 'x-quickinbox-auto-forward';

/** Server-generated content stays English, like the "(no subject)" placeholder. */
export const ATTACHMENTS_OMITTED_NOTE =
	'The attachments were left out of this forward because they exceed the total size limit.';

export type AutoForwardEnv = {
	DB: D1Database;
	ATTACHMENTS: R2Bucket;
	/** Keeps long-lived sends alive after the inbound handler has acknowledged. */
	waitUntil?: (promise: Promise<void>) => void;
	EMAIL_PROVIDER?: string;
	RESEND_API_KEY?: string;
	EMAIL?: CloudflareSendEmailBinding;
	CLOUDFLARE_MAIL_DOMAINS?: string;
};

export type AutoForwardInput = {
	emailId: string;
	userId: string;
	/** The address row that claimed the message; null when it arrived via catch-all. */
	addressId: string | null;
	/** True when the inbound message already carries the auto-forward marker. */
	isBounce: boolean;
};

/** What to do with a freshly stored inbound message, decided before any writing. */
export type AutoForwardDecision =
	| { action: 'ignore'; reason: 'catch-all' | 'no-target' }
	| { action: 'skip'; reason: 'loop-guard' }
	| { action: 'forward' };

export function planAutoForward(input: {
	addressId: string | null;
	forwardTo: string | null | undefined;
	isBounce: boolean;
}): AutoForwardDecision {
	// Catch-all mail has no address row to hang a target on.
	if (!input.addressId) return { action: 'ignore', reason: 'catch-all' };
	if (!input.forwardTo?.trim()) return { action: 'ignore', reason: 'no-target' };
	// A forward we sent came back to us. Forwarding it again would mail the
	// loop back and forth; the marker stops it on the second hop.
	if (input.isBounce) return { action: 'skip', reason: 'loop-guard' };
	return { action: 'forward' };
}

/**
 * Resend hands received headers back as a record whose key case is not
 * guaranteed, so the marker is matched case-insensitively on presence alone.
 */
export function hasAutoForwardMarker(
	headers: Record<string, string> | null | undefined
): boolean {
	if (!headers) return false;
	return Object.keys(headers).some((key) => key.toLowerCase() === AUTO_FORWARD_HEADER);
}

export function attachmentsExceedTotal(attachments: OutboundAttachmentInput[]): boolean {
	const total = attachments.reduce((sum, file) => sum + base64ByteLength(file.content), 0);
	return total > MAX_TOTAL_ATTACHMENT_BYTES;
}

/**
 * Files ride along unless the set is too large to send — in that case the mail
 * still goes out, with a note explaining what was left behind.
 */
export function fitForwardAttachments(attachments: OutboundAttachmentInput[]): {
	attachments: OutboundAttachmentInput[];
	omitted: boolean;
} {
	return attachmentsExceedTotal(attachments)
		? { attachments: [], omitted: true }
		: { attachments, omitted: false };
}

/** Schedule the forward without holding up the inbound-provider acknowledgement. */
export async function scheduleAutoForward(
	env: AutoForwardEnv,
	input: AutoForwardInput
): Promise<void> {
	const task = runAutoForward(env, input);
	if (env.waitUntil) {
		env.waitUntil(task);
		return;
	}
	await task;
}

async function runAutoForward(env: AutoForwardEnv, input: AutoForwardInput): Promise<void> {
	try {
		await deliverAutoForward(env, input);
	} catch (error) {
		// A storage outage between claim and send is the one path that lands here;
		// the claim row keeps its "interrupted" baseline so it never re-sends.
		console.error(
			'Auto-forward failed',
			input.emailId,
			error instanceof Error ? error.message : 'Unknown error'
		);
	}
}

async function deliverAutoForward(env: AutoForwardEnv, input: AutoForwardInput): Promise<void> {
	if (!input.addressId) return;

	const address = await getAddressForUser(env.DB, input.userId, input.addressId);
	const decision = planAutoForward({
		addressId: input.addressId,
		forwardTo: address?.forward_to,
		isBounce: input.isBounce
	});

	if (decision.action === 'ignore') return;
	const target = address!.forward_to!.trim();

	if (decision.action === 'skip') {
		await recordAutoForward(env.DB, input, target, 'skipped', 'Loop protection: this message was already auto-forwarded');
		return;
	}

	// The claim is also the record: one row per email, and its baseline status
	// says the send never finished. A webhook retry finds the row and stops.
	const claimed = await claimAutoForward(env.DB, input, target);
	if (!claimed) return;

	// Counted after the target check so mail to addresses without forwarding
	// never eats into this user's forwarding budget.
	const allowed = await checkRateLimit(
		env.DB,
		`auto-forward:${input.userId}`,
		AUTO_FORWARD_RATE_LIMIT_MAX,
		AUTO_FORWARD_RATE_LIMIT_WINDOW_SECONDS
	);
	if (!allowed) {
		await updateAutoForwardStatus(env.DB, input.emailId, 'skipped', 'Rate limit: too many auto-forwards in this window');
		return;
	}

	const user = await getUserById(env.DB, input.userId);
	const original = await getEmailForUser(env.DB, input.userId, input.emailId);
	if (!user || !original) {
		await updateAutoForwardStatus(env.DB, input.emailId, 'failed', 'The account or message could not be loaded');
		return;
	}

	try {
		const provider = getEmailProviderForEnv(env);
		const files = await readForwardedAttachments(env, user.id, [original], true);
		const { attachments, omitted } = fitForwardAttachments(files);
		const { subject, text, html } = buildForwardedMessages(
			[original],
			omitted ? { note: { text: ATTACHMENTS_OMITTED_NOTE } } : {}
		);
		const fromAddress = await resolveReplyFromAddress(env.DB, user, original);

		await sendAndStore(env, provider, user, {
			fromAddress,
			to: target,
			subject,
			text,
			html,
			attachments,
			headers: { [AUTO_FORWARD_HEADER]: '1' },
			subjectMatch: false
		});
		await updateAutoForwardStatus(env.DB, input.emailId, 'sent', null);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error('Auto-forward delivery failed', input.emailId, message);
		await updateAutoForwardStatus(env.DB, input.emailId, 'failed', message);
	}
}

/** Insert the one-row-per-email record; false when this email was already handled. */
async function recordAutoForward(
	db: D1Database,
	input: Pick<AutoForwardInput, 'emailId' | 'addressId'>,
	target: string,
	status: 'sent' | 'failed' | 'skipped',
	error: string | null
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO auto_forwards (id, email_id, address_id, target, status, error)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.bind(crypto.randomUUID(), input.emailId, input.addressId, target, status, error)
		.run();

	return (result.meta?.changes ?? 0) > 0;
}

/**
 * Claim the forward with a "never finished" baseline, so a worker that dies
 * mid-send leaves an honest row behind instead of silently re-sending on retry.
 */
async function claimAutoForward(
	db: D1Database,
	input: Pick<AutoForwardInput, 'emailId' | 'addressId'>,
	target: string
): Promise<boolean> {
	return recordAutoForward(db, input, target, 'failed', 'Interrupted before the forward could be sent');
}

async function updateAutoForwardStatus(
	db: D1Database,
	emailId: string,
	status: 'sent' | 'failed' | 'skipped',
	error: string | null
): Promise<void> {
	await db
		.prepare('UPDATE auto_forwards SET status = ?, error = ? WHERE email_id = ?')
		.bind(status, error, emailId)
		.run();
}
