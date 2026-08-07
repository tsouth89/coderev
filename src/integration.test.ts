/**
 * End-to-end tests against a local fake provider speaking real SSE.
 *
 * The unit tests cover pure logic, but every production failure this tool has
 * actually had was in the transport: a non-streaming request killed mid-flight
 * (reported as a clean review), a vendor reporting the same cached-token count
 * in two fields (halved the cost figure), a stream that needed line-buffered
 * reassembly. None of that is reachable from a pure function, so these tests
 * stand up a real HTTP server, stream real chunked SSE at the real client, and
 * assert on what reviewDiff returns.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { requestCompletion, type ResolvedReviewProvider } from "./provider.ts";
import { FIND_SYSTEM_PROMPT, reviewDiff } from "./review.ts";

interface FakeBehaviour {
  /** Findings JSON the find stage should stream back. */
  findResponse: string;
  /** Given the refute prompt body, decide the verdict JSON to stream. */
  refuteResponse: (body: string) => string;
  /** Return an HTTP status to fail the next request with, or null to succeed. */
  failNext: () => number | null;
  requestCount: number;
}

const behaviour: FakeBehaviour = {
  findResponse: '{"findings":[]}',
  refuteResponse: () => '{"refuted":false,"reason":"stands"}',
  failNext: () => null,
  requestCount: 0,
};

let server: Server;
let provider: ResolvedReviewProvider;

/** Stream `content` as several SSE chunks plus a usage chunk, like a real vendor. */
function writeSse(res: import("node:http").ServerResponse, content: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  // Split mid-token on purpose: reassembly across chunk boundaries is exactly
  // the code under test.
  const middle = Math.floor(content.length / 2);
  for (const piece of [content.slice(0, middle), content.slice(middle)]) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write(
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      behaviour.requestCount += 1;
      const failure = behaviour.failNext();
      if (failure !== null) {
        res.writeHead(failure, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `injected ${failure}` } }));
        return;
      }
      const isFind = body.includes(JSON.stringify(FIND_SYSTEM_PROMPT).slice(1, 40));
      writeSse(res, isFind ? behaviour.findResponse : behaviour.refuteResponse(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  provider = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "fake-model", apiKey: "k" };
});

after(() => {
  server.close();
});

function reset(): void {
  behaviour.findResponse = '{"findings":[]}';
  behaviour.refuteResponse = () => '{"refuted":false,"reason":"stands"}';
  behaviour.failNext = () => null;
  behaviour.requestCount = 0;
}

describe("pipeline against a streaming provider", () => {
  it("keeps the survivor and drops the refuted finding", async () => {
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [
        { file: "a.ts", line: 10, title: "Real leak", detail: "Handle never closed." },
        { file: "b.ts", line: 20, title: "Bogus claim", detail: "Made up." },
      ],
    });
    behaviour.refuteResponse = (body) =>
      body.includes("Bogus claim")
        ? '{"refuted":true,"reason":"cannot occur"}'
        : '{"refuted":false,"reason":"stands"}';

    const result = await reviewDiff({ diff: "--- a\n+++ b\n", conventions: null, provider });

    assert.equal(result.generationError, null);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(
      result.findings.map((finding) => finding.title),
      ["Real leak"],
    );
    // 1 find + 2 findings x 2 votes: both pairs agree, so neither tiebreak
    // seat runs — the pair-then-tiebreak fast path with an identical decision.
    assert.equal(behaviour.requestCount, 5);
    assert.equal(result.usage.reported, true);
    assert.equal(result.usage.inputTokens, 500);
    // The cache field must come through the stream path, not just JSON bodies.
    assert.equal(result.usage.cachedInputTokens, 300);
  });

  it("casts the tiebreak vote only when the first two seats split", async () => {
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 10, title: "Contested claim", detail: "d" }],
    });
    // Seat lenses appear verbatim in the vote body, so the mock can split the
    // pair and let the scope seat decide.
    behaviour.refuteResponse = (body) =>
      body.includes("CHECKABILITY")
        ? '{"refuted":true,"reason":"names no trigger"}'
        : body.includes("MECHANISM ACCURACY")
          ? '{"refuted":false,"reason":"traced and confirmed"}'
          : '{"refuted":true,"reason":"restates intent"}';

    const result = await reviewDiff({ diff: "x", conventions: null, provider });

    // 1 find + a split pair + the tiebreak; majority 2-1 refuted, so dropped.
    assert.equal(behaviour.requestCount, 4);
    assert.deepEqual(result.findings, []);
    assert.equal(result.adjudicated[0]?.verdicts.length, 3);
  });

  it("reassembles JSON split across SSE chunk boundaries", async () => {
    reset();
    // writeSse splits every payload mid-token; a finding surviving proves it.
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 1, title: "Split survivor", detail: "d" }],
    });
    const result = await reviewDiff({ diff: "x", conventions: null, provider });
    assert.equal(result.findings.length, 1);
  });

  it("retries a 429 and then succeeds", async () => {
    reset();
    let failures = 1;
    behaviour.failNext = () => (failures-- > 0 ? 429 : null);

    const result = await requestCompletion({
      provider,
      systemPrompt: "s",
      userPrompt: "u",
      temperature: 0,
    });

    assert.equal(result.usage.reported, true);
    // First attempt got the 429, second succeeded.
    assert.equal(behaviour.requestCount, 2);
  });

  it("does not retry a 400, and reports the failed review as failed", async () => {
    reset();
    behaviour.failNext = () => 400;

    const result = await reviewDiff({ diff: "x", conventions: null, provider });

    // One attempt only: a 400 means the request is wrong, and retrying re-buys
    // the same rejection with money and time.
    assert.equal(behaviour.requestCount, 1);
    // The worst historical failure was reporting this case as a clean review.
    assert.notEqual(result.generationError, null);
    assert.match(result.generationError ?? "", /400/);
    assert.deepEqual(result.findings, []);
  });
});
