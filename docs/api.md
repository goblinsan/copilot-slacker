---
title: Approval Service API Spec
version: 0.1.0
---

## Overview

OpenAPI 3.1 specification for Approval Service endpoints supporting guarded action requests, waiting for decisions, and Slack interaction handling.

## OpenAPI (YAML)

```yaml
openapi: 3.1.0
info:
  title: Approval Service API
  version: 0.1.0
  description: Slack-mediated approval gating for agent actions.
servers:
  - url: https://approval.example.com
paths:
  /api/guard/request:
    post:
      summary: Create guarded action request
      operationId: createRequest
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateRequestInput'
      responses:
        '200':
          description: Request accepted
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CreateRequestResponse'
        '400': { description: Invalid payload }
        '403': { description: Policy denies action }
  /api/guard/wait:
    get:
      summary: Wait (SSE) for decision
      operationId: waitRequestSSE
      parameters:
        - in: query
          name: token
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Stream events (text/event-stream)
    post:
      summary: Poll for decision (non-SSE)
      operationId: waitRequestPoll
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/WaitRequestInput'
      responses:
        '200':
          description: Terminal or pending state
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WaitRequestResponse'
        '404': { description: Token not found }
  /api/slack/interactions:
    post:
      summary: Slack interactive component handler
      operationId: slackInteractions
      security: []  # Slack signature header required instead
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              properties:
                payload:
                  type: string
                  description: JSON string of Slack interaction
      responses:
        '200': { description: Ack }
        '400': { description: Invalid signature or payload }
  /healthz:
    get:
      summary: Liveness probe
      responses:
        '200': { description: OK }
components:
  schemas:
    CreateRequestInput:
      type: object
      required: [action, params, meta]
      properties:
        action: { type: string, minLength: 1 }
        params:
          type: object
          description: Arbitrary parameters (will be redacted per policy)
        meta:
          type: object
          required: [origin, requester, justification]
          properties:
            origin:
              type: object
              required: [repo]
              properties:
                repo: { type: string }
                branch: { type: string }
                pr: { type: string }
                run_id: { type: string }
            requester:
              type: object
              required: [id, source]
              properties:
                id: { type: string }
                source: { type: string, enum: [slack, github, agent] }
                display: { type: string }
            justification: { type: string, minLength: 3 }
            links:
              type: array
              items:
                type: object
                properties:
                  label: { type: string }
                  url: { type: string, format: uri }
        policyHints:
          type: object
          description: Optional hints (e.g., channel override)
    CreateRequestResponse:
      type: object
      required: [token, requestId, status]
      properties:
        token: { type: string }
        requestId: { type: string }
        status: { type: string, enum: [pending, awaiting_personas, ready_for_approval] }
        expiresAt: { type: string, format: date-time }
        policy:
          type: object
          properties:
            minApprovals: { type: integer }
            requiredPersonas: { type: array, items: { type: string } }
            timeoutSec: { type: integer }
    WaitRequestInput:
      type: object
      required: [token]
      properties:
        token: { type: string }
    WaitRequestResponse:
      type: object
      required: [status]
      properties:
        status:
          type: string
          enum: [pending, awaiting_personas, ready_for_approval, approved, denied, expired]
        approvers:
          type: array
          items: { type: string }
        decisionParams:
          type: object
        reason: { type: string }
        decidedAt: { type: string, format: date-time }
    SlackInteractionPayload:
      type: object
      description: Parsed `payload` JSON from Slack
      properties:
        type: { type: string }
        user:
          type: object
          properties:
            id: { type: string }
        actions:
          type: array
          items:
            type: object
            properties:
              action_id: { type: string }
              value: { type: string }
        container:
          type: object
          properties:
            channel_id: { type: string }
            message_ts: { type: string }
        api_app_id: { type: string }
        token: { type: string }
        response_url: { type: string }
    ErrorResponse:
      type: object
      properties:
        error: { type: string }
        code: { type: string }
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
security:
  - bearerAuth: []
```

## Event Stream (SSE)

`GET /api/guard/wait?token=...` returns `text/event-stream` with events:

```
event: state
data: {"status":"pending"}

event: state
data: {"status":"approved","approvers":["U123"],"decisionParams":{}}
```

Terminal statuses: `approved`, `denied`, `expired` end the stream.

## Error Codes

| Code | Meaning |
|------|---------|
| `POLICY_NOT_FOUND` | Action not defined and default deny enabled |
| `NOT_AUTHORIZED` | Requester not authorized for action (if pre-validation needed) |
| `INVALID_STATE` | Interaction tries illegal state transition |
| `TOKEN_NOT_FOUND` | Wait on unknown token |
| `TOKEN_EXPIRED` | Token expired before decision |

## Interaction Actions
| action_id | Description |
|-----------|-------------|
| `approve` | Approve request |
| `deny` | Deny request |
| `more_info` | (Future) open modal / ephemeral message |
| `persona_ack` | Checkbox persona co-sign update |
| `re_request` | Create new pending request referencing lineage |

## Security Headers
* `Authorization: Bearer <token>` for agent-origin API calls (optional if internal network and mTLS used).
* Slack: verify `X-Slack-Signature`, `X-Slack-Request-Timestamp`.

## Rate Limiting
Recommend bucket: 60 create requests / minute / org; 5 re-requests / hour / lineage.
