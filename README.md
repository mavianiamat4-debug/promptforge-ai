# PromptForge AI — Video Analyzer Backend

Upload any video (up to 30 seconds) → a real AI vision model **watches it** and writes a
professional, paste-ready recreation prompt in the PromptForge house style.

## How it works

1. User uploads a video on the web page (`public/index.html`)
2. The server checks the duration (rejects anything over 30s)
3. It extracts 8–20 frames evenly across the video (more frames for longer videos)
4. The frames go to **Google Gemini** (vision AI) with detailed instructions
5. Gemini watches the frames and writes the full prompt — subjects, actions in order,
   camera, lighting, colors, ASMR sound, continuity rules
6. The prompt is returned, displayed, and can be copied or downloaded

## Setup — 3 steps (no coding needed)

### Step 1 — Get a FREE Gemini API key (2 minutes)

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with your Google account
3. Click **"Create API Key"** → copy the key (it looks like `AIza...`)

The free tier covers the Flash vision models — plenty for this tool.

### Step 2 — Put the code on GitHub (5 minutes)

1. Create a free account at **https://github.com** (if you don't have one)
2. Click **+ → New repository**, name it `promptforge-ai`, make it **Public**, click **Create**
3. On the repo page click **"uploading an existing file"**
4. Drag in **all files** from the `promptforge-backend` folder
   (`server.js`, `package.json`, `render.yaml`, `.env.example`, and the `public` folder)
5. Click **Commit changes**

### Step 3 — Deploy on Render (5 minutes, free)

1. Create a free account at **https://render.com** (sign up with GitHub)
2. Click **New → Web Service** → connect your `promptforge-ai` repo
3. Render fills everything from `render.yaml` automatically — just click **Create Web Service**
4. Once deployed, go to the service's **Environment** tab and add:
   - Key: `GEMINI_API_KEY` → Value: your key from Step 1
5. Click **Save** — the service restarts, and your tool is LIVE at the Render URL

Open the URL → upload a video → get your AI-written prompt. Done.

## Run it on your own computer (optional)

```bash
cd promptforge-backend
npm install
cp .env.example .env        # then paste your GEMINI_API_KEY into .env
node server.js              # open http://localhost:3000
```

Tip: set `MOCK_MODE=true` in `.env` to test the full upload → prompt flow
without a key (returns a sample prompt).

## Costs & limits

- **Gemini free tier**: Flash models are free up to daily/rate limits — fine for personal
  use and light traffic. Check your quota at https://aistudio.google.com
- **Paid tier** (if you outgrow free): roughly a few cents per video analysis
- **Built-in protection**: max 30 analyses per 15 minutes per visitor, 150 MB file cap,
  30-second video cap — so nobody can burn through your quota

## Files

| File | What it is |
|---|---|
| `server.js` | The backend: upload → frames → Gemini → prompt |
| `public/index.html` | The web page users see |
| `package.json` | Dependencies |
| `render.yaml` | One-click Render deploy config |
| `.env.example` | Settings template |

## If something breaks

- `"Server is missing its GEMINI_API_KEY"` → add the key in Render → Environment
- `"model not found"` errors → Google may have renamed the Flash model; set the
  `GEMINI_MODEL` env var to the newest `gemini-*-flash` from the AI Studio docs
- `"Too many requests"` → the AI is rate-limited; wait a minute and retry
