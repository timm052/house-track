// A shared listing link, in words. realestate.com.au's links name the kind of property and the suburb
// (/property-house-vic-box+hill-145678901 is "House in Box Hill"); others show as the site and path.
const REA_SLUG = /^property-([a-z]+)-[a-z]{2,3}-(.+?)-\d{6,}$/;
const title = (s: string) => s.replace(/[+-]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

export function describeLink(url: string): { main: string; site: string } {
  try {
    const x = new URL(url);
    const site = x.hostname.replace(/^www\./, "");
    const slug = decodeURIComponent(x.pathname.split("/").filter(Boolean).pop() ?? "").toLowerCase();
    const m = site === "realestate.com.au" ? REA_SLUG.exec(slug) : null;
    return m ? { main: `${title(m[1])} in ${title(m[2])}`, site } : { main: site + x.pathname, site: "" };
  } catch {
    return { main: url, site: "" };
  }
}
