import { json, type RequestHandler } from '@sveltejs/kit';
import type { AccountSessionEntry } from '$lib/server/auth';
import {
	forgetAccountSession,
	getAuthenticatedSession,
	login,
	logout,
	readSessionToken,
	readAccountSessionEntries,
	rememberAccountSession
} from '$lib/server/auth';
import { ACCOUNTS_COOKIE, SESSION_COOKIE } from '$lib/server/constants';

export const POST: RequestHandler = async ({ request, cookies, platform, url }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const body = (await request.json()) as { email?: string; password?: string };
	if (!body.email || !body.password) {
		return json({ error: 'Email and password are required' }, { status: 400 });
	}

	const previousToken = readSessionToken(cookies);
	const previousSession = previousToken
		? await getAuthenticatedSession(db, previousToken)
		: null;
	const result = await login(db, body.email, body.password);
	if (!result) {
		return json({ error: 'Invalid email or password' }, { status: 401 });
	}

	const previousAccount =
		previousSession && !previousSession.isMobile && previousToken
			? { u: previousSession.user.id, t: previousToken }
			: undefined;
	rememberAccountSession(cookies, url, result.user.id, result.token, previousAccount);

	return json({ user: result.user });
};

export const DELETE: RequestHandler = async ({ request, cookies, platform, url }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	// Optional body, read once: { userId } signs that account out of the
	// signed-in list; { all: true } signs every account out. Default: just the
	// active account — the other accounts stay signed in.
	let targetUserId: string | undefined;
	let signOutAll = false;
	try {
		const body = (await request.json()) as { userId?: string; all?: boolean };
		targetUserId = body.userId;
		signOutAll = Boolean(body.all);
	} catch {
		// Bodyless DELETE = sign out the active account.
	}

	const activeToken = readSessionToken(cookies);
	const active = activeToken ? await getAuthenticatedSession(db, activeToken) : null;

	const storedEntries = readAccountSessionEntries(cookies);
	const entriesByUser = new Map<string, AccountSessionEntry>();
	for (const entry of storedEntries) {
		const session = await getAuthenticatedSession(db, entry.t);
		if (!session || session.isMobile || session.user.id !== entry.u) continue;
		entriesByUser.delete(entry.u);
		entriesByUser.set(entry.u, entry);
	}
	if (active && !active.isMobile && activeToken) {
		entriesByUser.delete(active.user.id);
		entriesByUser.set(active.user.id, { u: active.user.id, t: activeToken });
	}
	const validEntries = Array.from(entriesByUser.values());

	if (signOutAll) {
		for (const entry of validEntries) await logout(db, entry.t);
		cookies.delete(ACCOUNTS_COOKIE, { path: '/' });
		cookies.delete(SESSION_COOKIE, { path: '/' });
		return json({ ok: true, remainingUserId: null });
	}

	// Resolve which account is being signed out: the explicit target, or the
	// active session. Then delete that session row and pull it from the cookie.
	const targetId = targetUserId ?? active?.user.id;
	if (!targetId) {
		cookies.delete(ACCOUNTS_COOKIE, { path: '/' });
		cookies.delete(SESSION_COOKIE, { path: '/' });
		return json({ ok: true, remainingUserId: null });
	}

	const targetTokens = new Set(
		validEntries.filter((entry) => entry.u === targetId).map((entry) => entry.t)
	);
	if (active?.user.id === targetId && activeToken) targetTokens.add(activeToken);
	for (const token of targetTokens) await logout(db, token);

	// Keep the current session if an inactive account was removed. Pass only
	// validated entries so an expired or revoked cookie entry can't become the
	// next active account.
	const keepActive = active && active.user.id !== targetId ? activeToken : undefined;
	const remainingEntries = validEntries.filter((entry) => entry.u !== targetId);
	const { remaining, activeToken: nextToken } = forgetAccountSession(
		cookies,
		url,
		targetId,
		keepActive,
		remainingEntries
	);
	let remainingUserId: string | null = null;
	if (nextToken) {
		const next = await getAuthenticatedSession(db, nextToken);
		remainingUserId = next?.user.id ?? null;
	}
	return json({ ok: true, remainingUserId, remaining: remaining.length });
};
