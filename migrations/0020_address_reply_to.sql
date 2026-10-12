-- Optional Reply-To override per address. When set, mail sent from this
-- address carries Reply-To: <reply_to> instead of the sender's own address.
-- Used for addresses like bassey@mail.utillylabs.com whose replies should
-- land on the root-domain mailbox (bassey@utillylabs.com).
ALTER TABLE addresses ADD COLUMN reply_to TEXT;
