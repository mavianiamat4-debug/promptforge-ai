// ============================================================
// PromptForge AI — video analyzer backend
// Upload a video (≤30s) → frames go to a vision AI → a
// professional, paste-ready recreation prompt comes back.
// ============================================================
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MOCK_MODE = process.env.MOCK_MODE === "true";
const MAX_SECONDS = 30;
const MAX_BYTES = 150 * 1024 * 1024; // 150 MB

// Portable ffmpeg/ffprobe (static binaries work on Render, Railway, VPS…)
let FFMPEG = process.env.FFMPEG_PATH || "";
let FFPROBE = process.env.FFPROBE_PATH || "";
try { if (!FFMPEG) FFMPEG = require("ffmpeg-static"); } catch (e) { FFMPEG = "ffmpeg"; }
try { if (!FFPROBE) FFPROBE = require("ffprobe-static").path; } catch (e) { FFPROBE = "ffprobe"; }

// ------------------------------------------------------------
// The vision prompt — this is what teaches the AI to write
// prompts in the exact professional house style.
// ------------------------------------------------------------
const SYSTEM_INSTRUCTION = `You are an expert AI-video prompt engineer. You are given sequential frames extracted from a short real-life video (30 seconds or less). Each frame is labeled with its timestamp.

YOUR TASK: Study the frames carefully — identify the subject(s), the setting, every action in chronological order, camera behavior, lighting, colors, and mood — then write ONE complete, professional text-to-video prompt that would recreate this video as closely as possible when pasted into an AI video generator (Seedance, Kling, Veo, Runway, Pika, etc.).

STRICT RULES:
1. Write a STANDALONE recreation prompt. NEVER mention "reference video", "original video", "the frames", "as shown", "recreate", or anything revealing this came from an existing video. Write as if directing a brand-new shoot.
2. Follow this EXACT structure and section order:
   PROMPT: <SHORT DESCRIPTIVE TITLE IN CAPS>
   VIDEO REQUIREMENTS:
   VISUAL STYLE:
   MAIN CHARACTER:
   COLOR PALETTE:
   LIGHTING & MOOD:
   LOCATION:
   IMPORTANT SEQUENCE RULE:
   <then timestamped stages, one per distinct action/camera beat, e.g. "0.00-4.20 SECONDS — DIGGING THE FOUNDATION". Each stage has: a richly detailed action paragraph (physical, concrete, step-by-step), a "Camera:" line, and a "NATURAL ASMR:" sound list>
   AUDIO — NATURAL ASMR ONLY:
   AVOID:
   FINAL CONTINUITY REQUIREMENTS:
3. Chronology is sacred: every action in the exact order it happens. Never skip stages, reverse actions, or reveal a finished result before it has been physically earned. Cover the FULL duration with no time gaps.
4. Be extremely concrete and physical: name materials, tools, body movements, spatial relations. Write "She pushes the shovel blade into the loose soil, lifts and moves the soil away" — never "she works with the soil".
5. Match the number of stages to the video's complexity: simple videos get fewer stages, complex videos get more. Each stage gets its own timestamp range.
6. Describe the MAIN CHARACTER precisely: species/breed or person, age cues, clothing, colors, distinguishing features. Keep them identical across every stage.
7. Audio: natural location ASMR only, synchronized to visible actions. Explicitly forbid: background music, voiceover, narration, artificial sound effects, subtitles, captions, logos, watermarks, text overlays.
8. AVOID section must include: cartoon, 3D animation, CGI look, watermark, logo, text overlay, subtitles, artificial effects.
9. FINAL CONTINUITY REQUIREMENTS: same subject, clothing, location, lighting, and visual style throughout; numbered shot order; nothing appears by magic.
10. Length: as long as needed for full fidelity — typically 3,000 to 9,000 characters. Detail over brevity. Simple videos may be shorter; never pad.
11. Aspect ratio: match the source frames (assume vertical 9:16 unless the frames are clearly landscape).

STYLE EXAMPLE of one stage (match this voice):
"0.00-4.20 SECONDS — DIGGING THE FOUNDATION

She stands at the edge of the marked rectangle, grips the shovel with both hands, and pushes the blade into the loose soil. She lifts each scoop and tosses it to the side in a steady rhythm, her boots braced against the ground. Dust rises with every thrust. The rectangular outline deepens into a shallow trench.

Camera: static wide shot from a slight side angle — the full digging motion stays in frame.

NATURAL ASMR:
shovel blade scraping soil,
soft thuds of tossed earth,
faint outdoor ambience."

Output ONLY the prompt. No commentary, no explanations, no markdown code fences.`;

