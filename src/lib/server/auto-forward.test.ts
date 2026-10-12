import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	ATTACHMENTS_OMITTED_NOTE,
	attachmentsExceedTotal,
	fitForwardAttachments,
	hasAutoForwardMarker,
	planAutoForward
} from './auto-forward';
import { buildForwardedMessages } from './forward';
import { MAX_TOTAL_ATTACHMENT_BYTES } from '$lib/constants';

/** Base64 that decodes to the given number of bytes, with no padding. */
function base64Bytes(bytes: number): string {
	return 'A'.repeat(Math.ceil((bytes * 4) / 3));
}

function attachment(content: string) {
	return { filename: 'report.bin', type: 'application/octet-stream', content };
}

describe('planning an auto-forward', () => {
	test('catch-all mail has no address row to hang a target on', () => {
		assert.deepEqual(planAutoForward({ addressId: null, forwardTo: 'me@example.com', isBounce: false }), {
			action: 'ignore',
			reason: 'catch-all'
		});
	});

	test('an address without a target is not forwarded', () => {
		assert.deepEqual(planAutoForward({ addressId: 'a1', forwardTo: null, isBounce: false }), {
			action: 'ignore',
			reason: 'no-target'
		});
		assert.deepEqual(planAutoForward({ addressId: 'a1', forwardTo: '   ', isBounce: false }), {
			action: 'ignore',
			reason: 'no-target'
		});
	});

	test('a message this system already forwarded is never forwarded again', () => {
		// Two addresses pointing at each other would otherwise mail the same
		// message back and forth forever; the marker stops the second hop.
		assert.deepEqual(planAutoForward({ addressId: 'a1', forwardTo: 'me@example.com', isBounce: true }), {
			action: 'skip',
			reason: 'loop-guard'
		});
	});

	test('ordinary inbound mail on a forwarding address is forwarded', () => {
		assert.deepEqual(planAutoForward({ addressId: 'a1', forwardTo: 'me@example.com', isBounce: false }), {
			action: 'forward'
		});
	});
});

describe('the auto-forward marker header', () => {
	test('matches the lower-case spelling providers hand back', () => {
		assert.equal(hasAutoForwardMarker({ 'x-quickinbox-auto-forward': '1' }), true);
	});

	test('matches whatever case the header arrives in', () => {
		assert.equal(hasAutoForwardMarker({ 'X-QuickInbox-Auto-Forward': '1' }), true);
		assert.equal(hasAutoForwardMarker({ 'X-QUICKINBOX-AUTO-FORWARD': '1' }), true);
	});

	test('is absent from ordinary received headers', () => {
		assert.equal(hasAutoForwardMarker({ from: 'ada@example.com', 'in-reply-to': '<x>' }), false);
		assert.equal(hasAutoForwardMarker({}), false);
		assert.equal(hasAutoForwardMarker(undefined), false);
		assert.equal(hasAutoForwardMarker(null), false);
	});
});

describe('fitting attachments into an auto-forward', () => {
	test('a set within the limit rides along unchanged', () => {
		const files = [attachment(base64Bytes(1024))];
		assert.equal(attachmentsExceedTotal(files), false);
		assert.deepEqual(fitForwardAttachments(files), { attachments: files, omitted: false });
	});

	test('a set over the total limit is dropped so the mail still goes out', () => {
		const files = [attachment(base64Bytes(MAX_TOTAL_ATTACHMENT_BYTES + 1))];
		assert.equal(attachmentsExceedTotal(files), true);
		assert.deepEqual(fitForwardAttachments(files), { attachments: [], omitted: true });
	});

	test('the omitted-attachments note sits above the forwarded message', () => {
		const original = {
			from_addr: 'ada@example.com',
			to_addr: 'support@ourdomain.test',
			subject: 'Quarterly figures',
			body_text: 'The numbers are attached.',
			body_html: null,
			created_at: '2026-10-12 08:30:00'
		};
		const { text } = buildForwardedMessages([original], { note: { text: ATTACHMENTS_OMITTED_NOTE } });
		assert.ok(text.startsWith(ATTACHMENTS_OMITTED_NOTE));
		assert.ok(text.includes('---------- Forwarded message ----------'));
	});
});
