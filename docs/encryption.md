# Encrypting a date of birth and a passport

Scope, decided deliberately: **group travellers only**. Those are the records
created when somebody registers for a group trip on a public page. Nothing else
in the portal is encrypted, and that is a choice rather than an oversight.

## Why only there

Three reasons, in order of how much they matter.

A group trip page is the one place in this portal where a **stranger on the
open internet** types a passport number in. Everything else is an advisor
typing in a client they already know, on a page behind a login. The exposure is
not the same.

The existing `travellers` and `clients` passport columns hold **live data**, and
encrypting them means a migration that rewrites every row, a change to every
read path, and the permanent loss of being able to search or sort on them. That
is a decision for the agency, not a change to slip in beside a feature.

And an encrypted column **cannot be queried**. The passport expiry on a client
feeds the six month rule, which is a comparison in SQL. Encrypt it and that
check has to be done in the Worker over every row, which is a different and
worse program.

## What it protects against

A copy of the database getting out. A stolen export, a backup bundle read by
the wrong person, a console session left open. In all of those the ciphertext
is worthless without the key, and the key is a Worker secret rather than a row
in the database.

**It does not protect against the Worker.** Anything that can run this code can
read the key and therefore the plaintext. There is no way around that while a
cruise line refuses to take a booking without a passport number.

## How

AES-GCM, 256 bit, from the Web Crypto API that Workers already provide. A fresh
12 byte nonce for every value. GCM authenticates as well as encrypts, so a
ciphertext somebody has edited fails to open rather than opening to something
else.

Stored as `v1.<base64 nonce>.<base64 ciphertext>`, versioned from the first row
so the scheme can change without guessing what an old value is.

The columns say so in their names: `dob_enc`, `passport_number_enc`,
`passport_expiry_enc`. `passport_country` is **not** encrypted, because a
country of issue narrows nobody down and is wanted on every manifest, so
encrypting it would cost the list its only sortable column and hide nothing.

See `src/pii.js`.

## The key

One secret, `PII_KEY`: 32 random bytes, base64. Make one with

    openssl rand -base64 32

and set it in the Cloudflare dashboard under Settings, Variables and Secrets.
Never in `wrangler.toml`, never in the repository.

**Without it the portal does not collect the fields at all.** The registration
form leaves the passport and date of birth boxes out, and the handler refuses
those values if something sends them anyway. That is deliberate: a form that
takes a passport number and cannot encrypt it has to either write it in the
clear or throw it away, and both are worse than not asking.

**Losing the key loses the data.** There is no recovery and no escrow. Every
sealed value becomes permanently unreadable, which is the point of the design
and still worth saying out loud. Keep a copy somewhere a person can reach,
outside this account.

**Rotating it is not supported yet.** A second key would have to open the old
values while sealing new ones, and the `v1` prefix is where that goes when it
is needed. Until then, changing `PII_KEY` orphans everything sealed with the
old one.

## Retention and deletion

Group traveller records live as long as the group does. They are removed when
the registration is removed, when the group is deleted, and when the agency is
deleted, which names every table rather than relying on cascades, because D1
does not enforce foreign keys.

An export includes group travellers with these three fields **redacted**, not
decrypted. A manifest the agency needs for a supplier is a separate, deliberate
action on the group's own screen, which is logged.

When somebody asks to be forgotten, deleting the row is enough: there is no
second copy of the plaintext anywhere, and the weekly backup bundles hold the
redacted form. The bundles themselves are listed in `docs/data.md`.
