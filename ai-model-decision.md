# AI model decision — what's actually running, and why

This documents the model choice, and the justification for it. The deeper research behind the original decision lives in `self-hosted-llm-rag-aws.md` — this doc is the shorter "what we picked and why" record, not a replacement for that report.

## What's in the code today (2026-09-08 — co-located on one instance, pending deploy)

| Role | Model | Serving | Config |
|---|---|---|---|
| Embedding | `Qwen/Qwen3-Embedding-4B` | vLLM, port 8000 | `--dtype auto` (bf16), `--max-model-len 4096`, `--gpu-memory-utilization 0.3`, Matryoshka output forced to 1024 dims via `--hf-overrides` |
| Generation ("Ask" answers) | `Qwen/Qwen3-4B` | vLLM, port 8001 | `--dtype auto` (bf16), `--max-model-len 8192`, `--gpu-memory-utilization 0.55` |

Both processes now run **inside one container, on one shared EC2 instance** (`GpuService`/`GpuTaskDefinition` in `edd-workbench-stack.ts`) — a change from the original design (see "Consolidation" below), which ran each on its own dedicated `g6.xlarge`. Still `eu-west-2` (London), still on the 9am–18:00 UK Mon–Fri schedule, still not per-request scale-to-zero. No reranking step is deployed (the original proposal recommended one — see "Known gaps" below).

**This is implemented in code but not yet deployed to staging or evaluated against real documents** — see "Consolidation" below for the risk this accepts and what's still outstanding before it should be trusted in production.

The previous, still-relevant caveat about live infra drift: the *original* generation service's code only ever declared 1 instance, but live infra was separately found drifted to a larger footprint (`MaxSize: 10`, desired count 2) during an unrelated outage investigation on 2026-09-08 — worth confirming this drift doesn't resurface once the new consolidated `GpuService` actually deploys and replaces the old drifted resources outright.

## Why self-hosted, not a hosted API

The documents this system processes are privileged, confidential legal material. The requirement is control over **where processing happens**, not just a vendor's retention-policy promise — a retention policy is a statement about what happens to data *after* processing, not a guarantee about which infrastructure touched it or who could access it in principle. Self-hosting inside our own AWS account, in `eu-west-2`, removes that question entirely: model weights, embeddings, vector index, and retrieved document text never leave infrastructure we control. This ruled out Anthropic/OpenAI/Google's own APIs, and third-party inference hosts (Together AI, Fireworks, Groq) outright, regardless of their stated data-handling policies.

## Why Qwen3-8B / Qwen3-Embedding-8B specifically

- **Sized to the actual workload, not a generic benchmark.** Each matter is capped at ≤5GB / ≤7,500 documents (~15,000–40,000 chunks). At that scale, a well-retrieved handful of relevant chunks does most of the real work — the generation model's job is mostly synthesis and citation-faithful writing over already-narrowed context, not open-ended reasoning over a sprawling corpus. Independent benchmarks favoring larger models (DeepSeek-R1, Qwen3-235B) were measuring exactly that different, harder profile.
- **Fits one GPU with real headroom, not just on paper.** An earlier draft of the underlying research put a 32B-class model on a single L40S based on weight size alone, and was wrong: real concurrent-request KV cache and framework overhead consume VRAM that weight-size math misses entirely — a 27B-class model failed to even start on a 48GB card under realistic concurrency in published testing. Qwen3-8B leaves real headroom for KV cache and (eventually) a co-located reranker on one `g6.xlarge`'s 24GB; this was confirmed operationally, not just estimated — the deployed embedding config needs ~14.7GB VRAM (14.11GB bf16 weights + KV cache), already most of a T4's 16GB, which is exactly why a T4-class instance (`g4dn.xlarge`) was separately ruled out for this workload during a later cost review.
- **Open license, strong open-weight benchmark standing.** Qwen3-Embedding-8B tops open-weight MTEB multilingual (~70.6); both models are Apache 2.0.
- **Cheapest instance that reliably fits the job.** `g6.xlarge` (1× NVIDIA L4) was the smallest/cheapest GPU instance the model comfortably fits on with concurrency headroom; a later GPU-instance cost review (2026-09-08) independently confirmed there's no cheaper on-demand 24GB-class instance in `eu-west-2` — `g5.xlarge` (A10G) costs *more* than `g6.xlarge` for the same VRAM, and cheaper T4-class options (`g4dn.xlarge`, fractional `g6f.*`) don't have enough VRAM for this model.

## Alternatives considered

### Self-hosted, same pattern (in-account, in-region, vLLM on EC2)

