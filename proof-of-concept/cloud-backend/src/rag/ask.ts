import { withTenantContext, type TenantContext } from "../db/pool.js";
import { cosineSimilarity, embedText, generate } from "./ollama.js";

const TOP_K = 4;

export interface Citation {
  documentId: string;
  guid: string;
  filename: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
}

interface ChunkRow {
  text: string;
  embedding: number[];
  document_id: string;
  guid: string;
  filename: string;
}

/**
 * Answers a question grounded only in one matter's indexed chunks (Section
 * 3.4/6). The chunks query is filtered to matter_id in the SQL itself, not
 * fetched broadly and filtered in application code afterward — retrieval
 * that can't see another matter's chunks is what actually enforces
 * isolation here, not anything downstream of it (test/rag-isolation.test.ts).
 */
export async function askMatter(tenant: TenantContext, matterId: string, question: string): Promise<AskResult> {
  const chunks = await withTenantContext(tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT c.text, c.embedding, c.document_id, d.guid, d.filename
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.matter_id = $1`,
      [matterId],
    );
    return rows as ChunkRow[];
  });

  if (chunks.length === 0) {
    return { answer: "No indexed documents are available in this matter yet.", citations: [] };
  }

  const questionEmbedding = await embedText(question);
  const ranked = chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(questionEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const excerpts = ranked
    .map(({ chunk }, i) => `[${i + 1}] (document ${chunk.guid})\n${chunk.text}`)
    .join("\n\n");

  const prompt = `You are an eDisclosure review assistant. Answer the question using ONLY the excerpts below — never use outside knowledge, and never mention or speculate about documents not shown here. If the excerpts don't contain the answer, say so plainly. Cite excerpt numbers like [1] where relevant.

Excerpts:
${excerpts}

Question: ${question}

Answer:`;

  const answer = await generate(prompt);

  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const { chunk } of ranked) {
    if (seen.has(chunk.document_id)) continue;
    seen.add(chunk.document_id);
    citations.push({ documentId: chunk.document_id, guid: chunk.guid, filename: chunk.filename });
  }

  return { answer, citations };
}
