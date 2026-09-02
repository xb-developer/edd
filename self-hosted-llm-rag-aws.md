# Self-hosted LLM + RAG, entirely within your own AWS environment

*EDD Cloud Platform — Self-Hosted LLM & RAG on AWS. Researched August 2026, revised to your actual scale: each matter capped at 5GB / ~7,500 documents. Scoped to your stated constraint: the web app runs in your own AWS account, so this covers only open-weight models you run yourself, plus the serving, retrieval, and storage layers around them — no hosted third-party APIs (Anthropic/OpenAI/Google) in this version.*

## What the scale actually changes

7,500 documents at typical eDisclosure mix (many short emails, some large PDFs) is maybe 50–200MB of *extracted text* per matter — the 5GB is dominated by binary bytes (images, Office containers) that never reach the embedding step. At ~3,000 characters/chunk, that's roughly **15,000–40,000 chunks per matter**. This is small enough that vector-store scale, GPU tier for the "hardest" model, and enterprise-grade retrieval infrastructure all stop being real design questions — a single modest GPU instance and a plain Postgres table comfortably clear this bar with room to spare. The design questions that *do* still matter are concurrent load across many matters/users at once, and retrieval *quality* (not scale) within each small, well-scoped corpus.

## RAG architecture — and how matter isolation is enforced

Worth stating explicitly: yes, this is a full RAG pipeline, not just "an LLM sitting behind an API" — and matter isolation isn't a nice-to-have layered on afterward, it's the mechanism that makes the whole thing safe to point at privileged legal material at all. Two flows, both scoped to a single matter at every step.

| Step | What happens |
|---|---|
| **Ingest** | Document → text extraction/OCR → chunking → **Qwen3-Embedding** → stored in pgvector as `(matter_id, document_id, chunk_id, embedding, text)`. Every chunk is permanently tagged with the matter it came from at write time. |
| **Ask** | User's question (server derives `matter_id` from the currently-open matter in their authenticated session — never trusted from client input) → embed the question → similarity search **WHERE matter_id = $current_matter** → top-k reranked → grounded prompt built *only* from those matter-scoped chunks → generation model answers, citing the specific documents it drew from. |

The isolation boundary is the `WHERE matter_id = $1` clause on the *same* query that does the vector similarity search — not a filter applied afterward, and not something the embedding step provides on its own. A nearest-neighbour search has no inherent concept of "matter"; left unconstrained, it will happily return the closest vector in the whole table regardless of which matter it came from. Pair the `matter_id` column with a composite index — `(matter_id, embedding)` — so the filter and the similarity search run together efficiently rather than one narrowing after the other scans everything.

Two things worth building in as genuine defense-in-depth, not just "the application code happens to be correct": **Postgres Row-Level Security (RLS)** policies tying every query to the session's authorized matter at the database layer, so a bug in application code that forgets the filter is still blocked by the database itself rather than silently returning a cross-matter result; and server-side validation that the authenticated user actually has permission to the requested matter_id before running anything — never take matter_id as a bare client-supplied parameter and trust it, since that's exactly the kind of mistake that turns into a real conflict-of-interest breach on a multi-tenant legal platform.

One more point worth being explicit about: because this is RAG rather than a model fine-tuned on your documents, the generation model has no route to a matter's data except through whatever retrieval hands it in the prompt for that one request — it holds no memory of any matter between calls. So correct retrieval scoping isn't *a* safeguard against cross-matter leakage, it's the *entire* safeguard: get the `WHERE matter_id` clause right and the model is architecturally incapable of answering from another matter's documents, because it was never given them. Worth a standing automated test regardless — ask a question in matter A that only matches content actually stored in matter B, and assert the answer and its citations never reference matter B.

## Recommended stack — right-sized for a small offering, not an enterprise one