| Option | Verdict |
|---|---|
| **Qwen3-14B** | Documented fallback if real eval shows 8B's answer quality insufficient — still fits one `g6.xlarge` alongside embedding. Not yet needed; no eval has flagged a quality gap. |
| **Qwen3-32B and up** | Explicitly deferred — needs a second GPU (real cost step), and nothing at current scale has shown a need for it. |
| **DeepSeek-R1 distills (7B/8B/14B Qwen/Llama-based)** | Same size class and VRAM profile as current choice, open license (Apache/MIT-style). A real alternative to benchmark, not evaluated in depth yet — no evidence the current model is underperforming. Full DeepSeek-R1 (671B) is far too large for this instance tier. |
| **BGE-reranker-v2-m3 / Qwen3-Reranker-4B** | Recommended in the original proposal as a second retrieval-quality lever (up to 67% fewer failed retrievals in published testing) — **not yet implemented**. See "Known gaps." |

### AWS Bedrock (managed, but still AWS's own regional infrastructure)

Checked live against Bedrock's model catalog for `eu-west-2` (2026-09-08) — a real, current alternative category distinct from "third-party API," since Bedrock-hosted inference runs within AWS's own infrastructure and region, not a model provider's own datacenters. Available in `eu-west-2` today: Anthropic Claude (Haiku/Sonnet/Opus, several generations), Amazon Nova, DeepSeek V3.1/V3.2, Meta Llama 3, Mistral (several sizes), Qwen3 (32B, 235B, coder variants), Cohere/Titan/Amazon embeddings, and others.

Trade-off versus the current self-hosted setup: no instance/ASG/cold-start to operate, pay-per-token instead of scheduled instance-hours — but loses direct control of the serving stack and the "runs on hardware we provision" posture, and per-token pricing at this product's real usage pattern hasn't been compared against the current ~$600–700/mo GPU compute run-rate. **Not adopted, not ruled out** — a legitimate option to cost/quality-compare later, unlike the third-party APIs below.

One specific, already-answered sub-question: **DeepSeek-R1 is not available in `eu-west-2`** on Bedrock (only V3.1/V3.2 are) — R1 exists only in `us-east-1` and only via a cross-region inference profile, which would mean this app's document content leaving the UK region. Checked directly against the API, not assumed.

### Third-party hosted APIs — ruled out

Anthropic/OpenAI/Google direct APIs, and inference resellers (Together AI, Fireworks, Groq): explicitly ruled out per "Why self-hosted" above. Even providers with genuine zero-data-retention options (Fireworks: SOC 2 Type II + HIPAA + ZDR; Groq: account-wide ZDR) don't address *where* processing happens, which is the actual requirement for privileged legal material.

## Known gaps / deviations from the original proposal

- **No reranking step is deployed.** The original research recommended BGE-reranker-v2-m3 or Qwen3-Reranker-4B as a second retrieval-quality pass. Retrieval currently goes straight from vector similarity search to the generation model.
- **Vector store is pgvector on the existing RDS Postgres instance**, not a new Aurora Serverless v2 cluster as originally proposed — simpler, and RDS PG16 already supports the extension natively. Deliberate simplification, not an oversight.
- **No formal eval harness confirmed** against real document corpora — the original report's caveat still applies: self-hosting and model choice don't eliminate hallucination on their own; retrieval/prompting architecture is what separates grounded legal QA from raw-LLM QA in published testing (17–33% vs. 43–88% hallucination, Stanford). Real evaluation against this product's own documents hasn't been budgeted yet.

## Investigation: smaller models, same ≤7,500-doc/matter scale (2026-09-08)

Checked whether the Qwen3 family's own smaller siblings could replace the current 8B models without changing the scale requirement. Real numbers, not spec-sheet guesses:

| Model | Params | bf16 weights | MTEB multilingual | Notes |
|---|---|---|---|---|
| Qwen3-Embedding-**0.6B** | 0.6B | ~1.2GB | 64.33 | Native output dim is **1024** — exactly matches this app's fixed `vector(1024)` column (`026_embeddings.sql:33`). No Matryoshka truncation hack needed at all (today's 8B setup requires `--hf-overrides` to force its native 4096 dims down to 1024). Genuinely drop-in at the schema level. ~8.8% relative quality drop vs. current. |
| Qwen3-Embedding-**4B** | 4B | ~5.1GB | 69.45 | Native dim 2560 — would still need the same Matryoshka-truncation-to-1024 trick already in use today. Only ~1.6% relative quality drop vs. current 8B (70.58) — the much safer middle ground. |
| Qwen3-**4B** (generation) | 4B | ~8GB | — (no MTEB; generation quality has no equivalent standard benchmark for this use case) | Half the weight footprint of current Qwen3-8B. Chunk size is fixed at 1200 chars (`chunking.ts:1`), nowhere near either model's context window — not a constraint either way. |

