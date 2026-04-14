const fs = require("fs");
const path = require("path");
const { buildDesktopShellHtml, runtimeConfig, desktopShellState } = require("./shell-template");

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

  const createWindow = () => {
    const win = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 1100,
      minHeight: 720,
      backgroundColor: "#080b14",
      title: "Manus Plus Desktop",
      autoHideMenuBar: true
    });
    const html = buildDesktopShellHtml();
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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
  console.log(`\nDesktop preview HTML: ${previewPath}`);
  console.log("Desktop parity milestones");
  console.log("- Run `npm run dev:electron --workspace @manus-plus/desktop` for interactive shell");
  console.log("- Wire orchestrator APIs to run and timeline components");
  console.log("- Add desktop notifications and local run cache");
}

if (process.versions.electron) {
  launchElectronShell();
} else {
  bootDesktopShell();
}