Previous versions of this report sized for redundancy and headroom that make sense at real production scale but are overkill — and over-budget — for a small offering finding its feet. Settled default: **one** GPU instance, not two; **one** model, not a tiered escalation path; and **scheduled warm hours, not reactive scale-to-zero** — since the interactive "Ask" path shares that one instance with document embedding, and cold-start latency is only acceptable on the background import side, the simplest correct policy is to keep the shared instance warm on a fixed business-hours schedule (see "Warm, on a schedule" below) rather than let it cool down between requests during the day. **Qwen3-8B or Qwen3-14B** (pilot both) sharing a single small GPU instance with the embedding and reranking models, served by **vLLM**. Retrieval on **Aurora Serverless v2 + pgvector**, which still scales its own cost down independently outside those hours. See the cost model below for exactly what this runs.

> **Correction from an earlier version — VRAM fit under real concurrency.** Earlier sizing put Qwen3-32B on "one L40S (48GB), comfortably" based on model-weight size alone. Real deployment benchmarks tell a different story: a 27B-class model — smaller than Qwen3-32B — **failed to even start** on a single L40S at FP8, because model weights are only part of the VRAM budget; KV cache (which grows with concurrent requests × context length) and framework/CUDA-graph overhead eat the rest, and at any real concurrency they eat a lot. A single-GPU "does it fit" check is the wrong test for a multi-user service — the right question is "does it fit *at your realistic concurrency*," which is why Qwen3-8B/14B (a fraction of the weight footprint, with real headroom left for KV cache plus the co-located embedding/reranker models) are the sensible small-scale defaults, and why anything at 32B and above needs a second GPU rather than squeezing onto one card.

## Generation model — sized to a ≤5GB / ≤7,500-document matter

The independent testing that put DeepSeek-R1 and Qwen3-235B-A22B ahead on legal-document analysis was measuring reasoning over large, sprawling corpora and long multi-step chains — not the profile of a single, capped-size matter with a well-retrieved handful of relevant chunks in front of the model. At your scale, retrieval quality (good chunking, embeddings, reranking) does most of the real work; the generator's job is mostly synthesis and citation-faithful writing over context that's already been narrowed down for it. A mid-size dense model is very likely enough, and is what's recommended below as the default rather than a compromise.

| Model | Size | VRAM (Q4) | Min. viable instance | Notes |
|---|---|---|---|---|
| **Qwen3-8B** | 8B dense | ~5GB weights | g6.xlarge | **Start here** — cheapest, leaves the most VRAM headroom for KV cache + the co-located embedding/reranker models on one card |
| **Qwen3-14B** | 14B dense | ~9GB weights | g6.xlarge | Fallback if 8B's answer quality doesn't hold up in eval — still comfortably fits alongside embed+rerank on one L4 |
| *Qwen3-32B and up* | 32B–671B | 20GB–400GB+ | 2nd GPU or larger instance | Treat as a later-stage upgrade path, not part of the initial build — the jump from a single small GPU to multi-GPU is a real cost step, and a small-scale offering over a ≤7,500-doc matter is unlikely to need it. Revisit only if a real eval on your own documents shows 8B/14B genuinely falling short. |

VRAM figures are for 4-bit quantization; full fp16 roughly doubles them. Always validate quality loss from quantization against your own eval set before committing to Q4 in production — for legal work, run at least a Q8 or fp16 comparison pass first.

## AWS GPU instances

| Instance | GPU | VRAM | On-demand | ≈Monthly (24/7) |
|---|---|---|---|---|
| g6.xlarge | 1× L4 (4 vCPU, 16GB RAM) | 22GB | $0.98/hr | ~$714 |
| g6e.xlarge | 1× L40S (4 vCPU, 32GB RAM) | 45GB | $1.86/hr | ~$1,359 |
| g6e.12xlarge | 4× L40S, TP=4 | 180GB | $10.49/hr | ~$7,660 |
| inf2.xlarge | Inferentia2 | 32GB | $0.76/hr | ~$554 |
| p4d.24xlarge | 8× A100 | 320GB | $32.77/hr | ~$23,900 |
| p5.48xlarge | 8× H100 | 640GB | $98.32/hr | ~$71,750 |

