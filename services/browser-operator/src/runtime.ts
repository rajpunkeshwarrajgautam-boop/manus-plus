export interface BrowserActionInput {
  action: "goto" | "click" | "type";
  url?: string;
  selector?: string;
  text?: string;
}

export async function runBrowserAction(input: BrowserActionInput): Promise<{ ok: boolean; detail: string }> {
  try {
    const playwright = await import("playwright");
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    if (input.action === "goto" && input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded" });
    }
    if (input.action === "click" && input.selector && input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded" });
      await page.click(input.selector);
    }
    if (input.action === "type" && input.selector && input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded" });
      await page.fill(input.selector, input.text || "");
    }
    await browser.close();
    return { ok: true, detail: `Executed ${input.action}` };
  } catch {
    return { ok: false, detail: "Playwright runtime unavailable or action failed." };
  }
}
