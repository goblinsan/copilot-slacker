# Production Readiness Checklist

Last Updated: 2025-09-20

## 1. SLOs
| Dimension | Target | Notes |
|-----------|--------|-------|
| Availability | 99.5% initial | Single region, Redis HA pending |
| Decision Latency (internal processing) | P95 < 250ms | Excludes human wait & Slack network time |
| Request Creation Latency | P95 < 120ms | In-memory baseline <10ms; includes network overhead |
| Error Rate | < 1% 5xx over 5m | Alert threshold before paging |

## 2. Security Controls
- Slack signature verification (timestamp skew ±300s; replay cache).
- Rate limiting (token bucket per IP on create endpoint).
- Optional mTLS (client cert enforcement env flag).
- Override governance (key count & diff size limits) + schema validation.
- Audit log with policy & payload hashes for tamper correlation.

## 3. Secrets & Config
| Secret | Rotation Policy | Storage |
|--------|-----------------|---------|
| SLACK_SIGNING_SECRET | 90 days | Secret Manager / K8s Secret |
| SLACK_BOT_TOKEN | 90 days | Secret Manager / K8s Secret |
| ADMIN_TOKEN | 180 days | Secret Manager / K8s Secret |

## 4. Data Durability
| Data | Persistence | Recovery Path |
|------|-------------|---------------|
| Active Requests | Redis (planned) / memory (dev) | Redis snapshot / failover |
| Audit Events | Stdout (ship via log pipeline) | Central log store search |
| Archived Requests | JSONL archive dir | Re-import script (future) |

## 5. Backup & DR
- Redis: Enable snapshot (RDB) every 5m + AOF append if HA.
- Archive directory: Sync to object storage daily.
- DR Test: Restore Redis snapshot into staging & replay subset of archives (validate query endpoints).

## 6. Observability
| Area | Implemented | Further Action |
|------|-------------|---------------|
| Metrics | Counters, histogram, gauges | Add Slack 429 metrics (#49) |
| Tracing | OTEL spans; OTLP option | Expand Slack API span attrs |
| Logging | JSON audit + stdout logs | Central ingestion & retention policy |

## 7. Performance Baseline
From load harness (item #13) – local in-memory: create P95 ≈8–9ms, approval op P95 <0.2ms, end-to-end P95 ≈9–10ms. Document as internal baseline; re-run after major changes.

## 8. Readiness Gates (Pre Go-Live)
| Gate | Status | Evidence |
|------|--------|----------|
| All critical backlog items complete | Pending | Items 1–17 done (excluding future enhancements) |
| No HIGH/CRITICAL vulns (image scan) | Pending | Trivy CI gating (non-block yet) |
| Runbook approved | Done | docs/runbook.md v1 |
| DR restore test executed | Pending | Need Redis HA env |
| Dashboard published | Pending | Grafana board ID TBD |
| Alert rules deployed | Partial | To finalize after Slack 429 metrics |

## 9. Risk Register (Top 5)
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Redis outage | M | H | HA cluster, reconnect logic |
| Slack prolonged outage | M | M | Queue & defer approvals, comms plan |
| Policy misconfiguration | M | M | Pre-merge validation, staging reload test |
| Supply chain compromise | L | H | Planned signing & provenance (#44-45) |
| Latency regression (scaling) | M | M | Load test per release + tracing analysis |

## 10. Open Actions
| ID | Action | Owner | Target |
|----|--------|-------|--------|
| A1 | Enable multi-arch & distroless builds (#42,#43) | Platform | Q4 | 
| A2 | Add SBOM + signing (#44,#45) | Platform | Q4 |
| A3 | Implement Slack 429 metrics (#49) | Dev | Q3 |
| A4 | DR restore rehearsal | SRE | After Redis HA |
| A5 | Dashboard & alert finalization | SRE | Pre GA |

## 11. Go / No-Go Checklist
All PASS required:
- [ ] CI green (lint, typecheck, tests, scan)
- [ ] No HIGH/CRITICAL vulnerabilities (ignore-unfixed=false)
- [ ] Redis failover test passed in staging
- [ ] Latency SLO met (p95 decision latency <250ms internal)
- [ ] Backup & restore rehearsal documented
- [ ] Alerts firing correctly in simulated scenarios (latency, error rate)
- [ ] Runbook updated within last 30 days

## 12. Defer / Waiver Log
| Item | Rationale | Expiry |
|------|-----------|--------|
| Distroless image | Validate compatibility first | 2025-10-31 |
| Image signing | Pending SBOM foundation | 2025-11-30 |

## 13. Versioning & Release
- Semantic tags `vMAJOR.MINOR.PATCH` trigger image publish.
- Add CHANGELOG (future) with categorized entries (feat/fix/chore/security).

## 14. Future Measurement Enhancements
- Synthetic approval latency probe (inject test request & auto-approve).
- End-to-end Slack roundtrip metric (create → message posted).
- Export structured decision latency percentiles to external TSDB.

---
Iterate this file as controls mature; link from governance portal when established.