us-east-1 on-demand rates. The p4d/p5 rows are included for completeness — given your per-matter scale, you're very unlikely to need them; the g6/g6e tier is the realistic range to plan around. Reserved Instances/Savings Plans cut these materially for anything running 24/7; Inferentia2 is worth a pilot for supported architectures (narrower model support, needs Neuron SDK compilation — more DevOps lift for the discount).

## Cost model for a small offering — 10 matters, 20 users concurrent

The previous version of this report priced redundancy (two generation replicas) and a fixed "business hours" block (paying for 12 hours of standing capacity whether or not it's actually being used) — both reasonable choices for a service with real uptime commitments, both wrong for a small offering watching its budget. This version prices what a lean v1 actually needs: one instance, one model, and billing that tracks real usage rather than a block of assumed-busy hours.

### What actually needs the GPU — importing documents is not the only thing that does

Worth being precise about this, since it changes what "idle" really means. Embeddings are a one-time cost per document: computed once at import, stored permanently in pgvector, never recomputed to answer a later question. But **asking a question is a separate operation that also needs the GPU, every single time** — there's no way to pre-compute an answer to a question nobody has asked yet. The "Ask" flow is: embed the incoming question (GPU, embedding model, cheap and fast) → similarity search against stored vectors (Postgres/pgvector, *not* GPU at all) → rerank the top candidates (GPU, reranker model, cheap and fast) → generate the actual grounded answer from the retrieved chunks (GPU, the generation model — the slow, expensive step, and the one that can't be skipped or cached across different questions). So a cold GPU node affects both paths: a bulk document import kicked off after a quiet period cold-starts exactly like a user asking the first question of the morning does. The two differ mainly in how much the delay matters — a background import queuing for an extra 3 minutes is invisible to anyone; a person waiting on an answer feels every second of it. That asymmetry is worth factoring into your cooldown setting: it's fine for the import path to tolerate a cold start, less fine for the interactive one.

### Cold start and idle-gap, precisely

"Idle gap" is not something AWS decides — it's a threshold *you* configure (KEDA's cooldown period: how long the system waits with no incoming requests before it actually tears the GPU node down). This is a real dial with a real tradeoff, not a fixed fact to look up, and it matters because there are two different things people call "scale to zero" that cost very differently:

| Scale-to-zero mode | What actually happens | Cold-start time | Saves money? |
|---|---|---|---|
| Pod scales to zero, node stays up | vLLM process stops, EC2 instance keeps running | ~30–60s | **No** — you're still paying the instance-hour |
| Node itself deprovisions (Karpenter) | EC2 instance actually terminates | Naive: 3–6 min · Optimized: ~60–90s | **Yes** — this is the one that actually stops the bill |

The real, money-saving cold start (full node deprovision → reprovision) breaks down as: **node provisioning** (60–120s: AWS API call + instance boot + GPU driver init) + **container image pull** (naive: 4–8 min for a full CUDA/PyTorch/vLLM image if pulled fresh from a registry each time — this is the single biggest lever; optimized: near-zero if the image is baked into a custom AMI instead) + **model weight load** (naive: 60–180s downloading from S3/HF Hub, scales with model size — an 8B model is much faster here than the 70B figures usually quoted; optimized: seconds, if weights are already on an attached EBS volume/snapshot rather than re-downloaded) + **vLLM startup / CUDA graph capture** (~15s on an A10-class GPU, ~40s on an L4, per published vLLM startup benchmarks). Add it up: a **naive setup realistically costs you 3–6 minutes** per cold start for an 8B model; the **same setup with a pre-baked AMI (image + weights already on disk) realistically costs ~60–90 seconds** — that AMI work is genuine engineering effort, but it's a one-time build, not ongoing maintenance, and it's the single highest-leverage thing you can do to make the Lean tier's UX acceptable.

### What "idle gap" actually costs you — the billed-minutes math

