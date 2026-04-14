const fs = require("fs");
const path = require("path");

const mobileConfig = {
  apiBaseUrl: process.env.MOBILE_API_BASE_URL || "http://localhost:4100",
  realtimeUrl: process.env.MOBILE_REALTIME_URL || "ws://localhost:4102"
};

const mobileState = {
  screen: "home",
  status: "idle",
  quickActions: ["Research", "Build", "Analyze", "Design"],
  pendingTasks: [
    { id: "task_mobile_11", state: "running" },
    { id: "task_mobile_12", state: "queued" }
  ]
};

function renderMobileHeader() {
  console.log("Manus Plus Mobile");
  console.log("Agent workspace in your pocket");
}

function renderConnectivity() {
  console.log("\nConnectivity");
  console.log(`- API: ${mobileConfig.apiBaseUrl}`);
  console.log(`- Realtime: ${mobileConfig.realtimeUrl}`);
}

function renderHomeCards() {
  console.log("\nHome Cards");
  console.log(`- Active screen: ${mobileState.screen}`);
  console.log(`- Task status: ${mobileState.status}`);
  console.log(`- Quick actions: ${mobileState.quickActions.join(" | ")}`);
}

function renderTaskSnapshot() {
  console.log("\nTask Snapshot");
  for (const task of mobileState.pendingTasks) {
    console.log(`- ${task.id}: ${task.state}`);
  }
}

function renderMobileRoadmap() {
  console.log("\nMobile parity milestones");
  console.log("- Run `npm run dev:expo --workspace @manus-plus/mobile` for interactive shell");
  console.log("- Add push notifications for completed runs");
  console.log("- Add compact artifact and diagnostics views");
}

function createMobilePreview() {
  const targetDir = path.join(__dirname, "..", "preview");
  const targetFile = path.join(targetDir, "mobile-shell.html");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Manus Plus Mobile Shell</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      background: radial-gradient(circle at 70% 0%, #121d33 0%, #080b14 42%, #06080d 100%);
      font-family: Inter, Segoe UI, Arial, sans-serif;
      display: grid;
      place-items: center;
      min-height: 100vh;
      color: #e5ecff;
    }
    .phone {
      width: min(390px, 94vw);
      min-height: 760px;
      border: 1px solid #2d3a58;
      border-radius: 28px;
      background: #0d1424e3;
      padding: 14px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.48);
    }
    .title { font-size: 24px; margin: 4px 0 6px; letter-spacing: -0.02em; }
    .muted { color: #9cafd4; font-size: 12px; }
    .card {
      margin-top: 10px;
      border: 1px solid #2a3856;
      background: #121d32de;
      border-radius: 14px;
      padding: 10px;
      font-size: 13px;
    }
    .chip {
      display: inline-block;
      margin: 4px 4px 0 0;
      font-size: 12px;
      padding: 5px 9px;
      border-radius: 999px;
      background: #1b2c49;
      border: 1px solid #42649f;
      color: #d0e0ff;
    }
  </style>
</head>
<body>
  <main class="phone">
    <div class="muted">Manus Plus Mobile</div>
    <h1 class="title">Build on the go</h1>
    <div class="card">Prompt: Plan a launch strategy for Manus Plus.</div>
    <div>
      <span class="chip">Research</span>
      <span class="chip">Build</span>
      <span class="chip">Analyze</span>
      <span class="chip">Design</span>
    </div>
    <div class="card">task_mobile_11 · running</div>
    <div class="card">task_mobile_12 · queued</div>
    <div class="card">Realtime connected · status idle</div>
  </main>
</body>
</html>`;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, html, "utf8");
  return targetFile;
}

function bootMobileShell() {
  renderMobileHeader();
  renderConnectivity();
  renderHomeCards();
  renderTaskSnapshot();
  renderMobileRoadmap();
  const previewPath = createMobilePreview();
  console.log(`\nMobile preview HTML: ${previewPath}`);
  console.log("\nMobile shell bootstrap completed.");
}

bootMobileShell();
