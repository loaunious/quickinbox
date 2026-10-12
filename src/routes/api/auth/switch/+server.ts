import { json, type RequestHandler } from '@sveltejs/kit';
import {
	activateAccountSession,
	getAuthenticatedSession,
	readAccountSessionEntries
} from '$lib/server/auth';

/**
 * Gmail-style account switch: point the session cookie at another account this
 * browser is signed into. The token never crosses the wire — it is read back
 * out of your own accounts cookie, so a request can only activate a session
 * the browser already holds.
 */
export const POST: RequestHandler = async ({ request, cookies, platform, url }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	let body: { userId?: unknown };
	try {
		body = (await request.json()) as { userId?: unknown };
	} catch {
		return json({ error: 'A valid JSON body is required' }, { status: 400 });
	}
	if (typeof body.userId !== 'string' || !body.userId) {
		return json({ error: 'userId is required' }, { status: 400 });
	}

	// Validate the target session exists AND is still live server-side. The
	// accounts cookie alone is not proof — sessions can be revoked server-side.
	const entries = readAccountSessionEntries(cookies);
	const entry = entries.find((item) => item.u === body.userId);
	if (!entry) {
		return json({ error: 'That account is not signed in on this device' }, { status: 404 });
	}

	const session = await getAuthenticatedSession(db, entry.t);
	if (!session || session.isMobile || session.user.id !== body.userId) {
		return json({ error: 'That session has expired. Sign in to it again.' }, { status: 410 });
	}

	if (!activateAccountSession(cookies, url, body.userId)) {
		return json({ error: 'Could not switch to that account' }, { status: 500 });
	}

	return json({ ok: true, user: session.user });
};