Because the node stays billed for the whole cooldown wait (not just the cold start), the real unit to reason about is a **"session"**: cold start, then however long users keep sending requests close enough together to keep the node warm, then the cooldown tail before it actually shuts down. A 5–10 minute cooldown is the sensible default — shorter doesn't really save money (you're just trading cooldown-tail minutes for cold-start minutes of similar size, while making cold starts *more frequent* and more annoying), longer means paying for more genuinely idle time before shutdown.

Worked example at a 7-minute cooldown, ~3 min average cold start: if the day's usage clusters into **~8–12 distinct sessions** (gaps in usage longer than 7 minutes — a lunch break, a gap between users, end of day) with ~8–15 minutes of real intermittent activity per session, billed time per session ≈ 3 (cold start) + 10 (activity) + 7 (cooldown tail) ≈ 20 minutes. Ten sessions/day × 20 min × ~22 working days/month ≈ **73 hours/month** — which is where the Lean tier's $65–90 compute figure actually comes from, not a hand-waved "2–3 hours/day." If your real session count or cooldown setting differs, the same arithmetic (sessions/day × (cold-start + activity + cooldown) minutes × working days) re-derives the number — worth building as a small spreadsheet once you have any real usage to plug in, rather than trusting this example's assumed session count.

### Three tiers — and which one the "keep Ask warm" decision actually picks