**The real lever isn't VRAM headroom on one model, it's whether both models could share one GPU instance.** Today embedding and generation run on two separate `g6.xlarge` instances because Qwen3-Embedding-8B (~14.11GB weights, confirmed from real vLLM startup logs) and Qwen3-8B (~16GB weights) don't both fit one 24GB card with usable KV-cache headroom. Qwen3-Embedding-4B (~5.1GB) + Qwen3-4B (~8GB) together are ~13.1GB — comfortably fits one `g6.xlarge` with ~11GB left over for concurrent-request KV cache across both models. That's a real path to **collapsing two scheduled GPU instances into one**, which is the dominant cost effect here (roughly halving GPU compute cost), not the marginal saving from a smaller instance type.

Every number above is a spec-sheet/generic-benchmark fact, not a measurement of answer quality against this product's actual eDiscovery documents — the eval-harness gap already flagged above. **Explicitly acknowledged and accepted, not overlooked**, before proceeding to implement it (2026-09-08 decision, user-confirmed).

## Consolidation: implemented and confirmed working (2026-09-08/09)

`edd-workbench-stack.ts`'s `GpuService`/`GpuTaskDefinition` now run both models as sibling processes inside **one container on one shared `g6.xlarge` instance**, replacing what used to be two entirely separate instances/services (`EmbeddingService` + `GenerationService`). Final config: **Qwen3-Embedding-0.6B** (not 4B — see below) + **Qwen3-4B**. This took three real deploy failures to get right; each is real, transferable learning, not noise:

- **AWS ECS treats GPU as an exclusive per-container resource.** Two containers each declaring `gpuCount: 1` cannot both be placed on a single-GPU instance — ECS sums the requirement across a task/instance and refuses to place if it exceeds what's available. The only way to genuinely share one physical GPU between two model servers under ECS's placement model is one container running both as sibling processes (via a shell `entryPoint` override), with only one `gpuCount: 1` declared for the whole task. Verified in the synthesized CloudFormation template — one container, `ResourceRequirements: [{Type: GPU, Value: "1"}]`.
- **Failure 1 — wrong shell.** `wait -n` (needed so the task restarts if either model process dies) is a bash-only flag; the image's default `/bin/sh` is POSIX-minimal and rejects it (`sh: 1: wait: Illegal option -n`), crash-looping the task immediately. Fixed: `entryPoint: ["bash", "-c"]` instead of `sh`.
- **Failure 2 — wrong weight-size estimate.** Qwen3-Embedding-4B and Qwen3-4B loaded at an *identical* 7.56 GiB each — same underlying 4B dense architecture, the embedding variant isn't meaningfully smaller. The original ~5.1GiB estimate (scaled from MTEB embedding-dimension differences, not actual parameter count) was wrong. Combined weights alone (~15.1GiB) plus CUDA graph capture left both engines deeply negative on available KV cache memory. Fixed: swapped to **Qwen3-Embedding-0.6B** (confirmed ~1.2GiB weights) — its native output dimension is already 1024, exactly matching `document_chunks.embedding`'s `vector(1024)` column (migration 026), so no schema change needed.
- **Failure 3 — the real root cause, and the one worth remembering.** Even after shrinking the embedding model, startup still failed the same way — the *smaller* model's engine reported deeply negative available KV cache despite its own usage being a fraction of its budgeted `--gpu-memory-utilization`. The actual bug: each vLLM process profiles **real, current free VRAM** at startup, not a private reserved slice — launching both engines concurrently means each one's memory-profiling step races the other's still-growing weight-loading footprint, and whichever profiles second sees a card already eaten into by its sibling, regardless of either process's own utilization fraction. There's no flag that reserves a private VRAM slice per process on one GPU; the fix is sequencing, not tuning. Fixed: the container's shell command now starts embedding, blocks in a loop polling its `/health` endpoint via `python3` (curl isn't guaranteed present, python3 always is) until it responds, and only then starts generation. Once sequenced, the originally-planned generous fractions (`--gpu-memory-utilization 0.3` / `0.6`) work fine — both engines now report **positive** available KV cache (4.77 GiB / 3.5 GiB), confirmed via real vLLM startup logs, and the task has run stable since.
- One shared Cloud Map DNS name (`gpu.edd-workbench.internal`) now serves both — port 8000 (embedding) and port 8001 (generation) — instead of two separate hostnames. One shared EventBridge schedule pair instead of two (both models already ran the identical 9am–18:00 UK window regardless).
- System RAM (distinct from VRAM) turned out fine at `g6.xlarge`'s default 16GB once the embedding model shrank to 0.6B — not a bottleneck in practice, contrary to the risk flagged during implementation.

**User-confirmed working in staging (2026-09-09).** Answer-quality validation against real documents is still the one open item — see "Known gaps" above; MTEB numbers and weight sizes here are hardware/serving facts, not a substitute for that eval.

**Status: implemented and typechecked/tested locally (332 tests pass, `cdk synth`/`cdk diff` clean), not yet deployed to staging, not yet validated for either (a) real system-RAM fit under two co-resident processes or (b) real answer-quality impact from the model downgrade.** Both need confirming via an actual staging deploy and manual testing before this should be considered production-ready — this is a genuine experiment, not a proven change.
