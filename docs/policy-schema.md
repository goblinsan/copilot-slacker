# Policy Schema

Policies define routing, approvers, personas, and timeouts per action.

## File Location
`.agent/policies/guards.yml`

## Top-Level Keys
| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `actions` | map | yes | Map of action name → action policy |
| `routing` | object | no | Default routing rules |
| `defaults` | object | no | Default fallback behavior |

## Action Policy Schema
```yaml
actions:
  <action_name>:
    approvers:
      allowSlackIds: ["U123", "U456"]  # OR
      allowHandles: ["alice", "bob"]   # optional (GitHub handles -> Slack mapping)
      minApprovals: 1
    personasRequired: ["QA", "Architect"] # optional
    timeoutSec: 900                        # default if omitted: routing.defaultTimeoutSec or global default
    redactParams:                          # optional, choose one strategy
      mode: allowlist                      # allowlist | denylist | all
      keys: ["packages", "script", "path"]
    channel: "CXXXX"                      # optional per-action override
    escalation:
      afterSec: 600                        # when to ping fallback
      fallbackUser: "U999"                # overrides routing.dmFallbackUser
    allowReRequest: true                   # default true
    reRequestCooldownSec: 600              # optional
    description: "Install npm dependency"
```

## Routing Schema
```yaml
routing:
  defaultChannel: "CDefaultPrivate"
  dmFallbackUser: "U123"
  defaultTimeoutSec: 600
```

## Defaults
```yaml
defaults:
  unknownAction: deny   # or manual (post but require explicit approve from super-approvers)
  superApprovers: ["UADMIN1", "UADMIN2"]
```

## Redaction Behavior
| mode | Behavior |
|------|----------|
| `allowlist` | Only listed keys displayed in Slack message; others replaced with `«redacted»` |
| `denylist` | All keys shown except those listed |
| `all` | All keys shown (discouraged for secret-bearing actions) |

## Persona Mapping
Persona names are free-form strings (`QA`, `Architect`, `Security`, `Reviewer`). A separate runtime command (`/persona-bind QA @qa-bot`) associates Slack bot user IDs with persona roles. Bindings persisted in store (not in YAML) enabling dynamic reassignment.

## Validation Rules
* `minApprovals >= 1`.
* Each action must define either `allowSlackIds` or `allowHandles` (resolved at runtime) unless covered by `defaults.superApprovers`.
* `timeoutSec` must be >= 60 and <= 86400 (1 day) unless specifically flagged with env override.
* Redaction: if both `allowlist` and `denylist` specified returns validation error.

## Example Policy File
See `./.agent/policies/guards.yml` in repository root for a comprehensive example.
