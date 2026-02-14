import { loadSources } from "./config.js";
import { ingestSources } from "./ingest.js";
import { searchChunks } from "./search.js";
import {
  initEmbeddings,
  embedChunks,
  vectorSearch,
  isEmbeddingsReady,
} from "./embeddings.js";

async function test() {
  // 1. Ingest
  const sources = loadSources();
  const chunks = ingestSources(sources);

  // 2. Keyword search
  console.log("\n=== KEYWORD SEARCH: 'Docker deployment PHP nginx' ===\n");
  const kwResults = searchChunks(chunks, "Docker deployment PHP nginx", 3);
  kwResults.forEach((r, i) => {
    console.log(`--- Result ${i + 1} (score: ${r.score}) ---`);
    console.log(`Source: ${r.chunk.source}`);
    console.log(`Section: ${r.chunk.section}`);
    console.log(`Lines: ${r.chunk.lineStart}-${r.chunk.lineEnd}`);
    console.log(r.chunk.content.slice(0, 150));
    console.log();
  });

  // 3. Embeddings
  console.log("=== LOADING EMBEDDINGS ===\n");
  const ready = await initEmbeddings();
  if (!ready) {
    console.log("Embeddings not available — done.");
    return;
  }

  console.log(`Embedding ${chunks.length} chunks...`);
  const embedded = await embedChunks(chunks);
  console.log(`Embedded ${embedded.length} chunks\n`);

  // 4. Semantic search
  console.log("=== SEMANTIC SEARCH: 'how to deploy to production server' ===\n");
  const semResults = await vectorSearch(
    "how to deploy to production server",
    embedded,
    3
  );
  semResults.forEach((r, i) => {
    console.log(`--- Result ${i + 1} (score: ${r.score.toFixed(4)}) ---`);
    console.log(`Source: ${r.chunk.source}`);
    console.log(`Section: ${r.chunk.section}`);
    console.log(r.chunk.content.slice(0, 150));
    console.log();
  });

  // 5. Second semantic test — different query
  console.log("=== SEMANTIC SEARCH: 'email queue worker supervisor' ===\n");
  const semResults2 = await vectorSearch(
    "email queue worker supervisor",
    embedded,
    3
  );
  semResults2.forEach((r, i) => {
    console.log(`--- Result ${i + 1} (score: ${r.score.toFixed(4)}) ---`);
    console.log(`Source: ${r.chunk.source}`);
    console.log(`Section: ${r.chunk.section}`);
    console.log(r.chunk.content.slice(0, 150));
    console.log();
  });
}

test().catch(console.error);
