/**
 * Built-in model rates, in dollars per million tokens.
 *
 * 🔒 LOCKED [DEFAULT-RATES-SHIP-WITH-THE-PACKAGE] — 2026-08-20
 * ⛔ NEVER ship an empty default pricing table again.
 * WHY: `[PRICING-LIVES-IN-POLICY]` was read as "ship no rates at all", so
 *    2.5.0 shipped `pricing: []` as the default. Every user without an
 *    `agent_cost` block in their own policy.json got a VALUED COST panel
 *    reading `total $0.00` and `caching saved $0.00 (0%)` over 1.08 BILLION
 *    real tokens — a confident, wrong-looking verdict on the headline feature
 *    of the release. The LOCK's intent was "rates must be correctable without
 *    a release", not "the product ships priced at nothing".
 * FIX: ship rates here, as DATA in their own module, never inline in the
 *    collector / detector / CLI. `.contextengine/policy.json` →
 *    `agent_cost.pricing` still wins outright when present, and this file
 *    compiles to plain readable JS in `dist/`, so a rate can be corrected in
 *    place without waiting for a release.
 *
 * Rates are Anthropic API list prices. Cache read is 0.1x input, cache write
 * 5m is 1.25x input, cache write 1h is 2x input.
 */

import type { ModelPricing } from "./transcript-collector.js";

/**
 * When these rates were last checked against published pricing. Surfaced in
 * `contextengine cost` output: a rate table with no date is a rate table
 * nobody knows to distrust.
 */
export const DEFAULT_PRICING_ASOF = "2026-08-20";

function rate(model: string, input: number, output: number): ModelPricing {
  return {
    model,
    input_per_mtok: input,
    output_per_mtok: output,
    cache_read_per_mtok: Number((input * 0.1).toFixed(4)),
    cache_write_5m_per_mtok: Number((input * 1.25).toFixed(4)),
    cache_write_1h_per_mtok: Number((input * 2).toFixed(4)),
  };
}

/**
 * Longest-prefix matched, so dated ids (`claude-haiku-4-5-20251001`) resolve
 * to their family. Deliberately NO `*` catch-all: a model absent from this
 * table must report as UNPRICED, never be valued at a guessed rate
 * (`[ABSENCE-IS-NOT-A-VERDICT]`).
 */
export const DEFAULT_PRICING: ModelPricing[] = [
  rate("claude-opus-5", 5, 25),
  rate("claude-opus-4-8", 5, 25),
  rate("claude-opus-4-7", 5, 25),
  rate("claude-opus-4-6", 5, 25),
  rate("claude-opus-4-5", 5, 25),
  rate("claude-fable-5", 10, 50),
  rate("claude-mythos-5", 10, 50),
  rate("claude-sonnet-5", 3, 15),
  rate("claude-sonnet-4-6", 3, 15),
  rate("claude-sonnet-4-5", 3, 15),
  rate("claude-haiku-4-5", 1, 5),
];