Because the Ask path and the import/embedding path share one instance, "keep Ask warm during business hours" isn't a separate architecture from what's below — it *is* the middle tier. Reactive scale-to-zero (the Lean tier's KEDA cooldown) can't distinguish "this gap is fine, it's just a background import" from "this gap means a solicitor is about to ask a question and will feel the wait" — both look identical to a cooldown timer. The fix isn't smarter reactive scaling, it's simpler than that: a **scheduled** minimum-replica-count instead of a purely request-triggered one. KEDA supports this natively via its Cron Scaler — set `minReplicaCount: 1` for your business-hours window (e.g. 7am–7pm UK, Mon–Fri) and `minReplicaCount: 0` outside it, layered underneath the same request/queue-depth scaler so it can still scale *out* beyond 1 replica if load genuinely demands it. Overnight and weekend imports still work — they just cold-start like any Lean-tier request, which is fine because nobody's watching a spinner for those.

| Tier | What it means | ≈Monthly cost |
|---|---|---|
| **Lean** | Single g6.xlarge (Qwen3-8B + embed + rerank, all co-located), Karpenter node scale-to-zero on a ~7min cooldown for *every* request including "Ask" — pre-baked AMI keeps cold starts near 60–90s, but every idle gap (day or night) still means a wait. | ≈$130–170 |
| **Warm on a schedule** ← *recommended* | Same single instance; KEDA Cron Scaler holds it warm ~10–12hr/day on working days (covering realistic "Ask" hours) and lets it scale to zero the rest of the time. No cold-start wait for anyone asking a question during the day; overnight imports still cold-start, which is fine. | ≈$280–330 |
| **Always-on** | Same single instance, running 24/7 — simplest to operate, no scaling logic to build at all, but pays for a lot of idle GPU time neither path is using. | ≈$800–850 |

Lean tier: ~73 billed hours/month (worked example above) × $0.978/hr (g6.xlarge) ≈ $71, plus Aurora Serverless v2 at 0.5 ACU (~$44/mo idle floor) plus ~$25 ALB/S3 ≈ $140. Warm-on-a-schedule: ~260–300 hours/month × $0.978 ≈ $255–295, plus the same $44 + $25 ≈ **$325–365/month total**. Always-on: 730 hours × $0.978 ≈ $714, plus $44 + $25. **The exact business-hours window (how many hours/days it actually needs to cover) is the one real assumption left in the recommended tier — narrow it once you know your actual users' working pattern, since every hour trimmed off the schedule is worth ~$1/month at this instance size.**

### Third-party hosted inference (Together AI / Fireworks / Groq) — ruled out

Yes — using any of these means the actual document text and generated answers leave your AWS account and are processed on that provider's own infrastructure (not AWS, and not something you can put inside your own VPC). That holds regardless of their retention policy: Fireworks and Groq both publish genuine zero-data-retention options (Fireworks is SOC 2 Type II + HIPAA + ZDR for open models; Groq lets you enable ZDR account-wide, though it notes logs may still be kept up to 30 days for abuse/error investigation even with ZDR on) — but a retention promise is a policy about what happens to data *after* it's processed, not a guarantee about *where* processing happens or who could ever access it in principle. For legally confidential, privileged material, control over the processing environment itself is usually the actual requirement, not just a vendor's word on retention — which is exactly why this report stays scoped to your own AWS account throughout, and why the Lean/Warm/Always-on tiers above are the real options on the table, not a false economy against a hosted API that was never actually available to you.

## Serving stack

**vLLM** is the safe default — mature, broad model support, the most battle-tested option for "one model, real production traffic." **SGLang** is worth a real benchmark on your own workload specifically because RAG is a shared-prefix pattern (the same system prompt and retrieval instructions repeat on every call) — SGLang's RadixAttention caches that shared computation and measured ~29% higher throughput than vLLM in one 2026 benchmark on workloads shaped like yours. The two engines have leapfrogged each other release to release, so treat this as "benchmark both before committing," not a settled call. **Not Ollama** for the deployed service — it queues requests one at a time and OOMs around ~40 concurrent requests on an H100, where vLLM sustains 180+; Ollama is the right tool for a developer's laptop, not a multi-user cloud backend.

## Deployment path on AWS

- **Most control — Raw EC2 + vLLM/SGLang.** You pick the instance, own the container, run the serving stack yourself (behind ALB/EKS). Full flexibility on model choice and quantization; full ops burden.
- **Balanced — SageMaker JumpStart.** One-click deploy from a catalog that already includes Qwen, Mistral, Llama, and other open weights onto a managed endpoint. Less ops than raw EC2, still your instance/VPC, good middle ground.
- **Least ops — Bedrock Custom Model Import.** Serverless, on-demand billing, no instances to manage; best for spiky/bursty usage. Supported architecture list is narrower (confirm Qwen3/DeepSeek support before committing) — check this against your specific model choice above.

## Embeddings & reranking (self-hosted)

| Role | Model | Notes |
|---|---|---|
| Embedding | **Qwen3-Embedding-8B** | Tops open-weight MTEB multilingual (~70.6); Apache 2.0, flexible output dimensions (32–4096) |
| Reranker (default) | **BGE-reranker-v2-m3** | The battle-tested baseline — cheap, multilingual, small enough to run on modest hardware |
| Reranker (modern alt.) | **Qwen3-Reranker-4B** | Apache 2.0, 100+ languages, 32K context — worth A/B testing against BGE on your corpus |

Adding a reranking pass after initial retrieval is the other half of the "contextual retrieval" pattern that cut failed retrievals by up to 67% in Anthropic's published benchmark — it applies just as well to a fully self-hosted stack, since rerankers are small cross-encoders, cheap to run alongside the generator (can even share the smaller GPU instance with the embedding model rather than needing dedicated hardware).

## Vector store — pgvector is very likely all you need

Run the numbers: ~15,000–40,000 chunks per matter means even **1,000 concurrent matters** is only 15–40 million vectors — comfortably inside what a single well-indexed pgvector table handles, especially with an `ivfflat`/`hnsw` index and a `matter_id` filter column (the same per-matter isolation principle the desktop app already uses with one SQLite file per matter, just as rows instead of files). This removes the "graduate to Qdrant once you outgrow pgvector" question that applies to genuinely large-scale RAG — you're unlikely to hit that ceiling here.

| Option | Recommendation at your scale | Notes |
|---|---|---|
| **pgvector** on **Aurora Serverless v2** | Use this | Embeddings, documents, and metadata in one queryable place with plain SQL joins — matches the relational-DB comfort of the existing SQLite-based desktop app. Handles orders of magnitude more than you'll actually accumulate. Serverless v2 (not a fixed instance) scales down to a 0.5 ACU floor (~$44/mo) when idle, which matters at this budget — a fixed always-on instance is the wrong default here even though the DB itself is cheap in absolute terms. |
| Qdrant / Milvus / OpenSearch | Not needed | Real alternatives at genuinely large scale (tens of millions+ of concurrently-indexed vectors with heavy filtered-query load) — worth revisiting only if you end up hosting a very large number of matters at once with much higher retrieval QPS than a typical eDisclosure workload. |

## Why self-hosting solves the data-residency question outright

An earlier hosted-API version of this report flagged that even Anthropic's and OpenAI's own APIs process data in the US regardless of storage region, and that only Azure OpenAI currently offers a hard contractual guarantee otherwise. Self-hosting removes the question entirely: everything — model weights, embeddings, vector index, retrieved documents — runs inside your own AWS account, in whichever region you choose (e.g. `eu-west-2` London for UK data). This applies equally to **DeepSeek's open weights**: running them yourself on your own AWS infrastructure is not the same thing as calling DeepSeek's own hosted API — the weights are downloadable and Apache/MIT-style licensed, and nothing leaves your environment or touches a Chinese-domiciled service once you're serving them from your own instance.

## Reality check that still applies

Model choice and hosting location don't eliminate hallucination on their own. Every model here still needs a retrieval-grounded pipeline with citation discipline — the published gap between raw-LLM legal question-answering (43–88% hallucination in Stanford's testing) and RAG-grounded legal tools (17–33%) came from retrieval and prompting architecture, not model swaps. Budget real evaluation time against your own document corpus once this stack is running, independent of which specific model sits at the center.

