// AI background enhancer — context-aware, identity-preserving.
//
// Two-stage pipeline:
//   1. gpt-4o-mini (vision) looks at the photo and writes a precise
//      description — who is in it, notable faces, text, setting. (~$0.001)
//   2. gpt-image-1.5 (quality from IMAGE_QUALITY, input_fidelity=high) does
//      enhancement with that description embedded in the prompt, so the
//      model knows exactly what it is looking at and what it must NOT
//      change. input_fidelity=high is OpenAI's control for preserving
//      faces/identity in edits — essential for news photos.
//
// Accepts a raw PNG/JPEG body (+ optional X-Headline header for extra
// story context), returns { image: dataUrl, context: description }.

import { readRawBody } from "../lib/http.js";

export const config = {
  api: {
    bodyParser: false,        // we read the raw image bytes ourselves
    responseLimit: "16mb",
  },
  maxDuration: 300,           // allow the Railway upscale to finish (Vercel Pro)
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    res.status(503).json({ error: "OPENAI_API_KEY not set on server." });
    return;
  }

  try {
    const buffer = await readRawBody(req, 10 * 1024 * 1024);
    if (buffer.length < 1000) {
      res.status(400).json({ error: "Empty or invalid image body." });
      return;
    }
    const mime = req.headers["content-type"]?.includes("jpeg") ? "image/jpeg" : "image/png";
    const headline = decodeURIComponent(req.headers["x-headline"] || "").trim().slice(0, 200);

    // PRIMARY: self-hosted CodeFormer + Real-ESRGAN on Railway (pixel-faithful).
    const railwayT0 = Date.now();
    // else fall through to gpt-image-1.5 ↓

    // The SELECTED POSTER RATIO drives the output size, so a 9:16 poster
    // gets a portrait image (outpainted if the source is landscape) instead
    // of a landscape image that the canvas then crops to shreds.
    const posterRatio = (req.headers["x-poster-ratio"] || "").toString();
    const sizeHint = (req.headers["x-image-orientation"] || "").toString();
    const size = sizeForRatio(posterRatio, sizeHint);

    // Default medium: input_fidelity=high (kept) does the face preservation;
    // quality mostly buys texture. high≈$0.25, medium≈$0.06, low≈$0.016.
    const quality = (process.env.IMAGE_QUALITY || "medium").toLowerCase();

    const t0 = Date.now();

    // Stage 1 — understand the image (cheap, fails soft)
    const description = await describeImage(apiKey, buffer, mime);
    if (description) console.log(`vision context (${Date.now() - t0}ms): ${description.slice(0, 140)}…`);

    // Stage 2 — context-aware enhancement.
    // gpt-image-1.5 first; automatic fallback to gpt-image-1 if the account
    // doesn't have the newer model.
    const prompt = buildEnhancePrompt(description, headline, posterRatio);
    const callEdit = async (model) => {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", size);
      form.append("quality", quality);
      form.append("input_fidelity", "high");   // OpenAI's face/identity preservation control
      form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");
      return fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    };

    let modelUsed = "gpt-image-1.5";
    let aiRes = await callEdit(modelUsed);
    if (!aiRes.ok && [400, 403, 404].includes(aiRes.status)) {
      const firstErr = await aiRes.text().catch(() => "");
      console.warn(`gpt-image-1.5 unavailable (${aiRes.status}) — falling back to gpt-image-1:`, firstErr.slice(0, 160));
      modelUsed = "gpt-image-1";
      aiRes = await callEdit(modelUsed);
    }

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`${modelUsed} ${aiRes.status}:`, errText.slice(0, 400));
      res.status(502).json({ error: `OpenAI image ${aiRes.status}`, detail: errText.slice(0, 300) });
      return;
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      res.status(502).json({ error: "OpenAI returned no image data." });
      return;
    }

    console.log(`AI enhance done in ${Date.now() - t0}ms (${modelUsed}, ${size}, quality=${quality}, ${Math.round(b64.length * 0.75 / 1024)} KB out)`);
    res.status(200).json({ image: `data:image/png;base64,${b64}`, context: description, engine: modelUsed });
  } catch (err) {
    console.error("upscale-image error:", err);
    res.status(500).json({ error: err.message || "Image enhance failed." });
  }
}
