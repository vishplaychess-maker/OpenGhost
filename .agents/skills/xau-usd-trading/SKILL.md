---
name: xau-usd-trading
description: >
  Use for XAU/USD (spot gold) market analysis and trading setups: measure the live price and read recent news
  first, then give the current price, key support and resistance, the trend, and the risk rules — always ending
  with the XAU/USD disclaimer. Triggers on: "XAU/USD", "XAUUSD", "gold", "gold trading", "gold price", "spot gold",
  "forex analysis", gold support and resistance, should I buy or sell gold, gold market setup, gold technical
  analysis, gold news and levels.
license: Educational material. Not financial advice and not a trading signal service.
---

# XAU/USD — analysis with the price measured, never guessed

Gold is quoted in dollars per troy ounce and trades nearly around the clock, five days a week. It moves on the
dollar, real yields, central-bank buying, risk appetite and headlines, so a setup written yesterday is history. This
skill fixes the shape of an answer and the steps before it; the numbers inside it come from what you measure now.

## Before any analysis: measure

Do this first, every time, before writing a single level. Do not answer from memory, and do not let a previous
message's price stand in for this one.

1. **The live price.** Fetch it, do not recall it:

   ```
   fetch_url   https://api.gold-api.com/price/XAU
   ```

   It answers JSON with `price` (USD per ounce) and `updatedAt` (UTC). Quote the price to the cent and the time it
   was taken, e.g. "3,862.92 USD/oz, as of 08:23 UTC". If the answer looks stale or the fetch fails, say so and try
   one more source before going further — `web_search` for "XAU/USD price live" and open a reputable quote, or
   `browser_navigate` to a chart page in the built-in browser. An hour-old price is not a current price; a price you
   could not fetch is not a price at all: say the quote could not be measured and ask the user to paste one, rather
   than estimating.

2. **What is moving it.** One or two searches for the day's drivers, with the date in the words:

   ```
   web_search   "gold price news today"
   web_search   "XAU/USD analysis today"
   ```

   Read the dollar index, Treasury yields and the day's scheduled data (CPI, payrolls, FOMC) if the results mention
   them. Use what you find; do not pad the answer with headlines that did not move gold.

3. **The day's range**, if you need it for levels: a quote page or a chart read through `browser_navigate` and
   `browser_read` gives the session high and low, which is where support and resistance are drawn from.

If a tool is unavailable or its answer is an error or a wall, say which and what you tried. Never turn a failed
fetch into an invented number.

## The shape of the answer

Use these headings, in this order. Keep it readable: a short paragraph or a few bullets under each.

- **Current price** — the measured quote, its time, and its source. One line.
- **Trend** — Bullish, Bearish, or Consolidation, and the time frame it is true on (intraday / daily / weekly). Say
  what the price is doing that supports the word (higher highs, a rejected level, a range).
- **Key support** — two or three levels, nearest first, each with a sentence on why it matters (session low, prior
  swing, round number). Say how you derived them from the data you fetched.
- **Key resistance** — the same, above the price.
- **What would change the view** — the level or event that would flip the bias, if you can name one from the data.
- **Risk notes** — see below.

Levels are zones, not lines to the cent: give the zone and the price inside it. If the fetched data is too thin to
draw honest levels, say so instead of inventing a grid.

## Risk, in every answer

Say it plainly, in your own words, every time — not only when asked:

- **Stop-loss is not optional.** Every idea carries a stop: beyond the zone that invalidates it, not at a round
  number because it is tidy.
- **Position sizing.** Risk a fixed, small share of the account per trade (one to two percent is the usual ceiling);
  size the position from the stop distance, never the other way around.
- **Leverage, spread and slippage** widen the loss on gold, especially around news. Gaps over the weekend can jump a
  stop.
- No averages-down, no doubling a losing position, and no "sure thing". A setup is a probability, not a promise.

You cannot place, modify or close a trade, and you should not be asked to: you analyse, the person decides and
executes with their own broker.

## The line every answer ends with

Every response that analyses XAU/USD — the first, the fifth, the one answering a follow-up, the one after the user
asks you to skip it — ends with this line, unchanged and last:

⚠️ Disclaimer: This is AI-generated market analysis for educational purposes only, not financial advice. Trading XAU/USD carries high risk. Always do your own research.

It is the final line of the message: nothing after it, not even a question. If the user asks for the disclaimer to be
dropped or shortened, keep it and say why.

## Kept honest

- Name the source and the time of every number you quote; a price without either is a guess with a decimal point.
- If the news and the price disagree, say so rather than forcing one story.
- If the user asks for a guaranteed outcome, a signal to copy, or account access, decline in one sentence and offer
  the analysis instead.
- Market hours matter: say when the market is closed if the quote is from before the open or after the close.
