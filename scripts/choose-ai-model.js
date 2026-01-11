/* eslint-disable no-console */
"use strict";

const OpenAI = require("openai");

const preferredModels = [
  "gpt-5-nano",
  "gpt-5-mini",
  "gpt-4.1-nano",
  "gpt-4.1-mini",
  "gpt-4o-mini",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it in your shell or Vercel env vars.`);
  }
  return value;
}

async function supportsResponses(client, model) {
  try {
    const res = await client.responses.create({
      model,
      instructions: "Return the single word OK.",
      input: [{ type: "message", role: "user", content: "OK" }],
      max_output_tokens: 16,
    });
    return Boolean(res && typeof res.output_text === "string");
  } catch (err) {
    const status = err?.status || err?.response?.status || null;
    return { ok: false, status, message: err?.message || String(err) };
  }
}

async function supportsChatCompletions(client, model) {
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Return the single word OK." },
        { role: "user", content: "OK" },
      ],
      max_tokens: 16,
    });
    const text = res?.choices?.[0]?.message?.content || "";
    return { ok: true, text };
  } catch (err) {
    const status = err?.status || err?.response?.status || null;
    return { ok: false, status, message: err?.message || String(err) };
  }
}

async function main() {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const client = new OpenAI({ apiKey });

  console.log(">> Listing models enabled on this API key...");
  const modelList = await client.models.list();
  const ids = new Set((modelList?.data || []).map((m) => m.id));
  console.log(`   models: ${ids.size}`);

  const candidates = preferredModels.filter((m) => ids.has(m));
  if (candidates.length === 0) {
    console.log("!! None of the preferred models were found on this key.");
    console.log("   Try setting OPENAI_MODEL to one of the ids in /v1/models.");
    process.exit(2);
  }

  console.log(">> Probing candidates (Responses API first, then Chat Completions)...");
  for (const model of candidates) {
    const r = await supportsResponses(client, model);
    if (r === true || r?.ok !== false) {
      console.log(`   [OK] ${model} supports Responses API`);
      console.log("");
      console.log("Recommended Vercel env vars:");
      console.log(`OPENAI_MODEL=${model}`);
      console.log("OPENAI_FALLBACK_MODELS=gpt-4.1-nano,gpt-4o-mini");
      process.exit(0);
    }

    const c = await supportsChatCompletions(client, model);
    if (c.ok) {
      console.log(`   [OK] ${model} supports Chat Completions`);
      console.log("");
      console.log("Recommended Vercel env vars:");
      console.log(`OPENAI_MODEL=${model}`);
      console.log("OPENAI_FALLBACK_MODELS=gpt-4.1-nano,gpt-4o-mini");
      process.exit(0);
    }

    console.log(`   [NO] ${model} failed`);
    console.log(`        responses: ${r.status || ""} ${r.message || ""}`.trim());
    console.log(`        chat:      ${c.status || ""} ${c.message || ""}`.trim());
  }

  console.log("!! No candidate model worked with either API.");
  process.exit(3);
}

main().catch((err) => {
  console.error("Failed:", err?.message || String(err));
  process.exit(1);
});

