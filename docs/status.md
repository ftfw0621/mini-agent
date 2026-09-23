# Session and account status

`/status` displays the current model, endpoint origin, local session tokens/cache
hits/estimated cost, and the current vendor's supported account metrics. It is a
CLI command, not a model/tool request; account results never enter the model's
conversation. Both Ink and readline support it, with inline command completion.
Ink shows a loading indicator and Escape cancels the lookup.

- `/status local`: local metered session only; no account API requests.
- `/status`: select the account adapter from the configured endpoint's exact HTTPS origin.
- `/status deepseek`, `/status openai`, `/status anthropic`: explicitly query a
  separate official vendor account, useful when inference uses a proxy.

Queries are made on demand, with a ten-second deadline and no automatic retries
or background polling. Re-run the command to refresh. The screen shows when the
query started. Reports use the UTC calendar month to date, not a rolling month.

## Vendor capabilities and credentials

| Vendor | Account balance | Account usage / reported cost | Credential |
| --- | --- | --- | --- |
| DeepSeek | `GET /user/balance`; each returned currency remains separate | No historical usage/cost endpoint integrated | Current inference key for the official DeepSeek endpoint; `DEEPSEEK_API_KEY` for an explicit query from a different endpoint |
| OpenAI | No documented public balance endpoint integrated | Completions usage and organization costs | `OPENAI_ADMIN_KEY` or `OPENAI_ADMIN_API_KEY` |
| Anthropic | No documented public balance endpoint integrated | Messages usage and organization costs; costs exclude Priority Tier | `ANTHROPIC_ADMIN_KEY` or `ANTHROPIC_ADMIN_API_KEY` |
| Other/proxy | Unsupported without its own billing adapter | Local session remains available | No credential is sent automatically |

These are API account metrics, not ChatGPT/Claude subscription limits. OpenAI
and Anthropic reports cover the organization associated with the **admin key**,
across keys/projects/workspaces. They are not attributed to the current mini-agent
session or necessarily to its inference credential. Anthropic's Admin API is not
available for individual accounts; the provider enforces access. Missing
credentials and permission errors explain why a metric is unavailable.

Only documented endpoints on fixed official HTTPS origins are used. Ordinary
OpenAI/Anthropic inference keys are not tried as admin credentials. Model names
never select a billing provider. Redirects are rejected and response/error bodies
are not displayed. Do not put admin keys in prompts or committed settings; use
the environment or the existing ignored `.env` mechanism.

## Accounting semantics

Local usage reuses `/cost`: only metered main/subagent stream responses count.
Auxiliary calls such as permission review/Jev, compaction and title generation
are not included. Local cost uses `settings.pricing`; it is an estimate, and a
single configured tariff may be inaccurate across multiple models. It is never
subtracted from an account balance or presented as an invoice.

Provider usage and cost are independent metrics: a denied cost request does not
hide successful token data. All report pages are fetched, or that metric is marked
unavailable; partial sums are never shown as complete totals. A valid empty report
means zero reported activity. Missing/malformed responses do not mean zero.
OpenAI input tokens already include cache reads. Anthropic's normalized total
input includes uncached input, cache reads and both cache-creation durations.
Anthropic decimal-cent costs are divided by 100; OpenAI costs use their returned
currency units. Monetary display is rounded to four decimals, with no currency
conversion. Vendor reports may lag behind actual requests.

## Official sources checked 2026-09-23

- [DeepSeek balance API](https://api-docs.deepseek.com/api/get-user-balance/)
- [OpenAI Usage API](https://platform.openai.com/docs/api-reference/usage)
- [OpenAI Admin APIs](https://developers.openai.com/api/docs/guides/admin-apis)
- [Anthropic Usage & Cost](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
- [Anthropic usage response](https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages)
- [Anthropic cost response](https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve)

Validation uses mock HTTP responses and real terminal command dispatch; no live
billing keys or account requests are required by the test suite.
