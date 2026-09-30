# Packaging and pricing

This document covers how an MSP can charge for Haley and how Haley itself could be sold. Haley doesn't bill anyone. It gives you the numbers: AI cost per client, hours saved, tickets resolved and confirmed, and active technicians. You decide how to charge.

## What the product measures

**Usage & billing** (dashboard → *Usage*, or `GET /api/usage?month=YYYY-MM`) shows each client for a billing month. The same table downloads as CSV (`/api/usage.csv`) for your PSA or accounting tool.

| Column | Meaning |
|---|---|
| Model calls, input and output tokens | Every call Haley made to an AI model on that client's tickets and tasks, including fallbacks. |
| AI cost | Tokens × the prices you enter on each model on the **AI models** page. Haley doesn't hard-code vendor prices, because they change and you may have discounts. A model without prices shows as *unpriced* and is left out of the cost. Cached input tokens are counted at the full input price, so on providers with prompt-cache discounts the figure is an upper bound. |
| Billable AI | AI cost plus your **AI markup** (a workspace setting), for passing costs through to the client. |
| Resolved by Haley | Tickets Haley resolved with no technician touching them. |
| Confirmed by requester | Of those, how many the end user confirmed were fixed. |
| Automatic changes and recipe runs | Changes Haley made without approval, and recipe tasks that completed cleanly. |
| Hours saved | Minutes per ticket resolved alone, plus minutes per automatic change, plus each completed recipe's hands-on estimate. Both per-ticket and per-change minutes are workspace settings, and the assumption is printed with every report. |

Each run's detail page also shows its token count and cost.

### Resolution confirmation

When Haley resolves a ticket, she asks the requester to confirm it's fixed.

- **The requester says it works:** she closes the ticket as *confirmed*. Only the requester's own reply after the fix counts; Haley can't confirm on their behalf.
- **The requester says it isn't fixed:** she picks the ticket back up.
- **No reply:** the ticket closes automatically after the **auto-close** period, 3 days by default. Set it to 0 to turn auto-close off.

On chat channels (Slack, Teams, chat bridge), a reply within 24 hours of the fix continues the resolved ticket instead of opening a new one.

The confirmation rate is the most honest number to show a client. It's the requester saying "yes, fixed", not Haley saying so.

### Technician count

The usage report lists the distinct technician names that did something in the period: approved, rejected, commented, started a task, or edited settings. These are the names people type when they sign in to the dashboard, not verified accounts. Treat the count as an estimate until single sign-on lands.

## Ways to charge your clients

Pick one per client, or mix them.

1. **Bundled into the managed-services fee.** Haley is how you deliver the service more cheaply. Use the hours-saved and confirmed-resolution numbers in QBRs to justify the fee, and keep the AI cost as your own cost of delivery. This works best for all-you-can-eat agreements.
2. **AI pass-through.** Bill each client's AI cost with a markup as a line item. Set the markup once and use the *Billable AI* column. This is transparent and suits clients who ask what AI is costing them.
3. **Per resolved ticket.** Charge a fee per ticket Haley resolved alone, or only per *confirmed* resolution for a stricter promise. Dex launched with this model ($1.99 per resolved ticket) before moving to per-seat pricing.
4. **Per end user, per month.** Add an "AI help desk" tier to your per-user price. The usage report tells you whether the AI cost for each client fits the tier.

Whichever you choose, give each client a model that fits its budget. A client can use a cheaper or self-hosted model, and fallbacks keep tickets moving if a provider is down.

## How Haley could be sold (as a product)

These are options, not a decision. They're here so the numbers above cover whichever one is chosen.

### Option A: per technician, end users free (Dex's model)

- A monthly price per technician seat; end users, channels and clients are unlimited.
- Dex charges $89 per technician per month (Standard) and $189 (Max, about 3× the capacity), with weekly capacity limits.
- **Pros:** easy for MSPs to budget, and familiar from PSA and RMM tools.
- **Cons:** the AI cost scales with ticket volume, not seats, so a small MSP with many tickets costs more to serve. It needs a capacity limit or bring-your-own-model to protect margin.
- **Haley needs:** verified technician accounts (SSO) so seats can be counted reliably, and a capacity limit per workspace.

### Option B: self-hosted with your own model (Haley's differentiator)

- The MSP runs Haley in their own cloud or data centre (Docker) with their own AI keys or local models, and pays a flat licence per workspace or per technician.
- **Pros:** nobody else can offer this. It answers data-residency questions, AI cost is the MSP's own and fully visible, and there's no per-ticket anxiety.
- **Cons:** the MSP runs and updates the software, and support costs more per customer.
- **Haley already has:** Docker, any AI provider including Ollama and vLLM, per-client models, and the usage report for pass-through.

### Option C: hosted with AI included, per resolved ticket

- Haley is hosted and the AI cost is included, and the MSP pays per ticket Haley resolves alone, or per confirmed resolution.
- **Pros:** pay only for results, which makes it easy to trial.
- **Cons:** revenue is unpredictable, and it creates pressure to call tickets "resolved". Confirmation counting helps with that. Dex moved away from this model.

### Recommendation

Lead with **B plus A**:

- Offer a hosted per-technician plan with bring-your-own-model allowed, so AI cost never threatens margin.
- Offer a self-hosted licence for MSPs that need data control.
- Keep end users free in both, because charging for them discourages the self-service that makes Haley valuable.
- Use per-client pass-through (option 2 above) as the MSP's own resale model.

Before launch, the product still needs:

1. Verified technician accounts (SSO) for seat counts.
2. A workspace capacity limit and alert.
3. A billing integration (Stripe) for the hosted plan.
4. The trust items in the Dex comparison (item 10): per-organization encryption keys, data retention, and a security overview.

## API reference

| Endpoint | What it does |
|---|---|
| `GET /api/usage?month=2026-09` | Usage and value per client for a month. Also accepts `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, up to a year). Defaults to this month so far. |
| `GET /api/usage.csv?month=…` | The same, one row per client, as CSV. |
| `GET /api/billing/settings` | `aiMarkupPercent`, `autoCloseResolvedDays`, `minutesPerTicket`, `minutesPerAction`. |
| `PATCH /api/billing/settings` | Change any of them (audited). |
| `GET /api/runs/:id` | Includes `usage` with calls, tokens and cost for that run. |
