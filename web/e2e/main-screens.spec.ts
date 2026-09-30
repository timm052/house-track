// The main screens open without errors and their key controls work: Houses, a house page, Rate, This week, the
// map and Settings. Uses a test house of its own, deleted at the end.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

let person = "";
let house = "";
const street = `Pw${Date.now()} Street`;  // digits only, since the app capitalises street names

async function api(request: APIRequestContext, method: string, path: string, data?: unknown) {
  const r = await request.fetch(path, { method, data, headers: { "X-Person-Id": person } });
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBeTruthy();
  return r.status() === 204 ? null : r.json();
}

test.beforeAll(async ({ request }) => {
  const people: { id: string; active: boolean }[] = await (await request.get("/api/persons")).json();
  person = people.find((p) => p.active)!.id;
  house = (await api(request, "POST", "/api/properties", {
    address: { street_number: "1", street, suburb: "Mitcham", postcode: "3132" },
    campaign: { sale_method: "auction", guide_low_aud: 900_000, guide_high_aud: 990_000 },
  })).id;
});

test.afterAll(async ({ request }) => {
  if (house) await api(request, "DELETE", `/api/properties/${house}`);
});

// Signed in as that person, and any error on the page fails the test.
test.beforeEach(async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("housetrack.person", id), person);
  page.on("pageerror", (e) => { throw e; });
});

const open = async (page: Page, path: string) => { await page.goto(path); await expect(page.locator("main")).toBeVisible(); };

test("Houses lists the test house, with its tabs and the Rate tab", async ({ page }) => {
  await open(page, "/");
  await expect(page.getByRole("radio", { name: /In play/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /To inspect/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rate" })).toBeVisible();
  await page.getByRole("searchbox").fill(street);
  await expect(page.getByText(`1 ${street}`).first()).toBeVisible();
});

test("A house page opens, and To inspect can be turned on and off", async ({ page }) => {
  await open(page, `/p/${house}`);
  await expect(page.getByRole("heading", { name: `1 ${street}` })).toBeVisible();
  const toggle = page.locator(".inspect-toggle").first();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("Rate shows the newest house first and records a verdict", async ({ page, request }) => {
  await open(page, "/rate");
  await expect(page.locator(".rate-card:not(.behind) .rate-address")).toHaveText(`1 ${street}`);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await api(request, "GET", `/api/properties/${house}`)).opinions.length).toBe(1);
  await api(request, "DELETE", `/api/properties/${house}/opinions?person_id=${person}&stage=pre_inspection`);
});

test("This week, the map and Settings open", async ({ page }) => {
  await open(page, "/week");
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  await open(page, "/map");
  await expect(page.locator(".map canvas")).toBeVisible({ timeout: 20_000 });
  await open(page, "/settings");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
});
