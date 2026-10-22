# DialF Feature Request — `sims.list` operator + network code

Date: 2026-10-22 · From: Vox · Related: `2026-10-22-network-tags-design.md` ("`sim` is system-only", added 2026-10-22), `2026-09-21-dialf-requirements-for-vox-phone-eval.md`

## What's requested

Today's `sims.list` returns slot / number / default only. Please add, per entry:

- **Operator name** — Android `TelephonyManager.getSimOperatorName()` /
  `SubscriptionInfo.getCarrierName()`.
- **Network code** — MCC + MNC, as two separate fields: Android
  `SubscriptionInfo.getMccString()` and `getMncString()` (or
  `TelephonyManager.getSimOperator()`, the 5–6 digit MCC+MNC concatenation,
  if that's what's already on hand — we can split it).

```jsonc
// sims.list entry, with the two new fields
{ "slot": 0, "number": "+15551234567", "default": true,
  "operator_name": "T-Mobile", "mcc": "310", "mnc": "260" }
```

**Field names Vox already accepts** — no DialF-side bikeshedding needed:
our client takes either `operator` or `operator_name` for the name (a bare
numeric string in either is read as the MCC+MNC pair), and `mcc`/`mnc` for
the codes. Whatever you send under these names, we parse.

## Why

Vox tags every phone-eval result with `sim` — which radio network our own
SIM (the calling side of the test) was on when it ran. We already look up
our SIM's own number against Twilio Lookup, which returns a carrier name and
MCC/MNC for that number. To call a result's `sim` tag anything, we need to
*compare* that lookup's network code against what the phone's SIM itself
reports — not the lookup alone, and not a name match (an MVNO's lookup
carrier name and its host network's name can differ; the network code is
what makes it host-network-accurate, e.g. a Mint Mobile SIM correctly tags
as `t-mobile`). Without an MCC/MNC from `sims.list`, Vox has only one side
of that comparison and can never set `sim` at all — it's refused rather than
guessed.

The operator name isn't itself what we tag with (we derive the tag from the
matched network code), but it's useful for diagnosing a lookup/SIM
mismatch without us needing a second round trip.

## Privacy note

We don't need the IMSI or ICCID — the SIM's permanent identifiers never
leave the phone today, and this request doesn't change that. Operator name
and MCC/MNC describe the *network*, not the subscriber; Vox already treats
the SIM's phone number itself as sensitive (stored redacted to its last 4
digits, never logged — see "Privacy" under `sim` in the network-tags
design) and that handling is unaffected by this request.

## Everything else about Vox's phone integration is unchanged

No change to `job.run`, call control, recording legs, or any of the
primitives in the prior requirements doc — this is additive to `sims.list`
only.