## Sources

- [EC2 GPU Instances: A Full Guide to AWS GPUs (August 2026) — Thunder Compute](https://www.thundercompute.com/blog/ec2-gpu-instances)
- [Amazon EC2 GPU Pricing 2026 — Markaicode](https://markaicode.com/pricing/amazon-ec2-pricing-gpu-instance-cost-production/)
- [Amazon EC2 G6 Instances — AWS](https://aws.amazon.com/ec2/instance-types/g6/)
- [SGLang vs vLLM in 2026 — Kanerika](https://kanerika.com/blogs/sglang-vs-vllm/)
- [Ollama vs vLLM — Spheron](https://www.spheron.network/blog/ollama-vs-vllm/)
- [SageMaker vs Bedrock in 2026 — Explore Agentic](https://www.exploreagentic.ai/insights/bedrock-vs-sagemaker/)
- [Amazon Bedrock Custom Model Import GA — AWS](https://aws.amazon.com/about-aws/whats-new/2024/10/amazon-bedrock-custom-model-import)
- [Best Rerankers for RAG in 2026 — Mixpeek](https://mixpeek.com/curated-lists/best-rerankers)
- [pgvector vs Qdrant vs Milvus 2026 — DEV Community](https://dev.to/linou518/choosing-the-foundation-for-your-rag-system-pgvector-vs-qdrant-vs-milvus-2026-4i5o)
- [Run Qwen3 Locally: GPU Requirements 2026 — Spheron](https://www.spheron.network/blog/run-qwen3-locally-gpu-requirements-2026/)
- [Best Open-Source LLMs for RAG in 2026 — PremAI](https://www.premai.io/blog/best-open-source-llms-for-rag-in-2026-10-models-ranked-by-retrieval-accuracy/)
- [Best Embedding Models for RAG 2026 — PremAI](https://www.premai.io/blog/best-embedding-models-for-rag-2026-ranked-by-mteb-score-cost-and-self-hosting/)
- [Contextual Retrieval — Anthropic Engineering](https://www.anthropic.com/engineering/contextual-retrieval)
- [What the Science Says About Hallucinations in Legal Research — LLRX](https://www.llrx.com/2026/02/what-the-science-says-about-hallucinations-in-legal-research/)
