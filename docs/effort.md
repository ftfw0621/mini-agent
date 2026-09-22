# Reasoning effort

Use `/effort` to see the current model's supported levels. In the default Ink UI,
choices appear below the input while typing; use arrows and Enter to choose, or
Tab to complete the text. `/effort high` sets a level directly. `/effort default`
removes the override and leaves the choice to the provider. The readline fallback
opens a selection menu after submitting `/effort`.

Selections live for this process, keyed by endpoint and model. Switching models
does not apply another model's effort setting. The override applies to agent
loop calls using that model, including workers with the same model. Auxiliary
calls such as title generation, compaction and permission review keep their own
defaults.

`src/effort.ts` separates capabilities, selection and wire-format adaptation.
Built-in profiles cover explicitly known OpenAI and DeepSeek model IDs at their
official endpoints. Unknown model IDs or gateways display an explanation rather
than guessing which parameters they accept. `/models` has no standard effort
capability field.

For a custom gateway, add a profile to `.mini-agent/settings.json` or
`~/.config/mini-agent/settings.json`, using the exact model ID:

```json
{
  "effortProfiles": {
    "my-reasoning-model": {
      "levels": ["low", "medium", "high"],
      "parameter": "reasoning_effort"
    }
  }
}
```

Only list levels supported by your endpoint. `parameter: "reasoning_effort"`
sends the selected value as the Chat Completions `reasoning_effort` field.
`parameter: "deepseek"` also adapts `thinking.type`: `none` disables thinking,
while the other levels enable it. An optional `default` labels the provider's
default; it does not force a request parameter. An empty `levels` list disables
selection. Project profiles override global profiles for the same model ID.

DeepSeek's built-in profiles use `none`, `low`, `high`, and `max`. The adapter
retains assistant `reasoning_content` for tool-call continuation and removes it
when sending history to a model using another dialect. Retained reasoning is
included in context estimates. These requirements follow the
[DeepSeek thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/).
OpenAI effort levels differ by model; see the
[OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2).

Tests use simulated provider streams to check the outgoing parameters,
tool-call continuation, model switching and invalid selections. They do not
spend provider credits or validate live model quality.
