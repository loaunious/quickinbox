import { json, type RequestHandler } from '@sveltejs/kit';

/**
 * Liveness endpoint for uptime monitors (UptimeRobot, Better Stack, …).
 *
 * Returns 200 only when the Worker can reach D1 and knows its mail provider;
 * returns 503 otherwise so monitors can alert before mail starts failing.
 */
export const GET: RequestHandler = async ({ platform }) => {
	const db = platform?.env.DB;
	const provider = platform?.env.EMAIL_PROVIDER ?? 'resend';

	if (!db) {
		return json({ ok: false, error: 'D1 binding missing', provider }, { status: 503 });
	}

	try {
		await db.prepare('SELECT 1').first();
	} catch (error) {
		return json(
			{ ok: false, error: error instanceof Error ? error.message : 'D1 query failed', provider },
			{ status: 503 }
		);
	}

	return json({ ok: true, provider });
};