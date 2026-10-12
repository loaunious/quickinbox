import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import {
	handleCloudflareInbound,
	type CloudflareInboundEnv,
	type CloudflareInboundMessage
} from './lib/server/cloudflare-inbound';
// Renamed from `_worker.js` by `scripts/wrap-cloudflare-worker.mjs` after `vite build`.
// @ts-expect-error file is created at build time
import sveltekit from '../.svelte-kit/cloudflare/_sveltekit.js';

type SvelteKitWorker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
};

const svelteApp = sveltekit as SvelteKitWorker;

const WEBHOOK_EVENT_RETENTION_DAYS = 30;

/**
 * Runs on the `triggers.crons` schedule: prunes webhook dedupe rows once they
 * are no longer needed for retry idempotency, keeping the D1 database from
 * growing without bound as mail volume increases.
 */
async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
	const db = env.DB;
	if (typeof db?.prepare !== 'function') return;

	ctx.waitUntil(
		(async () => {
			try {
				await db
					.prepare(
						`DELETE FROM webhook_events
						 WHERE created_at < datetime('now', '-${WEBHOOK_EVENT_RETENTION_DAYS} days')`
					)
					.run();
			} catch (error) {
				console.error('Webhook event cleanup failed', error);
			}
		})()
	);
}

/**
 * SvelteKit's generated Worker is fetch-only. This wrapper keeps HTTP on
 * SvelteKit and adds Cloudflare Email Service's `email()` handler.
 */
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		if (typeof svelteApp.fetch !== 'function') {
			throw new Error('SvelteKit worker export is missing fetch');
		}
		return svelteApp.fetch(request, env, ctx);
	},

	scheduled,

	async email(message: CloudflareInboundMessage, env: Env, ctx: ExecutionContext) {
		if (env.EMAIL_PROVIDER?.trim().toLowerCase() !== 'cloudflare') {
			message.setReject('Cloudflare email provider is not enabled');
			return;
		}

		const inboundEnv: CloudflareInboundEnv = {
			DB: env.DB,
			ATTACHMENTS: env.ATTACHMENTS,
			VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
			VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
			VAPID_SUBJECT: env.VAPID_SUBJECT,
			// Auto-forwarding needs the send side, which only exists on the full
			// worker env — the SvelteKit platform is not available in email().
			EMAIL_PROVIDER: env.EMAIL_PROVIDER,
			RESEND_API_KEY: env.RESEND_API_KEY,
			EMAIL: env.EMAIL,
			CLOUDFLARE_MAIL_DOMAINS: env.CLOUDFLARE_MAIL_DOMAINS,
			waitUntil: (promise) => ctx.waitUntil(promise)
		};

		await handleCloudflareInbound(message, inboundEnv);
	}
};
