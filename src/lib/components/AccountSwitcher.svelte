<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { t } from '$lib/i18n';
	import Icon from './Icon.svelte';
	import type { AccountSummary } from '$lib/server/auth';

	let {
		accounts,
		onSwitch,
		onManage,
		showAddAccount = true
	}: {
		/** Every account this browser is signed in to, with an `active` flag. */
		accounts: AccountSummary[];
		/** Optional hook fired after a successful switch (e.g. to close a menu). */
		onSwitch?: () => void;
		/** Optional hook fired when "Add account" is chosen. Default: go to /login?add=1. */
		onManage?: () => void;
		/** Hide the add action when the list is shown inside the add-account screen. */
		showAddAccount?: boolean;
	} = $props();

	let busyId = $state<string | null>(null);
	let error = $state('');

	function initialsOf(name: string, email: string): string {
		const base = name.trim() ? name : email;
		return (
			base
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => part[0]!.toUpperCase())
				.join('') || '?'
		);
	}

	async function switchTo(account: AccountSummary) {
		if (account.active || busyId) return;
		busyId = account.userId;
		error = '';
		try {
			const res = await fetch('/api/auth/switch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: account.userId })
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? t('account.switchFailed');
				return;
			}
			onSwitch?.();
			// Whole reload: every page's data is per-account.
			location.assign('/inbox');
		} catch {
			error = t('common.networkError');
		} finally {
			busyId = null;
		}
	}

	function addAccount() {
		onManage?.();
		location.assign('/login?add=1');
	}
</script>

{#if accounts.length > 0}
	<div class="acct-switcher">
		<p class="acct-label">{t('account.accounts')}</p>
		<ul>
			{#each accounts as account (account.userId)}
				<li>
					<button
						type="button"
						class="acct-row"
						class:active={account.active}
						disabled={busyId !== null}
						onclick={() => switchTo(account)}
					>
						<span class="acct-avatar">{initialsOf(account.name, account.email)}</span>
						<span class="acct-text">
							<span class="acct-name">{account.name || account.email}</span>
							{#if account.name && account.name !== account.email}
								<span class="acct-email">{account.email}</span>
							{/if}
						</span>
						{#if account.active}
							<span class="acct-check" aria-label={t('account.active')}><Icon name="check-line" size={14} /></span>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
		{#if error}
			<p class="acct-error">{error}</p>
		{/if}
		{#if showAddAccount}
			<button type="button" class="acct-add" onclick={addAccount} disabled={busyId !== null}>
				<Icon name="user-add-line" size={16} /> {t('account.addAccount')}
			</button>
		{/if}
	</div>
{/if}

<style>
	.acct-switcher {
		padding: 0.25rem 0.375rem 0.375rem;
	}

	.acct-label {
		padding: 0.25rem 0.625rem 0.375rem;
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-muted);
	}

	.acct-switcher ul {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.acct-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		padding: 0.4rem 0.625rem;
		border-radius: 0.625rem;
		text-align: left;
		transition: background 0.12s;
	}

	.acct-row:hover:not(:disabled) {
		background: var(--color-surface-muted);
	}

	.acct-row.active {
		background: var(--color-surface-muted);
	}

	.acct-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex: none;
		border-radius: 9999px;
		font-size: 0.625rem;
		font-weight: 600;
		background: var(--color-surface-hover, var(--color-surface-muted));
		color: var(--color-text);
	}

	.acct-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.acct-name {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.acct-email {
		font-size: 0.6875rem;
		color: var(--color-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.acct-check {
		color: var(--color-accent, var(--color-text));
		display: flex;
	}

	.acct-error {
		padding: 0.375rem 0.625rem;
		font-size: 0.75rem;
		color: var(--color-danger, #b91c1c);
	}

	.acct-add {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: calc(100% - 0.75rem);
		margin: 0.25rem 0.375rem 0.125rem;
		padding: 0.5rem 0.625rem;
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		transition: background 0.12s;
	}

	.acct-add:hover:not(:disabled) {
		background: var(--color-surface-muted);
	}
</style>