const app = express();
app.set("trust proxy", 1); // needed on Render/Railway for correct IP rate limiting
app.use(express.static(path.join(__dirname, "public")));

// ---- homepage resilience: serve index.html even if a repo edit moved it out of public/ ----
app.get("/", (req, res, next) => {
  const candidates = [
    path.join(__dirname, "public", "index.html"),
    path.join(__dirname, "index.html"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return next();
  res.sendFile(found);
});

// ---- abuse protection: 30 analyses per 15 minutes per IP ----
app.use("/api/analyze", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a few minutes and try again." },
}));

const upload = multer({
  dest: path.join(os.tmpdir(), "pf-uploads"),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const ok = /video\/(mp4|quicktime|webm|x-m4v|3gpp)/.test(file.mimetype) ||
               /\.(mp4|mov|webm|m4v)$/i.test(file.originalname);
    cb(ok ? null : new Error("ONLY_VIDEO"), ok);
  },
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mockMode: MOCK_MODE, model: GEMINI_MODEL, maxSeconds: MAX_SECONDS });
});

async function getDuration(filePath) {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath,
  ], { timeout: 30000 });
  const d = parseFloat(stdout.trim());
  if (!isFinite(d) || d <= 0) throw new Error("BAD_DURATION");
  return d;
}

async function extractFrames(videoPath, outDir, count, duration) {
  fs.mkdirSync(outDir, { recursive: true });
  const fps = (count / duration).toFixed(4);
  await execFileAsync(FFMPEG, [
    "-y", "-i", videoPath,
    "-vf", `fps=${fps},scale=640:-2`,
    "-q:v", "5",
    "-frames:v", String(count),
    path.join(outDir, "frame-%02d.jpg"),
  ], { timeout: 90000 });
  const files = fs.readdirSync(outDir).filter(f => f.endsWith(".jpg")).sort();
  const step = duration / count;
  return files.map((f, i) => ({
    t: Math.min(duration - 0.05, i * step),
    b64: fs.readFileSync(path.join(outDir, f)).toString("base64"),
  }));
}

