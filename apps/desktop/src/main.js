const fs = require("fs");
const path = require("path");
const { buildDesktopShellHtml, runtimeConfig, desktopShellState } = require("./shell-template");

const DEFAULT_WEB_URL = "http://localhost:3000";

function resolveWebSurfaceUrl() {
  return process.env.MANUS_PLUS_WEB_URL || process.env.ELECTRON_WEB_URL || DEFAULT_WEB_URL;
}

function printHeader() {
  console.log("=".repeat(72));
  console.log("Manus Plus Desktop");
  console.log("Prompt-first autonomous workspace shell");
  console.log("=".repeat(72));
}

function printRuntime() {
  console.log("Runtime");
  console.log(`- Orchestrator: ${runtimeConfig.orchestratorUrl}`);
  console.log(`- Browser Operator: ${runtimeConfig.browserOperatorUrl}`);
  console.log(`- Realtime: ${runtimeConfig.realtimeUrl}`);
  console.log(`- Skills Registry: ${runtimeConfig.skillsRegistryUrl}`);
}

function printRuns() {
  console.log("\nRecent Runs");
  for (const run of desktopShellState.recentRuns) {
    console.log(`- ${run.id} | ${run.state} | ${run.phase}`);
  }
}

function createDesktopPreview() {
  const targetDir = path.join(__dirname, "..", "preview");
  const targetFile = path.join(targetDir, "desktop-shell.html");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, buildDesktopShellHtml(), "utf8");
  return targetFile;
}

function launchElectronShell() {
  // eslint-disable-next-line global-require
  const { app, BrowserWindow } = require("electron");
  const webUrl = resolveWebSurfaceUrl();

  const createWindow = () => {
    const win = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 1100,
      minHeight: 720,
      backgroundColor: "#080b14",
      title: "Manus Plus Desktop",
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    void win.loadURL(webUrl);
  };

  app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

function bootDesktopShell() {
  printHeader();
  printRuntime();
  printRuns();
  const previewPath = createDesktopPreview();
  const webUrl = resolveWebSurfaceUrl();
  console.log(`\nDesktop preview HTML (offline shell): ${previewPath}`);
  console.log(`Electron loads the full web app at: ${webUrl}`);
  console.log("Start stack: `npm run dev:apis` then `npm run dev:web`, then:");
  console.log("  `npm run dev:electron --workspace @manus-plus/desktop`");
  console.log(`Override URL: set MANUS_PLUS_WEB_URL (see repo .env.example).`);
}

if (process.versions.electron) {
  launchElectronShell();
} else {
  bootDesktopShell();
}
