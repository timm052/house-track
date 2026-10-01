// The main screens open without errors and their key controls work: Houses, a house page, Rate, Updates, the
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

test("Inspections: the day's list, and a house with a No goes to Passed on and can be added back", async ({ page, request }) => {
  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(10, 0, 0, 0);
  const day = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
  await api(request, "POST", `/api/properties/${house}/inspections`, { starts_at: when.toISOString() });
  const row = page.locator(".tl .ic-address", { hasText: `1 ${street}` });

  await open(page, `/inspections?day=${day}`);
  await expect(page.getByRole("heading", { name: "Inspections", exact: true })).toBeVisible();
  await expect(row).toBeVisible();

  // Someone says No: it moves to Passed on.
  await api(request, "POST", `/api/properties/${house}/opinions`, { person_id: person, stage: "pre_inspection", stance: "no" });
  await page.reload();
  await expect(row).toHaveCount(0);
  const passedList = page.locator(".insp-fold", { hasText: "Passed on" });
  await passedList.getByText("Passed on").click();
  await expect(passedList).toContainText(`1 ${street}`);

  // Added back: it's in the main list again.
  await page.getByRole("button", { name: "Add back" }).click();
  await expect(row).toBeVisible();
  await expect(passedList).toHaveCount(0);

  // Been to one of them: a later inspection of the same house goes to Already inspected, and Add again brings it back.
  const later = new Date(when);
  later.setHours(14, 0, 0, 0);
  const second = (await api(request, "POST", `/api/properties/${house}/inspections`, { starts_at: later.toISOString() })).id;
  const first = (await api(request, "GET", `/api/properties/${house}`)).inspections.find((i: { id: string }) => i.id !== second).id;
  await api(request, "PUT", `/api/inspections/${first}/attendees/${person}`, {});
  await page.reload();
  await expect(row).toHaveCount(1);   // the one attended stays; the repeat is set aside
  await page.locator(".insp-fold", { hasText: "Already inspected" }).getByText("Already inspected").click();
  await page.getByRole("button", { name: "Add again" }).click();
  await expect(row).toHaveCount(2);

  // With two stops on the day, "Plan route" opens the planner on that day; the (unpinned) test house is left out of the route.
  await page.getByRole("link", { name: "Plan route" }).click();
  await expect(page.getByRole("heading", { name: "Plan the route" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`day=${day}`));
  await expect(page.locator(".tl .ic-address", { hasText: `1 ${street}` })).toHaveCount(2);
  await expect(page.getByText("Not on the map").first()).toBeVisible();
  await api(request, "DELETE", `/api/properties/${house}/opinions?person_id=${person}&stage=pre_inspection`);
});

test("Updates, the map and Settings open", async ({ page }) => {
  await open(page, "/updates");
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await open(page, "/map");
  await expect(page.locator(".map canvas")).toBeVisible({ timeout: 20_000 });
  await open(page, "/settings");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
});

test("The Houses card and the house's Inspections tab share the To inspect list, Not going and Already inspected", async ({ page, request }) => {
  await api(request, "DELETE", `/api/properties/${house}/inspect-list`);   // earlier tests may have left it on
  await api(request, "DELETE", `/api/properties/${house}/inspected`);
  for (const i of (await api(request, "GET", `/api/properties/${house}`)).inspections) await api(request, "PATCH", `/api/inspections/${i.id}`, { state: "cancelled" });
  await open(page, "/");
  await page.getByRole("searchbox").fill(street);
  const card = page.locator(".property-card", { hasText: street }).first();
  await card.getByRole("button", { name: /To inspect/ }).click();
  await expect.poll(async () => (await api(request, "GET", `/api/properties/${house}`)).to_inspect).toBe(true);

  const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const id = (await api(request, "POST", `/api/properties/${house}/inspections`, { kind: "open", starts_at: start })).id;
  await open(page, `/p/${house}`);
  await page.getByRole("tab", { name: /Inspections/ }).click();
  await expect(page.locator(".insp-panel .ip-head .pill")).toHaveText("On To inspect");
  await page.getByRole("button", { name: "Not going" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(/Removed by/)).toBeHidden();   // folded away
  await page.locator(".ip-fold summary").click();
  await expect(page.getByText(/Removed by/)).toBeVisible();
  await page.getByRole("button", { name: "Add back" }).click();
  await expect.poll(async () => (await api(request, "GET", `/api/properties/${house}`)).inspections.find((i: { id: string }) => i.id === id).state).toBe("planned");

  await page.getByLabel("We've been to this house").click();
  await expect(page.locator(".insp-panel .ip-head .pill")).toHaveText("Already inspected");
  await api(request, "DELETE", `/api/properties/${house}/inspected`);
  await api(request, "DELETE", `/api/properties/${house}/inspect-list`);
});