async function askGemini(frames, duration, aspectHint) {
  const parts = [
    { text: `You are given ${frames.length} sequential frames from a ${duration.toFixed(1)}-second ${aspectHint} video. The frames are in chronological order. Analyze them deeply and write the complete recreation prompt.` },
  ];
  frames.forEach((f, i) => {
    parts.push({ text: `Frame ${i + 1} of ${frames.length} — at ${f.t.toFixed(1)}s:` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: f.b64 } });
  });
  parts.push({ text: "Now write the complete recreation prompt following all rules. Output ONLY the prompt." });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ parts }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 8000 },
        }),
      }
    );
    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || ("HTTP " + resp.status);
      throw new Error("GEMINI_" + resp.status + ": " + msg);
    }
    const cands = data.candidates || [];
    const text = cands.map(c => (c.content && c.content.parts || []).map(p => p.text || "").join("")).join("").trim();
    if (!text) {
      const reason = (cands[0] && cands[0].finishReason) || "unknown";
      throw new Error("EMPTY_RESPONSE (finishReason: " + reason + ")");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function mockPrompt(duration) {
  return `PROMPT: MOCK MODE — SAMPLE OUTPUT

(This is a sample response so you can test the full flow without a Gemini API key. Set MOCK_MODE=false and add your GEMINI_API_KEY to get real AI analysis.)

VIDEO REQUIREMENTS:
Create exactly one ${duration.toFixed(1)}-second video in vertical 9:16 format.
The final result must look like authentic real-life footage, not computer-generated imagery.

VISUAL STYLE:
Photorealistic live-action footage with natural textures and believable physical behavior. No cartoon style, no animation, no artificial CGI appearance.

MAIN CHARACTER:
A realistic main subject with natural appearance and believable movement. Keep appearance, clothing, scale, and behavior identical in every shot.

IMPORTANT SEQUENCE RULE:
Every action must happen in the exact chronological order specified below. No action out of order — step by step, precisely.

0.00-${duration.toFixed(2)} SECONDS — SAMPLE STAGE

In mock mode the AI does not watch your video. Connect a Gemini API key to receive the full deep analysis with timestamped stages, camera directions, and natural ASMR sound design.

Camera: static wide shot.

NATURAL ASMR:
faint outdoor ambience.

AUDIO — NATURAL ASMR ONLY:
NO background music. NO voiceover. NO narration. NO subtitles. NO watermarks.

AVOID:
cartoon, 3D animation, CGI look, watermark, logo, text overlay, subtitles, artificial effects.

FINAL CONTINUITY REQUIREMENTS:
Keep the same subject, same clothing, same location, same lighting, and same visual style throughout.`;
}

app.post("/api/analyze", upload.single("video"), async (req, res) => {
  const tmpFiles = [];
  try {
    if (!req.file) return res.status(400).json({ error: "No video file received." });
    tmpFiles.push(req.file.path);

    const duration = await getDuration(req.file.path);
    if (duration > MAX_SECONDS + 0.5) {
      return res.status(400).json({
        error: `This video is ${duration.toFixed(1)}s — the analyzer accepts videos up to ${MAX_SECONDS} seconds.`,
      });
    }

    // Fail fast: no API key means no analysis — don't waste time extracting frames first
    if (!MOCK_MODE && !GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing its GEMINI_API_KEY. The site owner needs to add it." });
    }

    // Adaptive: complex (longer) videos get more frames, simple ones fewer (capped for speed)
    const frameCount = Math.max(6, Math.min(10, Math.round(duration / 3)));
    const frameDir = path.join(os.tmpdir(), "pf-frames-" + Date.now());
    tmpFiles.push(frameDir);
    const frames = await extractFrames(req.file.path, frameDir, frameCount, duration);

    let prompt;
    if (MOCK_MODE) {
      prompt = mockPrompt(duration);
    } else {
      prompt = await askGemini(frames, duration, "vertical 9:16");
    }

    res.json({ prompt, duration: Number(duration.toFixed(2)), frames: frames.length, mock: MOCK_MODE });
  } catch (err) {
    console.error("analyze error:", err.message);
    let msg = "Analysis failed. Please try again.";
    if (err.message === "ONLY_VIDEO") msg = "Please upload a video file (MP4, MOV, or WebM).";
    else if (err.message === "BAD_DURATION") msg = "Could not read this video's duration.";
    else if (err.message.startsWith("GEMINI_429")) msg = "The AI is rate-limited right now — please wait a minute and retry.";
    else if (err.message.startsWith("GEMINI_")) msg = "The AI service returned an error. Please try again in a moment.";
    else if (err.message.startsWith("EMPTY_RESPONSE")) msg = "The AI returned an empty response — please retry.";
    else if (err.name === "AbortError") msg = "Analysis timed out — please try a shorter video.";
    else if (err.killed) msg = "Video processing took too long — try a shorter or smaller video file.";
    res.status(502).json({ error: msg });
  } finally {
    for (const p of tmpFiles) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
});

// multer / upload errors → clean JSON
app.use((err, req, res, next) => {
  if (err && (err.code === "LIMIT_FILE_SIZE" || err.message === "ONLY_VIDEO")) {
    return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Video file is too large (max 150 MB)." : "Please upload a video file (MP4, MOV, or WebM)." });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`PromptForge AI backend listening on port ${PORT}`);
  console.log(`Mode: ${MOCK_MODE ? "MOCK (no API key needed)" : "LIVE — model " + GEMINI_MODEL}`);
});
