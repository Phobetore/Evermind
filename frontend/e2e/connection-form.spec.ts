import { expect, test, type APIRequestContext } from "@playwright/test";
import { API } from "../playwright.config";

const SETTINGS = ["max_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty"];
const MINE = ["OpenAI", "Tuned"];

type Saved = { id: string; name: string; [setting: string]: unknown };

async function saved(request: APIRequestContext, name: string): Promise<Saved[]> {
  const all: Saved[] = await (await request.get(`${API}/api/connections`)).json();
  return all.filter((c) => c.name === name);
}

/** What this test made, gone, so that a second attempt starts where the first did. */
async function forgetMine(request: APIRequestContext) {
  for (const name of MINE) {
    for (const { id } of await saved(request, name)) await request.delete(`${API}/api/connections/${id}`);
  }
}

// Left empty, a setting is not sent: the newest OpenAI and Anthropic models refuse some.
test("a generation setting left empty is saved empty, and stays so", async ({ page, request }) => {
  await forgetMine(request);
  await request.post(`${API}/api/connections`, {
    data: { name: "Tuned", base_url: "http://127.0.0.1:1/v1", temperature: 0.7, max_tokens: 300 },
  });
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const form = page.getByRole("dialog");
  const preset = (name: string) => form.getByRole("button", { name, exact: true }).click();
  await preset("OpenAI");
  await form.getByRole("button", { name: "Generation settings" }).click();
  const temperature = form.getByLabel("Temperature");
  await expect(temperature).toHaveValue("");
  await expect(temperature).toHaveAttribute("placeholder", "Model default");

  // Any other preset gives the values back, and Anthropic has a ceiling of its own.
  await preset("Ollama");
  await expect(temperature).toHaveValue("0.8");
  await preset("Anthropic");
  await expect(form.getByLabel("Max response")).toHaveValue("4096");
  await expect(temperature).toHaveValue("");

  await preset("OpenAI");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();
  const [openai] = await saved(request, "OpenAI");
  expect(SETTINGS.map((key) => openai[key])).toEqual([null, null, null, null, null]);

  // Opened again, they are still empty rather than filled in.
  await page.getByRole("button", { name: /^OpenAI/ }).click();
  await form.getByRole("button", { name: "Generation settings" }).click();
  await expect(temperature).toHaveValue("");
  await form.getByRole("button", { name: "Close" }).click();

  // A box emptied by hand is saved empty, and the others as they were.
  await page.getByRole("button", { name: /^Tuned/ }).click();
  await form.getByRole("button", { name: "Generation settings" }).click();
  await expect(temperature).toHaveValue("0.7");
  await temperature.fill("");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();
  const [tuned] = await saved(request, "Tuned");
  expect([tuned.temperature, tuned.max_tokens]).toEqual([null, 300]);

  await forgetMine(request);
});

test("a connection's own box makes it the default, and the list tags it alone", async ({ page, request }) => {
  await forgetMine(request);
  await request.post(`${API}/api/connections`, { data: { name: "Tuned", base_url: "http://127.0.0.1:1/v1" } });
  await page.goto("/#/settings");
  await page.getByRole("button", { name: /^Tuned/ }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Default connection").check();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();

  await expect(page.getByRole("button", { name: /^Tuned/ })).toContainText("Default");
  await expect(page.locator("main").getByText("Default", { exact: true })).toHaveCount(1);
  const [tuned] = await saved(request, "Tuned");
  expect(tuned.is_default).toBe(true);
  await forgetMine(request);
});

test("testing a saved connection saves nothing of what was changed", async ({ page, request }) => {
  await forgetMine(request);
  await request.post(`${API}/api/connections`, {
    data: { name: "Tuned", base_url: "http://127.0.0.1:1/v1", model: "kept" },
  });
  await page.goto("/#/settings");
  await page.getByRole("button", { name: /^Tuned/ }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Model").fill("oops");
  await form.getByRole("button", { name: "Test connection" }).click();
  await expect(form.getByText("127.0.0.1:1")).toBeVisible();
  await form.getByRole("button", { name: "Close" }).click();

  const [tuned] = await saved(request, "Tuned");
  expect(tuned.model, "Test saved the change").toBe("kept");
  await forgetMine(request);
});
